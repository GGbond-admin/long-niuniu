import {
  Fragment,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  api,
  getToken,
  invalidateDeviceSession,
  rm,
  roomWsUrl,
  type RoomChatStage,
  type RoomState,
} from '../api';
import ChatComposer from '../components/ChatComposer';
import {
  MyHistoryIcon,
  RedPacketIcon,
  TransferIcon,
  TransferSwapIcon,
} from '../components/MoneyIcons';
import { goToTab } from '../lib/nav';
import type { Session } from '../sessionStore';
import { disposeChatInputFocus, openExternalLink } from '../telegram';

type ChatReply = {
  messageId: string;
  uid: string;
  nickname: string;
  content: string;
  type: 'TEXT' | 'EMOJI';
};

type SelectedChatReply = {
  messageId: string;
  nickname: string;
  content: string;
};

type ChatMsg = {
  id: string;
  type:
    | 'TEXT'
    | 'EMOJI'
    | 'SYSTEM'
    | 'BANNER'
    | 'DICE'
    | 'STICKER'
    | 'USER_PACKET'
    | 'USER_TIP'
    | 'GAME_PACKET'
    | 'COUNTDOWN';
  content: string;
  from: {
    uid: string;
    nickname: string;
    avatarUrl?: string | null;
    role?: 'GAME_ADMIN';
  } | null;
  requestId?: string;
  gameAction?: 'bid' | 'bet' | 'all_in' | 'withdraw';
  replyTo?: ChatReply;
  at: string;
};

function compareChatMessages(left: ChatMsg, right: ChatMsg): number {
  // Array.sort 稳定：同毫秒消息保留 Redis / WebSocket 的实际到达顺序。
  return left.at.localeCompare(right.at);
}

function mergeContiguousChatWindows(
  current: ChatMsg[],
  recent: ChatMsg[],
): ChatMsg[] | null {
  if (!current.length) return recent;
  if (!recent.length) return current;

  const localStart = current.findIndex((message) => message.id === recent[0]!.id);
  if (localStart < 0) return null;
  const localSuffix = current.slice(localStart);
  const commonLength = Math.min(localSuffix.length, recent.length);
  // 单个稳定 ID 可能是删除后重建，不能单凭一个交点证明两段之间没有缺口。
  if (commonLength < 2) return null;
  for (let index = 0; index < commonLength; index += 1) {
    if (localSuffix[index]!.id !== recent[index]!.id) return null;
  }

  if (localSuffix.length <= recent.length) {
    return [...current.slice(0, localStart), ...recent];
  }

  // 历史快照之后可能先到达实时事件；保留其顺序，同时采用服务端窗口的最新字段。
  const recentById = new Map(recent.map((message) => [message.id, message]));
  return current.map((message) => {
    const authoritative = recentById.get(message.id);
    return authoritative ? { ...message, ...authoritative } : message;
  });
}

type BetAcceptanceNotice = {
  requestedAmountCents: string;
  liabilityBalanceCents: string;
  maxAffordableCents: string;
  roomMaxCents: string;
  maxAcceptedCents: string;
  maxMultiplier: number;
  /** 本笔预留倍数：普通下注=本局最高牌型倍数，梭哈=1 */
  liabilityMultiplier: number;
  reservedCents: string;
  adjusted: boolean;
  adjustedBy: string[];
};

type PrivateBetNoticePayload = {
  status: 'success' | 'failed' | 'unknown';
  action: 'bet' | 'all_in';
  amountCents: string;
  roundId?: string;
  acceptance?: BetAcceptanceNotice;
  reason?: string;
};

type StakeSegment =
  | { kind: 'stake'; isAllIn: boolean; amountCents: string }
  | { kind: 'claim'; amountCents: string }
  | { kind: 'result'; label: '赢' | '输' | '水'; amountCents: string };

type StakeStrip =
  | { variant: 'alert'; notice: PrivateBetNoticePayload }
  | { variant: 'progress'; roundId: string; segments: StakeSegment[] };

/** 梭哈 → 抢 → 赢 逐段出现的间隔，出现后留在同一条上。 */
const STAKE_STEP_MS = 1_000;

function myClaimedAmountCents(state: RoomState | null, uid: string): string | null {
  const mine = state?.me.claimedAmountCents;
  if (mine) return mine;
  const fromRound = state?.round?.claims?.find((claim) => claim.uid === uid)?.amountCents;
  return fromRound || null;
}

type PendingChatAck = {
  requestId: string;
  content: string;
  replyToMessageId?: string;
  resolve: (accepted: boolean) => void;
  timer: number;
};

function createChatRequestId(): string {
  try {
    if (
      typeof crypto !== 'undefined'
      && typeof crypto.randomUUID === 'function'
    ) {
      return crypto.randomUUID().replace(/-/g, '');
    }
  } catch {
    // 旧 WebView 退回时间戳 + 随机串。
  }
  return `c${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

type CountdownPayload = {
  mode?: 'bid' | 'bet' | 'claim' | 'lock' | 'repost';
  endsAt?: string;
  template?: string;
  afterTemplate?: string;
  afterEndsAt?: string;
  emoji?: string;
};

type ChannelNotice = { id: string; title: string; body: string };

type FeedItem =
  | { kind: 'system'; id: string; text: string; time?: string }
  | {
      kind: 'countdown';
      id: string;
      /** lock：普通 3/2/1 文字；其余：与顶栏同步的实时文案 */
      lockText?: string;
      mode?: 'bid' | 'bet' | 'repost' | 'claim';
      endsAt?: string | null;
      afterEndsAt?: string | null;
      template?: string;
      afterTemplate?: string;
      time?: string;
    }
  | {
      kind: 'chat';
      id: string;
      mine: boolean;
      name: string;
      avatar?: string | null;
      text: string;
      emoji?: boolean;
      /** 仅服务端确认执行成功的竞庄/下注指令，用蓝色高亮。 */
      gameAction?: 'bid' | 'bet' | 'all_in' | 'withdraw';
      administrator?: boolean;
      replyTo?: ChatReply;
      time?: string;
    }
  | { kind: 'banner'; id: string; image: string; alt: string }
  | {
      kind: 'dice';
      id: string;
      mine: boolean;
      name: string;
      avatar?: string | null;
      values: number[];
      time?: string;
    }
  | {
      kind: 'sticker';
      id: string;
      mine: boolean;
      name: string;
      avatar?: string | null;
      url: string;
      time?: string;
    }
  | {
      kind: 'userPacket';
      id: string;
      packetId: string;
      greeting: string;
      mine: boolean;
      name: string;
      avatar?: string | null;
      time?: string;
      demo?: boolean;
      administrator?: boolean;
    }
  | {
      kind: 'userTip';
      id: string;
      amountCents: string;
      label: string;
      message: string;
      mine: boolean;
      name: string;
      avatar?: string | null;
      time?: string;
    }
  | {
      kind: 'packet';
      id: string;
      packetId?: string;
      title: string;
      subtitle: string;
      endsAt?: string | null;
      staticSeconds?: number | null;
      claimable?: boolean;
      /** 本人已领取：仍可查看详情，但封面应立即显示为已打开的暗色状态 */
      opened?: boolean;
      /** 红包已结束/过期：点击查看抢包名单而非领取 */
      view?: boolean;
      demo?: boolean;
      waiting?: boolean;
      /** 作为真人聊天气泡展示（微信红包样式） */
      asChat?: boolean;
      name?: string;
      avatar?: string | null;
    };

const BANNER_ALT: Record<string, string> = {
  'bet-start': '开始下注',
  'bet-stop': '停止下注',
  'claim-start': '开始抢包',
  'claim-stop': '停止抢包',
};

const ASSISTANT_AVATAR = '/avatars/assistant.jpg';
const ASSISTANT_NAME = '至尊牛牛小助手';
const GAME_PACKET_GREETING = '恭喜发财，大吉大利';
const RED_PACKET_OPEN_ANIMATION_MS = 900;
const LEADERBOARD_EMBLEM = '/game-ui/leaderboard-emblem-128.png';
const REWARDS_EMBLEM = '/game-ui/rewards-emblem-128.png';
/** 首次进群保持轻量，只由服务端下发最近 100 条。 */
const INITIAL_CHAT_HISTORY_LIMIT = 100;
/** 上翻时按页扩展；限制 DOM 上限，避免大群渲染数千条后卡顿。 */
const CLIENT_CHAT_LIMIT = 500;
const CHAT_HISTORY_TOP_THRESHOLD = 56;
const CHAT_HISTORY_LOAD_TIMEOUT_MS = 8_000;

function waitForRedPacketOpeningAnimation() {
  if (
    typeof window === 'undefined'
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, RED_PACKET_OPEN_ANIMATION_MS);
  });
}

const PACKET_ERROR_TEXT: Record<string, string> = {
  PACKET_EMPTY: '来晚啦，红包已被抢光',
  PACKET_EXPIRED: '红包已过期',
  ALREADY_CLAIMED: '你已领取过该红包',
  PACKET_ESCROW_UNAVAILABLE: '红包资金正在核对，请稍后重试',
  INSUFFICIENT_BALANCE: '余额不足，请先充值',
  KYC_REQUIRED: '请先完成实名认证',
  INVALID_PACKET_AMOUNT: '红包金额超出范围（RM0.10 ~ RM10000）',
  INVALID_PACKET_COUNT: '红包个数需在 1 ~ 50 之间',
  PACKET_TOO_SMALL: '金额太小，每份至少 RM0.01',
  INVALID_TIP_AMOUNT: '打赏金额需在 1 ~ 5000 之间',
};

function packetErrorText(e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  const raw = (e as Error | null)?.message || '';
  return ((code ? PACKET_ERROR_TEXT[code] : undefined) ?? raw) || '操作失败';
}

function parseBetAcceptanceNotice(value: unknown): BetAcceptanceNotice | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  const stringKeys = [
    'requestedAmountCents',
    'liabilityBalanceCents',
    'maxAffordableCents',
    'roomMaxCents',
    'maxAcceptedCents',
    'reservedCents',
  ] as const;
  if (stringKeys.some((key) => typeof row[key] !== 'string')) return undefined;
  if (
    typeof row.maxMultiplier !== 'number' ||
    typeof row.adjusted !== 'boolean' ||
    !Array.isArray(row.adjustedBy)
  ) {
    return undefined;
  }
  return {
    requestedAmountCents: row.requestedAmountCents as string,
    liabilityBalanceCents: row.liabilityBalanceCents as string,
    maxAffordableCents: row.maxAffordableCents as string,
    roomMaxCents: row.roomMaxCents as string,
    maxAcceptedCents: row.maxAcceptedCents as string,
    reservedCents: row.reservedCents as string,
    maxMultiplier: row.maxMultiplier,
    liabilityMultiplier:
      typeof row.liabilityMultiplier === 'number' ? row.liabilityMultiplier : row.maxMultiplier,
    adjusted: row.adjusted,
    adjustedBy: row.adjustedBy.map(String),
  };
}

const FEED_NEAR_BOTTOM_PX = 4;

function isFeedNearBottom(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= FEED_NEAR_BOTTOM_PX;
}

/** 只有旧列表最后仍存在的消息之后出现了新 ID，才算真正新增了底部消息。 */
function hasAppendedFeedItems(previousIds: string[], nextIds: string[]): boolean {
  for (let index = previousIds.length - 1; index >= 0; index -= 1) {
    const survivingIndex = nextIds.lastIndexOf(previousIds[index]!);
    if (survivingIndex >= 0) return survivingIndex < nextIds.length - 1;
  }
  return false;
}

type FeedViewportAnchor = Array<{ id: string; offset: number }>;

function captureFeedViewport(
  el: HTMLElement,
  feedIds: string[],
): FeedViewportAnchor | null {
  const rows = Array.from(el.children) as HTMLElement[];
  if (!feedIds.length || rows.length !== feedIds.length) return null;
  const viewportTop = el.scrollTop;
  const firstVisible = rows.findIndex(
    (row) => row.offsetTop + row.offsetHeight > viewportTop,
  );
  if (firstVisible < 0) return null;
  return rows.slice(firstVisible, firstVisible + 4).map((row, relativeIndex) => ({
    id: feedIds[firstVisible + relativeIndex]!,
    offset: row.offsetTop - viewportTop,
  }));
}

function restoreFeedViewport(
  el: HTMLElement,
  feedIds: string[],
  anchor: FeedViewportAnchor,
  beforeScroll?: () => void,
) {
  const rows = Array.from(el.children) as HTMLElement[];
  if (rows.length !== feedIds.length) return false;
  for (const candidate of anchor) {
    const index = feedIds.indexOf(candidate.id);
    const row = index >= 0 ? rows[index] : undefined;
    if (!row) continue;
    const nextScrollTop = Math.min(
      Math.max(0, row.offsetTop - candidate.offset),
      Math.max(0, el.scrollHeight - el.clientHeight),
    );
    if (Math.abs(el.scrollTop - nextScrollTop) > 0.5) beforeScroll?.();
    el.scrollTop = nextScrollTop;
    return true;
  }
  return false;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectOwnMentionTokens(params: {
  uid?: string;
  nickname?: string | null;
}) {
  const tokens = new Set<string>();
  const nickname = params.nickname?.trim();
  if (nickname) tokens.add(`@${nickname}`);
  if (params.uid) {
    tokens.add(`@UID${params.uid}`);
    tokens.add(`@${params.uid}`);
  }
  return [...tokens].sort((a, b) => b.length - a.length);
}

function AssistantCopy({
  text,
  ownTokens,
}: {
  text: string;
  ownTokens: string[];
}) {
  if (ownTokens.length === 0) return <p>{text}</p>;
  const pattern = new RegExp(`(${ownTokens.map(escapeRegExp).join('|')})`, 'g');
  return (
    <p>
      {text.split('\n').map((line, index, lines) => {
        const ownLine = ownTokens.some((token) => line.includes(token));
        const parts = line.split(pattern);
        return (
          <span key={`${index}-${line.slice(0, 12)}`} className={ownLine ? 'feed-own-line' : undefined}>
            {parts.map((part, partIndex) =>
              ownTokens.includes(part) ? (
                <mark key={`${index}-${partIndex}`} className="feed-own-mention">
                  {part}
                </mark>
              ) : (
                <span key={`${index}-${partIndex}`}>{part}</span>
              ),
            )}
            {index < lines.length - 1 ? '\n' : null}
          </span>
        );
      })}
    </p>
  );
}

function parsePendingBetCommand(value: string): {
  action: 'bet' | 'all_in';
  amountCents: string;
} | null {
  const match = value.trim().match(/^(sh\s*)?(\d+)(?:\.(\d{1,2}))?$/i);
  if (!match) return null;
  const whole = Number(match[2]);
  const fraction = Number((match[3] ?? '').padEnd(2, '0'));
  const cents = whole * 100 + fraction;
  if (!Number.isSafeInteger(cents) || cents <= 0) return null;
  return {
    action: match[1] ? 'all_in' : 'bet',
    amountCents: String(cents),
  };
}

/** 兼容滚动发布期间未回传 requestId 的旧服务端金额回显。 */
function canonicalNumericCommand(value: string): string | null {
  const match = value.trim().match(/^(sh\s*)?([\d,]+)(?:\.(\d{1,2}))?$/i);
  if (!match) return null;
  const digits = match[2].replace(/,/g, '');
  if (!digits || !/^\d+$/.test(digits)) return null;
  const whole = digits.replace(/^0+(?=\d)/, '');
  const fraction = (match[3] ?? '').padEnd(2, '0');
  return `${match[1] ? 'sh:' : ''}${whole}.${fraction}`;
}

function parseUserPacketContent(raw: string): {
  id: string;
  greeting: string;
  administrator: boolean;
} {
  try {
    const parsed = JSON.parse(raw) as {
      id?: string;
      greeting?: string;
      source?: string;
    };
    if (parsed?.id) {
      return {
        id: parsed.id,
        greeting: parsed.greeting || '恭喜发财，大吉大利',
        administrator: parsed.source === 'GAME_ADMIN',
      };
    }
  } catch {
    // 兼容旧格式：content 直接是 packetId
  }
  return {
    id: raw,
    greeting: '恭喜发财，大吉大利',
    administrator: false,
  };
}

function parseUserTipContent(raw: string): {
  amountCents: string;
  label: string;
  message: string;
} {
  try {
    const parsed = JSON.parse(raw) as {
      amountCents?: string | number;
      label?: string;
      message?: string;
    };
    if (parsed?.amountCents != null) {
      return {
        amountCents: String(parsed.amountCents),
        label: parsed.label || '客服小妹',
        message: parsed.message || '谢谢小妹一直在线护航！',
      };
    }
  } catch {
    // ignore
  }
  return {
    amountCents: '0',
    label: '客服小妹',
    message: '谢谢小妹一直在线护航！',
  };
}

function packetClaimsStorageKey(roomId: string) {
  return `niuniu:packet-claims:${roomId}`;
}

function readStoredPacketClaims(roomId: string): Record<string, string> {
  try {
    const raw = sessionStorage.getItem(packetClaimsStorageKey(roomId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoredPacketClaims(roomId: string, claims: Record<string, string>) {
  try {
    sessionStorage.setItem(packetClaimsStorageKey(roomId), JSON.stringify(claims));
  } catch {
    // ignore quota errors
  }
}

function parseGamePacketContent(raw: string): {
  id: string;
  roundId?: string;
  greeting: string;
} {
  try {
    const parsed = JSON.parse(raw) as {
      id?: string;
      roundId?: string;
      greeting?: string;
    };
    if (parsed?.id) {
      return {
        id: parsed.id,
        roundId: parsed.roundId,
        greeting: parsed.greeting || '恭喜发财，大吉大利',
      };
    }
  } catch {
    // 兼容早期直接写入 packetId 的消息。
  }
  return { id: raw, greeting: '恭喜发财，大吉大利' };
}

const DICE_ROLL_ASSETS = [
  '/dice/roll-a.png',
  '/dice/roll-b.png',
  '/dice/roll-c.png',
] as const;
const DICE_RESULT_ASSETS = [
  '/dice/result-1.png',
  '/dice/result-2.png',
  '/dice/result-3.png',
  '/dice/result-4.png',
  '/dice/result-5.png',
  '/dice/result-6.png',
] as const;

/** 使用与结果图同源的逐帧素材，避免旋转中的骰面在停止瞬间变形。 */
function Die({
  value,
  size = 'md',
  spinning = false,
  rollVariant = 0,
}: {
  value: number;
  size?: 'md' | 'lg';
  spinning?: boolean;
  rollVariant?: number;
}) {
  const v = Math.min(6, Math.max(1, Math.trunc(value || 1)));
  const rollAsset = DICE_ROLL_ASSETS[
    Math.abs(Math.trunc(rollVariant)) % DICE_ROLL_ASSETS.length
  ];
  const src = spinning ? rollAsset : DICE_RESULT_ASSETS[v - 1];
  return (
    <span
      className={`die3 die3-${size}${spinning ? ' is-spinning' : ''}`}
      aria-label={spinning ? '骰子转动中' : `骰子 ${v} 点`}
    >
      <img className="die3-art" src={src} alt="" aria-hidden="true" draggable={false} />
    </span>
  );
}

/** 与后端 BANKER_DICE_BETWEEN_MS(1400) 对齐 */
const DIE_SPIN_MS = 840;

/** 三颗同时在原位旋转，随后在同一帧停下并显示各自结果。 */
function SequentialDice({
  values,
  size = 'md',
  animate = true,
  className = '',
  onDone,
}: {
  values: number[];
  size?: 'md' | 'lg';
  animate?: boolean;
  className?: string;
  onDone?: () => void;
}) {
  const finals = values
    .map((v) => Math.min(6, Math.max(1, Math.trunc(v))))
    .filter((v) => v >= 1);
  const reduceMotion = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [spinning, setSpinning] = useState(animate && finals.length > 0 && !reduceMotion);
  const doneRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    doneRef.current = false;
    if (!animate || finals.length === 0 || reduceMotion) {
      setSpinning(false);
      return;
    }
    setSpinning(true);
    const stop = window.setTimeout(() => {
      setSpinning(false);
      if (!doneRef.current) {
        doneRef.current = true;
        onDoneRef.current?.();
      }
    }, DIE_SPIN_MS);
    return () => window.clearTimeout(stop);
  }, [animate, finals.join(','), reduceMotion]);

  return (
    <div className={`seq-dice ${className}`.trim()} aria-label={`骰子 ${finals.join('·')}`}>
      {finals.map((final, idx) => {
        return (
          <span
            className={`seq-dice-slot die-slot-${size}${spinning ? ' spinning' : ' settled'}`}
            key={idx}
          >
            <Die
              value={final}
              size={size}
              spinning={spinning}
              rollVariant={idx}
            />
          </span>
        );
      })}
    </div>
  );
}

const phases: Record<string, string> = {
  WAITING: '等待开局',
  BANKER_BID: '庄家竞标中',
  BETTING: '闲家下注中',
  SENDING_PACKET: '等待系统发包',
  CLAIMING: '红包领取中',
  CLAIM_EXPIRED: '认额核对中',
  SETTLING: '成绩计算中',
  FINISHED: '本局结束',
  CANCELLED: '本局取消',
};

type MutedChatStage = Exclude<RoomChatStage, null>;

const CHAT_STAGE_COPY: Record<
  MutedChatStage,
  { detail: string }
> = {
  DICE: {
    detail: '庄家完成投骰后，系统将自动发送本局红包',
  },
  CLAIMING: {
    detail: '请先完成本局红包领取，抢包结束后继续流程',
  },
  SETTLING: {
    detail: '系统正在核对领取结果并计算本局成绩',
  },
  CONTINUATION: {
    detail: '等待本局庄家确认是否继续坐庄',
  },
  NEXT_ROUND: {
    detail: '系统正在整理牌桌并准备下一局',
  },
  STARTING: {
    detail: '系统正在发布本阶段规则与操作提示',
  },
};

function fallbackChatStage(phase: string | undefined): MutedChatStage | null {
  if (phase === 'SENDING_PACKET') return 'DICE';
  if (phase === 'CLAIMING') return 'CLAIMING';
  if (phase === 'CLAIM_EXPIRED' || phase === 'SETTLING') return 'SETTLING';
  return null;
}

/** 空闲/预览用完整一局演示：系统播报、@庄家、对局红包 vs 玩家拼手气红包 */
const DEMO_FEED: FeedItem[] = [
  {
    kind: 'system',
    id: 'demo-bid',
    text: '📢第 1 局竞标开启\n时长：30 秒\n最低出价：100',
    time: '21:40',
  },
  {
    kind: 'chat',
    id: 'demo-c1',
    mine: false,
    name: '阿强',
    avatar: '/avatars/cute-02.jpg',
    text: '5000',
    time: '21:40',
  },
  {
    kind: 'chat',
    id: 'demo-c2',
    mine: false,
    name: ASSISTANT_NAME,
    avatar: ASSISTANT_AVATAR,
    text: '8800',
    time: '21:41',
  },
  {
    kind: 'banner',
    id: 'demo-banner-bet-start',
    image: '/banners/banner-bet-start.png',
    alt: '开始下注',
  },
  {
    kind: 'system',
    id: 'demo-banker-selected',
    text: '👑庄家锁定\n庄家@小美\n第 1 局庄钱：8800\n庄钱已冻结入池，闲家准备开注。',
    time: '21:41',
  },
  {
    kind: 'system',
    id: 'demo-banker',
    text: '💰第 1 局开注\n庄家@小美\n庄钱：8800\n时长：50 秒\n下注：3 ~ 52.8\n梭哈：30 ~ 440\n发数字下注 · sh+数字梭哈 · 0 撤回',
    time: '21:41',
  },
  {
    kind: 'chat',
    id: 'demo-c3',
    mine: false,
    name: '阿强',
    avatar: '/avatars/cute-02.jpg',
    text: '25',
    time: '21:41',
  },
  {
    kind: 'chat',
    id: 'demo-c3e',
    mine: false,
    name: '阿强',
    avatar: '/avatars/cute-02.jpg',
    text: '🔥',
    emoji: true,
    time: '21:41',
  },
  {
    kind: 'chat',
    id: 'demo-c4',
    mine: false,
    name: '阿杰',
    avatar: '/avatars/alt-02.jpg',
    text: 'sh200',
    time: '21:42',
  },
  {
    kind: 'userPacket',
    id: 'demo-user-packet',
    packetId: 'demo-user-packet',
    greeting: '恭喜发财，大吉大利',
    mine: false,
    name: '阿杰',
    avatar: '/avatars/alt-02.jpg',
    time: '21:42',
    demo: true,
  },
  {
    kind: 'banner',
    id: 'demo-banner-bet-stop',
    image: '/banners/banner-bet-stop.png',
    alt: '停止下注',
  },
  {
    kind: 'system',
    id: 'demo-sealed',
    text: '📋封盘明细\n庄家@小美\n庄钱：8800\n发包金额：3\n发包数量：3 个\n总下注：225\n总梭哈：200\n\n本局下注成功名单：\n@阿强 25\n@阿杰 200梭哈',
    time: '21:42',
  },
  {
    kind: 'system',
    id: 'demo-dice-prompt',
    text: '⏳封盘确认 · 5 秒\n请庄家@小美确认本局。\n· 继续本局：确认结束后须在 15 秒内投骰，超时本局自动取消并退款\n· 重推本局：倒计时内发送 重推',
    time: '21:42',
  },
  {
    kind: 'dice',
    id: 'demo-dice-throw-1',
    mine: false,
    name: '小美',
    avatar: '/avatars/glam-01.jpg',
    values: [2],
    time: '21:42',
  },
  {
    kind: 'dice',
    id: 'demo-dice-throw-2',
    mine: false,
    name: '小美',
    avatar: '/avatars/glam-01.jpg',
    values: [5],
    time: '21:42',
  },
  {
    kind: 'dice',
    id: 'demo-dice-throw-3',
    mine: false,
    name: '小美',
    avatar: '/avatars/glam-01.jpg',
    values: [6],
    time: '21:42',
  },
  {
    kind: 'system',
    id: 'demo-dice-result',
    text: '🎲庄家开骰\n庄家@小美\n骰子：2·5·6',
    time: '21:42',
  },
  {
    kind: 'system',
    id: 'demo-wait',
    text: '⏳等待平台发包\n请耐心等待平台发包，期间请勿退出本页面，\n以免错过抢包。',
    time: '21:42',
  },
  {
    kind: 'packet',
    id: 'demo-packet-live',
    title: '恭喜发财，大吉大利',
    subtitle: '点击领取',
    staticSeconds: 28,
    claimable: true,
    demo: true,
    asChat: true,
    name: '小美',
    avatar: '/avatars/glam-01.jpg',
  },
  {
    kind: 'banner',
    id: 'demo-banner-claim-start',
    image: '/banners/banner-claim-start.png',
    alt: '开始抢包',
  },
  {
    kind: 'system',
    id: 'demo-claim-start',
    text: '🧧开始抢包 · 40 秒\n仅庄家与已下注闲家可领，过期即止。未领玩家请尽快，超时按尾包规则补录。',
    time: '21:43',
  },
  {
    kind: 'banner',
    id: 'demo-banner-claim-stop',
    image: '/banners/banner-claim-stop.png',
    alt: '停止抢包',
  },
  {
    kind: 'system',
    id: 'demo-claim-end',
    text: '⏰抢包结束\n领取通道已关闭。平台正在核对明细并统算，成绩单一会公布。',
    time: '21:43',
  },
  {
    kind: 'system',
    id: 'demo-rake',
    text: '💸抽水通告\n闲家盈利抽 5%，庄家盈利抽 5%。',
    time: '21:43',
  },
  {
    kind: 'system',
    id: 'demo-next',
    text: '📣下一局准备中。上方为演示流程：竞标 → 宣布庄家 → 下注 → 系统发包 → 抢包 → 结算。',
    time: '21:44',
  },
];

/** 倒计时封装在最小子组件内，避免每秒重渲染整页聊天记录。 */
function useRemainingSeconds(target: string | null | undefined): number | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const targetMs = target ? new Date(target).getTime() : Number.NaN;
    const tick = () => setNow(Date.now());
    tick();
    if (!Number.isFinite(targetMs) || targetMs <= Date.now()) return;
    const interval = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= targetMs) window.clearInterval(interval);
    }, 1_000);
    const expiryTimer = window.setTimeout(() => {
      setNow(Date.now());
      window.clearInterval(interval);
    }, Math.max(0, targetMs - Date.now()) + 20);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(expiryTimer);
    };
  }, [target]);
  return remainingSeconds(target, now);
}

/** 只在截止点触发一次整页更新；平时每秒倒计时仍由小组件独立刷新。 */
function useDeadlineReached(target: string | null | undefined): boolean {
  const [reachedTarget, setReachedTarget] = useState<string | null>(null);
  useEffect(() => {
    const targetMs = target ? new Date(target).getTime() : Number.NaN;
    if (!target || !Number.isFinite(targetMs)) {
      setReachedTarget(null);
      return;
    }
    const delay = targetMs - Date.now();
    if (delay <= 0) {
      setReachedTarget(target);
      return;
    }
    setReachedTarget(null);
    const timer = window.setTimeout(() => setReachedTarget(target), delay + 20);
    return () => window.clearTimeout(timer);
  }, [target]);

  if (!target) return false;
  const targetMs = new Date(target).getTime();
  return Number.isFinite(targetMs) && (reachedTarget === target || targetMs <= Date.now());
}

function remainingSeconds(target: string | null | undefined, now: number): number | null {
  if (!target) return null;
  return Math.max(0, Math.ceil((new Date(target).getTime() - now) / 1_000));
}

function parseCountdownPayload(raw: string): CountdownPayload | null {
  try {
    const parsed = JSON.parse(raw) as CountdownPayload;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function fillRemaining(template: string, remaining: number): string {
  return template.replace(/\{\{\s*remaining\s*\}\}/g, String(remaining));
}

function isClaimStartCopy(text: string): boolean {
  return /开始抢包/.test(text) && /\d+\s*秒/.test(text);
}

function claimStartCountdownTemplate(text: string): string {
  return text.replace(/\d+\s*秒/g, '{{remaining}} 秒');
}

/** 只把本局抢包台词接到当前截止时间，避免上一局「开始抢包」跟着新倒计时跳。 */
function isClaimStartForDeadline(messageAt: string, claimEndsAt: string): boolean {
  const at = new Date(messageAt).getTime();
  const ends = new Date(claimEndsAt).getTime();
  if (!Number.isFinite(at) || !Number.isFinite(ends)) return false;
  const lag = ends - at;
  return lag >= -8_000 && lag <= 3 * 60_000;
}

function RemainingValue({ endsAt }: { endsAt: string }) {
  return <>{useRemainingSeconds(endsAt) ?? '—'}</>;
}

function liveAfterCopy(template: string | undefined, remaining: number): string {
  const source =
    template
    || '⏳封盘确认已结束\n请庄家在 {{remaining}} 秒内完成投骰，超时自动取消并退款';
  if (source.includes('{{remaining}}')) return fillRemaining(source, remaining);
  return source.replace(/在\s*\d+\s*秒内/, `在 ${remaining} 秒内`);
}

function RemainingCopy({
  endsAt,
  afterEndsAt,
  mode,
  template,
  afterTemplate,
}: {
  endsAt?: string | null;
  afterEndsAt?: string | null;
  mode?: 'bid' | 'bet' | 'repost' | 'claim';
  template: string;
  afterTemplate?: string;
}) {
  const remaining = useRemainingSeconds(endsAt) ?? 0;
  const afterRemaining = useRemainingSeconds(afterEndsAt);
  if (remaining <= 0 && mode === 'bid') {
    return <>⏰竞标倒数{'\n'}最低加 100，也可以加更多</>;
  }
  if (remaining <= 0 && mode === 'bet') {
    return <>⏰下注时间已到{'\n'}正在封盘…</>;
  }
  if (remaining <= 0 && mode === 'repost') {
    if (typeof afterRemaining === 'number' && afterRemaining > 0) {
      return <>{liveAfterCopy(afterTemplate, afterRemaining)}</>;
    }
    if (afterRemaining === 0) {
      return <>⏳投骰时间已结束{'\n'}本局正在自动取消并退款</>;
    }
    return <>{afterTemplate || '⏳封盘确认已结束\n请庄家完成投骰'}</>;
  }
  return <>{fillRemaining(template, remaining)}</>;
}

function PacketSubtitle({
  subtitle,
  endsAt,
  staticSeconds,
}: {
  subtitle: string;
  endsAt?: string | null;
  staticSeconds?: number | null;
}) {
  const remaining = useRemainingSeconds(endsAt);
  const seconds = remaining ?? staticSeconds;
  return <>{typeof seconds === 'number' ? `${subtitle} · ${seconds}s` : subtitle}</>;
}

function StageLockPanel({
  stage,
  detail,
  children,
}: {
  stage: MutedChatStage;
  detail?: string;
  children?: ReactNode;
}) {
  const copy = CHAT_STAGE_COPY[stage];
  return (
    <section
      className={`room-stage-lock stage-${stage.toLowerCase()}${children ? ' has-action' : ''}`}
    >
      <div className="room-chat-lock-state room-stage-lock-copy" role="status">
        <span>{detail ?? copy.detail}</span>
      </div>
      {children && <div className="room-stage-lock-action">{children}</div>}
    </section>
  );
}

function ContinuationGate({
  deadline,
  mine,
  busy,
  onConfirm,
}: {
  deadline: string;
  mine: boolean;
  busy: boolean;
  onConfirm: () => void;
}) {
  const seconds = useRemainingSeconds(deadline);
  const remaining = Math.max(0, seconds ?? 0);
  return (
    <StageLockPanel
      stage="CONTINUATION"
      detail={mine ? `请确认是否续庄 · ${remaining}s` : `等待庄家确认续庄 · ${remaining}s`}
    >
      {mine && (
        <button
          className="continuation-confirm"
          type="button"
          disabled={busy || remaining <= 0}
          onClick={onConfirm}
        >
          {busy ? '正在确认…' : '确认续庄'}
        </button>
      )}
    </StageLockPanel>
  );
}

function scoreRm(cents: unknown): string {
  try {
    return rm(String(cents ?? 0));
  } catch {
    return '0';
  }
}

function scoreAbsoluteAmount(cents: unknown): string {
  try {
    const n = BigInt(String(cents ?? 0));
    return rm(n < 0n ? -n : n);
  } catch {
    return '0';
  }
}

function scoreOutcome(outcome: unknown): {
  symbol: string;
  label: '赢' | '输' | '水';
} {
  if (outcome === 'PLAYER_WIN') return { symbol: '\u{1F250}\uFE0F', label: '赢' };
  if (outcome === 'BANKER_WIN') return { symbol: '\u{1F21A}\uFE0F', label: '输' };
  return { symbol: '\u{1F4A7}', label: '水' };
}

function scoreNetLabel(netCents: unknown): '赢' | '输' | '水' {
  const net = Number(netCents ?? 0);
  if (net > 0) return '赢';
  if (net < 0) return '输';
  return '水';
}

function optionalCents(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value);
  return text || null;
}

function findMyScoreboardResult(
  board: RoomState['lastScoreboard'],
  uid: string,
): {
  label: '赢' | '输' | '水';
  netCents: number;
  betCents: string | null;
  isAllIn: boolean;
  claimCents: string | null;
} | null {
  if (!board || !uid) return null;
  const players = Array.isArray(board.playerLines) ? board.playerLines : [];
  for (const raw of players) {
    const line = (raw ?? {}) as Record<string, unknown>;
    if (String(line.uid ?? '') !== uid) continue;
    const net = Number(line.netCents ?? 0);
    return {
      label: scoreNetLabel(net),
      netCents: net,
      betCents: optionalCents(line.betCents),
      isAllIn: line.isAllIn === true,
      claimCents: optionalCents(line.claimCents),
    };
  }
  const banker =
    board.bankerSummary && typeof board.bankerSummary === 'object'
      ? (board.bankerSummary as Record<string, unknown>)
      : null;
  if (banker && String(banker.uid ?? '') === uid) {
    const net = Number(banker.netCents ?? 0);
    return {
      label: scoreNetLabel(net),
      netCents: net,
      betCents: null,
      isAllIn: false,
      claimCents: optionalCents(banker.claimCents),
    };
  }
  return null;
}

function scoreCumulativeLine(params: {
  beforeCents: unknown;
  afterCents: unknown;
}): string {
  return `上局 ${scoreRm(params.beforeCents)} · 本局 ${scoreRm(params.afterCents)}`;
}

/** 牌型等级，与后端 HAND_RANK 同口径（顺子高于倒顺，对子高于金牛/牛牛） */
const SCORE_HAND_RANK: Record<string, number> = {
  BAOZI: 8,
  MANNIU: 7,
  SHUNZI: 6,
  FANSHUN: 5,
  DUIZI: 4,
  JINNIU: 3,
  NIUNIU: 2,
  NORMAL: 1,
  MIANSI: 0,
};

/**
 * 与后端 sameTypeStrength 同口径的排序键：
 * 对子比后两位再前位；金牛只比中间位；普通先比点数再比金额；其余比整笔金额。
 */
function scoreHandStrength(line: Record<string, unknown>): [number, number, number] {
  const type = String(line.handType ?? '');
  const claim = Number(line.claimCents ?? 0);
  const rank = SCORE_HAND_RANK[type] ?? 0;
  if (type === 'DUIZI') return [rank, claim % 100, Math.floor(claim / 100) % 10];
  if (type === 'JINNIU') return [rank, Math.floor(claim / 10) % 10, 0];
  if (type === 'NORMAL') return [rank, Number(line.points ?? 0), claim];
  return [rank, claim, 0];
}

function scoreLines(board: RoomState['lastScoreboard']): string[] {
  if (!board) return [];
  if (typeof board.playerLines === 'string') return board.playerLines.split('\n');
  if (!Array.isArray(board.playerLines)) return [];
  return [...board.playerLines]
    .sort((left, right) => {
      const a = scoreHandStrength((left ?? {}) as Record<string, unknown>);
      const b = scoreHandStrength((right ?? {}) as Record<string, unknown>);
      if (a[0] !== b[0]) return b[0] - a[0];
      if (a[1] !== b[1]) return b[1] - a[1];
      return b[2] - a[2];
    })
    .map((raw) => {
    if (typeof raw === 'string') return raw;
    const line = (raw ?? {}) as Record<string, unknown>;
    const name = String(line.nickname || (line.uid ? `UID ${line.uid}` : '玩家'));
    const result = scoreOutcome(line.outcome);
    const shortfall = Number(line.shortfallCents ?? 0);
    const net = Number(line.netCents ?? 0);
    const shortfallText =
      line.outcome === 'PLAYER_WIN' && shortfall > 0 && net === 0
        ? '（喝水 · 庄钱已赔完）'
        : shortfall > 0
          ? `（免赔 ${scoreRm(shortfall)}）`
          : '';
    return (
      `${result.symbol} @${name} ·\n` +
      `抢 ${scoreRm(line.claimCents)} · ${line.isAllIn ? '梭哈' : '下'} ${scoreRm(line.betCents)} · ` +
      `${result.label}→${scoreAbsoluteAmount(line.netCents)}` +
      `${shortfallText}\n` +
      scoreCumulativeLine({
        beforeCents: line.balanceBeforeCents,
        afterCents: line.balanceAfterCents,
      })
    );
  });
}

function scoreBankerPairStats(board: RoomState['lastScoreboard']): {
  counted: number;
  won: number;
  lost: number;
  tied: number;
} {
  const banker = board && typeof board.bankerSummary === 'object' && board.bankerSummary
    ? (board.bankerSummary as Record<string, unknown>)
    : null;
  const raw = banker?.stats && typeof banker.stats === 'object'
    ? (banker.stats as Record<string, unknown>)
    : null;
  if (raw && ('playerWin' in raw || 'playerLose' in raw || 'tie' in raw)) {
    const won = Number(raw.playerLose ?? 0);
    const lost = Number(raw.playerWin ?? 0);
    const tied = Number(raw.tie ?? 0);
    if ([won, lost, tied].every((item) => Number.isFinite(item) && item >= 0)) {
      return { counted: won + lost + tied, won, lost, tied };
    }
  }
  const players = Array.isArray(board?.playerLines) ? board.playerLines : [];
  let won = 0;
  let lost = 0;
  let tied = 0;
  for (const rawPlayer of players) {
    const player = (rawPlayer ?? {}) as Record<string, unknown>;
    if (player.outcome === 'BANKER_WIN') won += 1;
    else if (player.outcome === 'PLAYER_WIN') lost += 1;
    else tied += 1;
  }
  return { counted: players.length, won, lost, tied };
}

function scoreFooter(board: RoomState['lastScoreboard']): string {
  if (!board) return '';
  if (typeof board.bankerSummary === 'string') return board.bankerSummary;
  const banker = board.bankerSummary as Record<string, unknown> | null;
  if (!banker || typeof banker !== 'object') return '';
  const name = String(banker.nickname || (banker.uid ? `UID ${banker.uid}` : '庄家'));
  const label = scoreNetLabel(banker.netCents);
  const net = Number(banker.netCents ?? 0);
  const pairStats = scoreBankerPairStats(board);
  const fees = banker.fees && typeof banker.fees === 'object'
    ? (banker.fees as Record<string, unknown>)
    : null;
  const profitLine = net > 0
    ? `庄盈利+${scoreAbsoluteAmount(net)}`
    : net < 0
      ? `庄亏损-${scoreAbsoluteAmount(net)}`
      : `庄盈亏 ${scoreRm(0)}`;
  return [
    `\u{1F451} 庄家 @${name} ·`,
    `抢 ${scoreRm(banker.claimCents)} · ${label}→${scoreAbsoluteAmount(banker.netCents)}`,
    `输 ${pairStats.lost} 家 · 赢 ${pairStats.won} 家 · 水 ${pairStats.tied} 家`,
    ...(fees
      ? [`上庄费-${scoreRm(fees.seatFeeCents)} · 服务费-${scoreRm(fees.serviceFeeCents)} · 代包费-${scoreRm(fees.packetFeeCents)}`]
      : []),
    profitLine,
    `上庄积分：${scoreRm(banker.balanceBeforeCents)}`,
    `庄总积分：${scoreRm(banker.balanceAfterCents)}`,
  ].join('\n');
}

type MyHistoryData = Awaited<ReturnType<typeof api.roomMyHistory>>;
type MyHistoryItem = MyHistoryData['items'][number];

function signedRm(cents: string): string {
  try {
    const value = BigInt(cents);
    return `${value > 0n ? '+' : ''}${rm(value)}`;
  } catch {
    return '0';
  }
}

function netTone(cents: string): 'win' | 'lose' | 'tie' {
  try {
    const value = BigInt(cents);
    if (value > 0n) return 'win';
    if (value < 0n) return 'lose';
    return 'tie';
  } catch {
    return 'tie';
  }
}

function myHistoryRowDetail(item: MyHistoryItem): string {
  const parts: string[] = [];
  if (item.handLabel) {
    parts.push(
      item.handType === 'NORMAL' && item.points !== null
        ? `${item.points} 点`
        : item.points !== null
          ? `${item.handLabel} ${item.points} 点`
          : item.handLabel,
    );
  }
  if (item.claimCents) parts.push(`抢 ${rm(item.claimCents)}`);
  if (item.role === 'PLAYER') {
    if (item.betCents) parts.push(`${item.isAllIn ? '梭哈' : '下注'} ${rm(item.betCents)}`);
    if (item.multiplier !== null && item.multiplier > 1) parts.push(`${item.multiplier} 倍`);
    if (item.bankerNickname) parts.push(`庄家 ${item.bankerNickname}`);
    if (item.shortfallCents && BigInt(item.shortfallCents) > 0n) {
      parts.push(`庄家赔付不足，免赔 ${rm(item.shortfallCents)}`);
    }
  }
  return parts.join(' · ');
}

/** 我的战绩：仅展示本人参与（下注或坐庄）的已结算局次。 */
function MyHistorySheet({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const [data, setData] = useState<MyHistoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setData(null);
    api
      .roomMyHistory(roomId)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [roomId, retryKey]);

  const summary = data?.summary ?? null;

  return createPortal(
    <div className="channel-sheet" role="dialog" aria-modal="true" aria-label="我的战绩">
      <button
        type="button"
        className="channel-sheet-backdrop"
        aria-label="关闭"
        onClick={onClose}
      />
      <div className="channel-sheet-panel">
        <div className="channel-sheet-handle" aria-hidden />
        <header className="channel-sheet-head">
          <div>
            <small>仅显示我参与的对局</small>
            <strong>我的战绩</strong>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        {summary && (
          <div className="my-history-summary">
            <div className={`my-history-total ${netTone(summary.netCents)}`}>
              <small>累计输赢</small>
              <strong>{signedRm(summary.netCents)}</strong>
            </div>
            <dl>
              <div>
                <dt>局数</dt>
                <dd>{summary.rounds}</dd>
              </div>
              <div>
                <dt>赢</dt>
                <dd>{summary.wins}</dd>
              </div>
              <div>
                <dt>输</dt>
                <dd>{summary.losses}</dd>
              </div>
              <div>
                <dt>水</dt>
                <dd>{summary.ties}</dd>
              </div>
              <div>
                <dt>坐庄</dt>
                <dd>{summary.bankerRounds}</dd>
              </div>
            </dl>
          </div>
        )}
        <div className="channel-sheet-list my-history-list">
          {loading && <p className="my-history-empty">正在加载战绩…</p>}
          {!loading && failed && (
            <div className="my-history-empty">
              <p>战绩加载失败，请稍后重试</p>
              <button type="button" onClick={() => setRetryKey((key) => key + 1)}>
                重新加载
              </button>
            </div>
          )}
          {!loading && !failed && data && data.items.length === 0 && (
            <p className="my-history-empty">还没有战绩。下注或坐庄完成一局后，这里会记录每局成绩。</p>
          )}
          {!loading
            && !failed
            && data?.items.map((item) => {
              const detail = myHistoryRowDetail(item);
              return (
                <article className="my-history-row" key={item.roundId}>
                  <div className="my-history-row-head">
                    <strong>第 {item.seqNo} 局</strong>
                    <span className={`my-history-role${item.role === 'BANKER' ? ' banker' : ''}`}>
                      {item.role === 'BANKER' ? '庄' : '闲'}
                    </span>
                    <time>{formatDateTime(item.finishedAt)}</time>
                    <span className={`my-history-net ${netTone(item.netCents)}`}>
                      {signedRm(item.netCents)}
                    </span>
                  </div>
                  {detail && <p>{detail}</p>}
                </article>
              );
            })}
          {!loading && !failed && data && data.items.length >= data.maxRounds && (
            <p className="my-history-cap">仅显示最近 {data.maxRounds} 局</p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

type TipDanmakuPayload = {
  nickname: string;
  amountCents: string;
  message?: string;
  avatarUrl?: string | null;
};

type PlayLocationState = {
  sentPacket?: { packetId: string; greeting: string };
  tipNotice?: TipDanmakuPayload;
};

type GroupPacketDetail = Awaited<ReturnType<typeof api.groupPacket>>;
type GamePacketDetail = Awaited<ReturnType<typeof api.gamePacket>>;

type PacketDialogStatus =
  | 'loading'
  | 'claimable'
  | 'opening'
  | 'claimed'
  | 'gone'
  | 'waiting'
  | 'ineligible'
  | 'external'
  | 'error';

type PacketDialogState = {
  packetId: string;
  kind: 'game' | 'group';
  channel?: 'TNG' | 'INTERNAL';
  greeting: string;
  sender: { name: string; avatar?: string | null };
  status: PacketDialogStatus;
  amountCents?: string;
  externalUrl?: string;
  error?: string;
};

export default function GameRoom({
  session,
  freezeFeed = false,
}: {
  session: Session;
  freezeFeed?: boolean;
}) {
  const { roomId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const roomRootRef = useRef<HTMLDivElement>(null);
  /** 演示流仅供内部预览；地址加 ?demo=1 显式开启 */
  const showDemoFeed = searchParams.get('demo') === '1';
  const [state, setState] = useState<RoomState | null>(null);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [myUid, setMyUid] = useState('');
  const [myProfile, setMyProfile] = useState<{
    nickname: string;
    avatarUrl?: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const [entryRetryKey, setEntryRetryKey] = useState(0);
  /** 实时连接状态：断线后自动重连，并在顶栏明确提示；kicked = 被移出房间等终态，不再重连 */
  const [connState, setConnState] = useState<
    'connecting' | 'online' | 'reconnecting' | 'kicked'
  >('connecting');
  const reconnectNowRef = useRef<() => void>(() => {});
  const [stickers, setStickers] = useState<Array<{ id: string; name: string; url: string }>>([]);
  const [diceSent, setDiceSent] = useState(false);
  const [betPending, setBetPending] = useState(false);
  const [chatSendPending, setChatSendPending] = useState(false);
  const [replyTarget, setReplyTarget] = useState<SelectedChatReply | null>(null);
  const [composerInputRequest, setComposerInputRequest] = useState<{
    id: number;
    insertText?: string;
  } | null>(null);
  const [betNotice, setBetNotice] = useState<
    (PrivateBetNoticePayload & { id: number }) | null
  >(null);
  const [stakeVisibleCount, setStakeVisibleCount] = useState(0);
  const stakeProgressRoundRef = useRef<string | null>(null);
  /** 新到达的骰子消息在聊天里播放转动 */
  const [animatedDiceIds, setAnimatedDiceIds] = useState<Record<string, boolean>>({});
  /** packetId -> 已领金额（分）；'GONE' 表示已抢光/过期 */
  const [packetClaims, setPacketClaims] = useState<Record<string, string>>(() =>
    roomId ? readStoredPacketClaims(roomId) : {},
  );
  const packetClaimsRef = useRef<Record<string, string>>(packetClaims);
  const packetDetailCacheRef = useRef<Record<string, GroupPacketDetail>>({});

  useLayoutEffect(() => {
    const root = roomRootRef.current;
    if (!root) return;
    if (freezeFeed) root.setAttribute('inert', '');
    else root.removeAttribute('inert');
    return () => root.removeAttribute('inert');
  }, [freezeFeed]);

  function updatePacketClaims(
    updater: (prev: Record<string, string>) => Record<string, string>,
  ) {
    setPacketClaims((prev) => {
      const next = updater(prev);
      packetClaimsRef.current = next;
      if (roomId) writeStoredPacketClaims(roomId, next);
      return next;
    });
  }

  function applyClaimStatusItems(
    items: Array<{ id: string; mineCents: string | null; gone: boolean }>,
  ) {
    if (!items.length) return;
    updatePacketClaims((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const item of items) {
        if (item.mineCents) {
          if (next[item.id] !== item.mineCents) {
            next[item.id] = item.mineCents;
            changed = true;
          }
        } else if (item.gone && !next[item.id]) {
          next[item.id] = 'GONE';
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }
  const [packetDialog, setPacketDialog] = useState<PacketDialogState | null>(null);
  const [rpBusy, setRpBusy] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const didReceiveHistoryRef = useRef(false);
  const chatRef = useRef<ChatMsg[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyLoadingRef = useRef(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const historyHasMoreRef = useRef(false);
  const [historyLoadFailed, setHistoryLoadFailed] = useState(false);
  const [historyControlVisible, setHistoryControlVisible] = useState(false);
  const historyControlVisibleRef = useRef(false);
  const historyRequestIdRef = useRef<string | null>(null);
  const historyRequestTombstoneGenerationRef = useRef(0);
  const historyLoadTimerRef = useRef<number | null>(null);
  const chatDeleteTombstonesRef = useRef(new Map<string, number>());
  const chatDeleteGenerationRef = useRef(0);
  const betPendingRef = useRef(false);
  const betPendingTimerRef = useRef<number | null>(null);
  const betPendingRequestIdRef = useRef<string | null>(null);
  const pendingChatAckRef = useRef<PendingChatAck | null>(null);
  const composerInputRequestIdRef = useRef(0);
  const betNoticeTimerRef = useRef<number | null>(null);
  const privateBetNoticeIdRef = useRef(0);
  const hadLiveBetRef = useRef(false);
  const tipDanmakuIdRef = useRef(0);
  const [tipDanmakuQueue, setTipDanmakuQueue] = useState<Array<TipDanmakuPayload & {
    id: number;
  }>>([]);
  const tipNotice = tipDanmakuQueue[0] ?? null;
  const enqueueTipDanmaku = useCallback((notice: TipDanmakuPayload) => {
    tipDanmakuIdRef.current += 1;
    const next = { ...notice, id: tipDanmakuIdRef.current };
    setTipDanmakuQueue((current) => {
      if (current.length < 5) return [...current, next];
      // 保留正在播放的首条，拥挤时只淘汰最早等待的弹幕。
      return [current[0]!, ...current.slice(-3), next];
    });
  }, []);
  /** 靠近底部时跟随新消息；进房强制贴底一次 */
  const stickToBottomRef = useRef(true);
  const didInitialScrollRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  const feedIdsRef = useRef<string[]>([]);
  const feedViewportAnchorRef = useRef<FeedViewportAnchor | null>(null);
  const programmaticFeedScrollRef = useRef(false);
  const roomFeatureScrollTopRef = useRef<number | null>(null);
  const [channelOpen, setChannelOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [quickActionsOpen, setQuickActionsOpen] = useState(false);
  /** 任务入口闲置自动收进右边缘，点一下把手先滑出、再点才展开 */
  const [quickActionsDocked, setQuickActionsDocked] = useState(false);

  useEffect(() => {
    if (quickActionsOpen) {
      setQuickActionsDocked(false);
      return;
    }
    if (quickActionsDocked) return;
    const timer = window.setTimeout(() => setQuickActionsDocked(true), 8_000);
    return () => window.clearTimeout(timer);
  }, [quickActionsOpen, quickActionsDocked]);

  useEffect(() => {
    const hasBet = !!state?.me.bet;
    if (hadLiveBetRef.current && !hasBet && state?.round?.phase === 'BETTING') {
      setBetNotice((current) => (current?.status === 'success' ? null : current));
    }
    hadLiveBetRef.current = hasBet;
  }, [state?.me.bet, state?.round?.phase]);
  /** 上翻看历史期间有新消息：不强拉回底部，浮出「有新消息」按钮 */
  const [newBelow, setNewBelow] = useState(false);
  const newBelowRef = useRef(false);

  useLayoutEffect(() => {
    chatRef.current = chat;
  }, [chat]);

  useEffect(() => {
    setReplyTarget(null);
  }, [roomId]);

  function markNewBelow(value: boolean) {
    if (newBelowRef.current === value) return;
    newBelowRef.current = value;
    setNewBelow(value);
  }

  function markHistoryLoading(value: boolean) {
    historyLoadingRef.current = value;
    setHistoryLoading(value);
  }

  function markHistoryHasMore(value: boolean) {
    historyHasMoreRef.current = value;
    setHistoryHasMore(value);
  }

  function filterHistoryMessages(
    messages: ChatMsg[],
    authoritativeThroughGeneration?: number,
  ): ChatMsg[] {
    const tombstones = chatDeleteTombstonesRef.current;
    return messages.filter((message) => {
      const deletedGeneration = tombstones.get(message.id);
      if (deletedGeneration === undefined) return true;
      if (
        authoritativeThroughGeneration !== undefined
        && deletedGeneration <= authoritativeThroughGeneration
      ) {
        // 该删除早于本次分页请求；Redis 快照仍返回此 ID，说明它已合法重建。
        tombstones.delete(message.id);
        return true;
      }
      return false;
    });
  }

  const markHistoryControlVisible = useCallback((value: boolean) => {
    if (historyControlVisibleRef.current === value) return;
    historyControlVisibleRef.current = value;
    setHistoryControlVisible(value);
  }, []);

  const requestOlderHistory = useCallback(() => {
    const socket = socketRef.current;
    const oldest = chatRef.current[0] ?? {
      id: '~',
      at: new Date().toISOString(),
    };
    if (
      !didReceiveHistoryRef.current
      || !historyHasMoreRef.current
      || historyLoadingRef.current
      || !socket
      || socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    if (chatRef.current.length >= CLIENT_CHAT_LIMIT) {
      historyHasMoreRef.current = false;
      setHistoryHasMore(false);
      return;
    }

    const requestId = createChatRequestId();
    setHistoryLoadFailed(false);
    historyRequestIdRef.current = requestId;
    historyRequestTombstoneGenerationRef.current =
      chatDeleteGenerationRef.current;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    if (historyLoadTimerRef.current !== null) {
      window.clearTimeout(historyLoadTimerRef.current);
    }
    historyLoadTimerRef.current = window.setTimeout(() => {
      if (historyRequestIdRef.current !== requestId) return;
      historyRequestIdRef.current = null;
      historyRequestTombstoneGenerationRef.current = 0;
      historyLoadTimerRef.current = null;
      historyLoadingRef.current = false;
      setHistoryLoading(false);
      setHistoryLoadFailed(true);
    }, CHAT_HISTORY_LOAD_TIMEOUT_MS);

    try {
      socket.send(
        JSON.stringify({
          type: 'chat_history_before',
          beforeId: oldest.id,
          beforeAt: oldest.at,
          requestId,
        }),
      );
    } catch {
      if (historyLoadTimerRef.current !== null) {
        window.clearTimeout(historyLoadTimerRef.current);
        historyLoadTimerRef.current = null;
      }
      historyRequestIdRef.current = null;
      historyRequestTombstoneGenerationRef.current = 0;
      historyLoadingRef.current = false;
      setHistoryLoading(false);
      setHistoryLoadFailed(true);
    }
  }, []);

  function clearPendingBet() {
    betPendingRef.current = false;
    betPendingRequestIdRef.current = null;
    setBetPending(false);
    if (betPendingTimerRef.current !== null) {
      window.clearTimeout(betPendingTimerRef.current);
      betPendingTimerRef.current = null;
    }
  }

  function settlePendingChat(accepted: boolean) {
    const pending = pendingChatAckRef.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingChatAckRef.current = null;
    setChatSendPending(false);
    if (accepted && pending.replyToMessageId) {
      setReplyTarget((current) =>
        current?.messageId === pending.replyToMessageId ? null : current,
      );
    }
    pending.resolve(accepted);
  }

  function pushPrivateBetNotice(notice: PrivateBetNoticePayload) {
    privateBetNoticeIdRef.current += 1;
    const id = privateBetNoticeIdRef.current;
    if (betNoticeTimerRef.current !== null) {
      window.clearTimeout(betNoticeTimerRef.current);
      betNoticeTimerRef.current = null;
    }
    setBetNotice({ ...notice, id, roundId: notice.roundId ?? state?.round?.id });
    // 成功后金额一直留在输入框上方，直到出成绩；失败/超时仍自动收起。
    if (notice.status === 'success') return;
    const dismissMs = notice.status === 'failed' ? 3_200 : 4_000;
    betNoticeTimerRef.current = window.setTimeout(() => {
      setBetNotice((current) => (current?.id === id ? null : current));
      betNoticeTimerRef.current = null;
    }, dismissMs);
  }

  function dismissPrivateBetNotice() {
    if (betNoticeTimerRef.current !== null) {
      window.clearTimeout(betNoticeTimerRef.current);
      betNoticeTimerRef.current = null;
    }
    setBetNotice(null);
  }

  // 倒计时必须跟当前阶段绑定，避免沿用上阶段时间戳造成「还有 N 秒」的假象
  const phase = state?.round?.phase;
  const phaseDeadline = (() => {
    const round = state?.round;
    if (!round) return null;
    if (round.phase === 'BANKER_BID') return round.bidEndsAt ?? null;
    if (round.phase === 'BETTING') return round.betEndsAt ?? null;
    if (round.phase === 'CLAIMING') return round.claimEndsAt ?? null;
    return null;
  })();
  const repostDeadline =
    phase === 'SENDING_PACKET' ? state?.round?.repostEndsAt ?? null : null;
  const diceDeadline =
    phase === 'SENDING_PACKET' ? state?.round?.diceEndsAt ?? null : null;
  const continuation = state?.continuation ?? null;
  const nextRoundAt = state?.nextRoundAt ?? null;
  const phaseDeadlineReached = useDeadlineReached(phaseDeadline);
  const repostDeadlineReached = useDeadlineReached(repostDeadline);
  const diceDeadlineReached = useDeadlineReached(diceDeadline);
  const continuationDeadlineReached = useDeadlineReached(continuation?.deadline ?? null);
  const nextRoundDeadlineReached = useDeadlineReached(nextRoundAt);
  const memberMuteDeadlineReached = useDeadlineReached(
    state?.me.chatMute?.mutedUntil ?? null,
  );
  const activeRoundId = state?.round?.id;
  const bidWindowClosed =
    phase === 'BANKER_BID'
    && !!activeRoundId
    && chat.some(
      (message) => message.id === `round:${activeRoundId}:bid:final-list`,
    );
  const bidFinalCountdownRunning =
    phase === 'BANKER_BID' && phaseDeadlineReached && !bidWindowClosed;
  const bidLockDigit = (() => {
    if (!bidFinalCountdownRunning || !activeRoundId) return null;
    const prefix = `round:${activeRoundId}:bid:countdown:`;
    for (let index = chat.length - 1; index >= 0; index -= 1) {
      const message = chat[index];
      if (!message?.id.startsWith(prefix) || message.type !== 'COUNTDOWN') continue;
      if (message.id.endsWith(':1')) return '1';
      if (message.id.endsWith(':2')) return '2';
      if (message.id.endsWith(':3')) return '3';
      const payload = parseCountdownPayload(message.content);
      if (payload?.mode === 'lock') return payload.emoji || '3';
    }
    return '3';
  })();
  const repostWindowOpen =
    phase === 'SENDING_PACKET'
    && state?.round?.canRepostRound === true
    && !repostDeadlineReached;
  const continuationActive =
    !!continuation
    && !continuationDeadlineReached;
  const nextRoundWaiting =
    !!nextRoundAt
    && !nextRoundDeadlineReached
    && !continuationActive;
  const fallbackMutedChatStage = fallbackChatStage(phase);
  const roomGloballyMuted = state?.room.chatMute?.muted === true;
  const policyChatMuted =
    state?.chatPolicy?.muted
    ?? fallbackMutedChatStage !== null;
  const chatMuted = continuationActive || policyChatMuted;
  const mutedChatStage: MutedChatStage | null =
    continuationActive
      ? 'CONTINUATION'
      : state?.chatPolicy?.stage ?? fallbackMutedChatStage;
  const gameStopped = state?.room.roundStartMode === 'STOPPED';
  const idlePhase = !phase || ['WAITING', 'FINISHED', 'CANCELLED'].includes(phase);
  const selfUid = myUid || session.uid;
  const myScore = findMyScoreboardResult(state?.lastScoreboard ?? null, selfUid);
  const availableStakeStrip = ((): StakeStrip | null => {
    if (betNotice && betNotice.status !== 'success') {
      return { variant: 'alert', notice: betNotice };
    }
    const liveBet = state?.me.bet;
    const boardSeq = state?.lastScoreboard?.seqNo;
    const currentSeq = state?.round?.seqNo;
    const betweenRounds = idlePhase || continuationActive;
    const thisRoundSettled =
      !!myScore && boardSeq != null && currentSeq != null && boardSeq === currentSeq;
    const showResult = !!(myScore && (betweenRounds || thisRoundSettled));
    const stake =
      liveBet
        ? { isAllIn: liveBet.isAllIn, amountCents: liveBet.amountCents }
        : betNotice?.status === 'success' && betNotice.roundId === state?.round?.id
          ? {
              isAllIn: betNotice.action === 'all_in',
              amountCents: betNotice.amountCents,
            }
          : showResult && myScore?.betCents
            ? { isAllIn: myScore.isAllIn, amountCents: myScore.betCents }
            : null;
    const claimedAmountCents =
      myClaimedAmountCents(state, selfUid)
      ?? (showResult ? myScore?.claimCents ?? null : null);
    const segments: StakeSegment[] = [];
    if (stake) {
      segments.push({ kind: 'stake', ...stake });
    }
    if (claimedAmountCents) {
      segments.push({ kind: 'claim', amountCents: claimedAmountCents });
    }
    if (showResult && myScore) {
      segments.push({
        kind: 'result',
        label: myScore.label,
        amountCents: String(Math.abs(myScore.netCents)),
      });
    }
    if (segments.length === 0) return null;
    // 续庄时 currentSeq 已是下一局，必须继续用本局成绩的局号，否则会整条重挂、从头播一遍。
    const roundId = String(
      (showResult ? boardSeq ?? currentSeq : currentSeq ?? boardSeq)
        ?? state?.round?.id
        ?? 'live',
    );
    return { variant: 'progress', roundId, segments };
  })();
  const progressRoundId =
    availableStakeStrip?.variant === 'progress' ? availableStakeStrip.roundId : '';
  const progressLength =
    availableStakeStrip?.variant === 'progress' ? availableStakeStrip.segments.length : 0;
  useEffect(() => {
    if (availableStakeStrip?.variant === 'alert') return;
    if (!progressRoundId) {
      stakeProgressRoundRef.current = null;
      setStakeVisibleCount(0);
      return;
    }
    if (progressLength === 0) return;
    if (stakeProgressRoundRef.current !== progressRoundId) {
      stakeProgressRoundRef.current = progressRoundId;
      setStakeVisibleCount(1);
      return;
    }
    if (stakeVisibleCount >= progressLength) return;
    if (stakeVisibleCount === 0) {
      setStakeVisibleCount(1);
      return;
    }
    const timer = window.setTimeout(() => {
      setStakeVisibleCount((count) => Math.min(progressLength, count + 1));
    }, STAKE_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [
    availableStakeStrip?.variant,
    progressRoundId,
    progressLength,
    stakeVisibleCount,
  ]);
  const stakeStrip = availableStakeStrip;
  const packetDiceDone =
    phase === 'SENDING_PACKET'
    && (
      !!state?.round?.diceThrown
      || state?.round?.diceStarted === true
      || diceSent
    );
  const repostConfirmationFinished =
    phase === 'SENDING_PACKET'
    && (repostDeadline ? repostDeadlineReached : !state?.round?.canRepostRound);
  const diceWindowOpen =
    phase === 'SENDING_PACKET'
    && !packetDiceDone
    && repostConfirmationFinished
    && (!diceDeadline || !diceDeadlineReached);
  const diceWindowTimedOut =
    phase === 'SENDING_PACKET'
    && !packetDiceDone
    && !!diceDeadline
    && diceDeadlineReached;
  const deadline =
    repostWindowOpen
      ? repostDeadline
      : diceWindowOpen && diceDeadline
        ? diceDeadline
        : continuationActive
          ? continuation?.deadline ?? null
          : nextRoundWaiting
            ? nextRoundAt
            : phaseDeadline;
  const phaseLabel =
    continuationActive
      ? '续庄询问'
      : nextRoundWaiting
        ? '准备下一局'
      : gameStopped && idlePhase && !chatMuted
        ? '游戏已结束'
      : chatMuted && mutedChatStage === 'NEXT_ROUND'
        ? '准备下一局'
        : chatMuted && mutedChatStage === 'STARTING'
          ? '阶段开始播报'
    : bidWindowClosed
      ? '竞标最终确认'
      : bidFinalCountdownRunning
        ? '竞标最后倒数'
      : repostWindowOpen
        ? '封盘重推确认'
      : diceWindowTimedOut
        ? '投骰超时，正在取消'
      : phase === 'SENDING_PACKET'
        ? packetDiceDone
          ? '等待系统发包'
          : state?.me.isBanker
            ? '请完成庄家投骰'
            : '等待庄家投骰'
        : phases[phase ?? 'WAITING'] ?? '等待开局';
  const phaseAside =
    continuationActive && continuation?.deadline
      ? {
          value: <RemainingValue endsAt={continuation.deadline} />,
          label: '续庄',
        }
      : nextRoundWaiting && nextRoundAt
        ? {
            value: <RemainingValue endsAt={nextRoundAt} />,
            label: '开局',
          }
      : bidWindowClosed
      ? { value: '确认', label: '锁庄' }
      : bidFinalCountdownRunning
        ? { value: bidLockDigit ?? '3', label: '仍可竞价' }
      : repostWindowOpen && repostDeadline
        ? {
            value: <RemainingValue endsAt={repostDeadline} />,
            label: '重推',
          }
        : diceWindowOpen && diceDeadline
          ? {
              value: <RemainingValue endsAt={diceDeadline} />,
              label: '投骰',
            }
          : phase !== 'SENDING_PACKET' && deadline
            ? {
                value: <RemainingValue endsAt={deadline} />,
                label: '秒',
              }
            : diceWindowTimedOut
              ? { value: '超时', label: '取消中' }
              : phase === 'SENDING_PACKET'
                ? packetDiceDone
                  ? { value: '准备', label: '发包' }
                  : { value: '待投', label: '骰子' }
                : { value: '—', label: '倒计时' };

  const phaseHint = useMemo(() => {
    if (continuationActive) {
      return continuation?.mine
        ? '请在倒计时内确认是否续庄 · 期间所有人暂不可发言'
        : '等待庄家确认是否续庄 · 期间所有人暂不可发言';
    }
    if (nextRoundWaiting) {
      return '成绩单已公布，倒计时结束后开启下一局 · 暂不可发言';
    }
    if (chatMuted && mutedChatStage === 'STARTING') {
      return '阶段开始播报中 · 暂不可发言，播报完成后自动恢复';
    }
    if (chatMuted && mutedChatStage === 'NEXT_ROUND') {
      return '系统正在准备下一局 · 暂不可发言';
    }
    if (gameStopped && idlePhase) {
      return '本场已结束，等待运营重新开局';
    }
    if (chatMuted && mutedChatStage === 'SETTLING') {
      return phase === 'CLAIM_EXPIRED'
        ? '抢包已结束，正在核对领取金额 · 暂不可发言'
        : '核对完成，正在计算本局成绩 · 暂不可发言';
    }
    if (phase === 'BANKER_BID') {
      if (bidWindowClosed) return '3、2、1 已结束，正在锁定庄家';
      if (bidFinalCountdownRunning) return '3、2、1 播报期间仍可竞标 · 最低加 100';
      return '首次报整数 · 后续最低加 100，可加更多';
    }
    if (phase === 'BETTING' && state?.round?.betRange) {
      const r = state.round.betRange;
      return `下注 ${rm(r.betMinCents)}~${rm(r.betMaxCents)} · 梭哈 ${rm(r.shMinCents)}~${rm(r.shMaxCents)}`;
    }
    if (phase === 'SENDING_PACKET') {
      if (repostWindowOpen) {
        return state?.me.isBanker
          ? '如需取消并退款，请在倒计时内发送「重推」'
          : '封盘确认中；庄家可发送「重推」取消本局并退款重开';
      }
      if (packetDiceDone) return '庄家投骰已完成，正在等待系统发包';
      if (diceWindowTimedOut) return '庄家未在时限内投骰，系统正在取消本局并原路退款';
      return state?.me.isBanker
        ? '请在倒计时内完成庄家投骰；超时本局自动取消并退款'
        : '等待庄家投骰；超时本局自动取消并退款';
    }
    if (phase === 'CLAIMING') {
      const isParticipant =
        !!state?.me.isBanker || !!state?.me.bet || !!state?.me.canClaim;
      return isParticipant
        ? '仅庄家与已下注闲家可领 · 抢包期间禁止发言'
        : '未参与本局，请等待下一局 · 暂不可发言';
    }
    if (phase === 'CLAIM_EXPIRED') return '抢包已结束，正在核对领取金额 · 暂不可发言';
    if (phase === 'SETTLING') return '核对完成，正在计算本局成绩 · 暂不可发言';
    if (phase === 'WAITING' || !phase) return '凑齐人数后自动开局';
    return '系统自动结算';
  }, [
    phase,
    state,
    packetDiceDone,
    bidWindowClosed,
    bidFinalCountdownRunning,
    repostWindowOpen,
    diceWindowTimedOut,
    continuationActive,
    continuation,
    nextRoundWaiting,
    chatMuted,
    mutedChatStage,
  ]);

  const liveBusy =
    !!state?.round &&
    !['WAITING', 'FINISHED', 'CANCELLED'].includes(state.round.phase) &&
    (chat.length > 0 ||
      !!state.round.banker ||
      (state.round.bets?.length ?? 0) > 0 ||
      !!state.round.packetId ||
      !!state.lastScoreboard);

  /** 通道通告：固定在窗口顶部，不进入可滚动聊天流 */
  const channelNotices = useMemo<ChannelNotice[]>(() => {
    const pins = state?.pins ?? [];
    if (pins.length) {
      return pins.map((pin) => ({
        id: pin.id,
        title: pin.title || '置顶小通告',
        body: pin.body,
      }));
    }
    return [
      {
        id: 'pin-tip',
        title: '至尊牛牛小通告',
        body: showDemoFeed
          ? '演示流程预览中（仅内部预览模式可见）：竞标 → 宣布庄家 → 下注 → 抢包 → 结算。'
          : liveBusy
            ? '请根据当前阶段完成竞标 / 下注 / 抢包。抢红包阶段请专注领取，勿退出页面。'
            : '至尊牛牛火热开局中，凑齐人数后自动开局。点击查看群内通告。',
      },
    ];
  }, [state?.pins, showDemoFeed, liveBusy]);

  const channelPreview = channelNotices[0];

  const feed = useMemo(() => {
    const items: FeedItem[] = [];
    let hasCurrentGamePacket = false;
    const seenGamePacketIds = new Set<string>();

    if (showDemoFeed) {
      items.push({
        kind: 'system',
        id: 'demo-sep-start',
        text: '—— 演示流程（预览）——',
      });
      items.push(...DEMO_FEED);
      if (liveBusy || chat.length > 0) {
        items.push({
          kind: 'system',
          id: 'demo-sep-live',
          text: '—— 当前房间消息 ——',
        });
      }
    }

    for (const msg of chat) {
      if (msg.type === 'SYSTEM') {
        const text = stripAssistHtml(msg.content);
        const claimEndsAt = state?.round?.claimEndsAt;
        if (
          claimEndsAt
          && isClaimStartCopy(text)
          && isClaimStartForDeadline(msg.at, claimEndsAt)
        ) {
          items.push({
            kind: 'countdown',
            id: msg.id,
            mode: 'claim',
            endsAt: claimEndsAt,
            template: claimStartCountdownTemplate(text),
            time: formatTime(msg.at),
          });
        } else {
          items.push({
            kind: 'system',
            id: msg.id,
            text,
            time: formatTime(msg.at),
          });
        }
      } else if (msg.type === 'COUNTDOWN') {
        const payload = parseCountdownPayload(msg.content);
        // 抢包倒计时气泡已停发；历史局里的同款消息也不再展示
        if (payload?.mode === 'claim') continue;
        if (payload?.mode === 'lock') {
          items.push({
            kind: 'countdown',
            id: msg.id,
            lockText: payload.emoji || '3',
            time: formatTime(msg.at),
          });
        } else {
          const endsAt = payload?.endsAt ?? deadline;
          const template =
            payload?.template ||
            (payload?.mode === 'bid'
              ? '⏰竞标倒计时 · 还剩 {{remaining}} 秒\n直接发送整数金额出价，时间到进入最终确认！'
              : payload?.mode === 'repost'
                ? '⏳封盘确认 · {{remaining}} 秒'
              : '⏰下注倒计时 · 还剩 {{remaining}} 秒\n未出手的抓紧了，时间到立刻封盘！');
          items.push({
            kind: 'countdown',
            id: msg.id,
            mode:
              payload?.mode === 'bid'
              || payload?.mode === 'bet'
              || payload?.mode === 'repost'
                ? payload.mode
                : undefined,
            endsAt,
            template: stripAssistHtml(template),
            afterTemplate: payload?.afterTemplate
              ? stripAssistHtml(payload.afterTemplate)
              : undefined,
            afterEndsAt:
              payload?.afterEndsAt
              ?? (
                payload?.mode === 'repost' && !packetDiceDone
                  ? state?.round?.diceEndsAt
                  : undefined
              ),
            time: formatTime(msg.at),
          });
        }
      } else if (msg.type === 'BANNER') {
        items.push({
          kind: 'banner',
          id: msg.id,
          image: `/banners/banner-${msg.content}.png`,
          alt: BANNER_ALT[msg.content] ?? msg.content,
        });
      } else if (msg.type === 'DICE') {
        const values = msg.content
          .split(',')
          .map((v) => Number(v))
          .filter((v) => v >= 1 && v <= 6);
        values.forEach((value, index) => {
          items.push({
            kind: 'dice',
            id: values.length === 1 ? msg.id : `${msg.id}-${index}`,
            mine: !!msg.from?.uid && msg.from.uid === myUid,
            name: msg.from?.nickname ?? '玩家',
            avatar: msg.from?.avatarUrl,
            values: [value],
          });
        });
      } else if (msg.type === 'STICKER') {
        items.push({
          kind: 'sticker',
          id: msg.id,
          mine: !!msg.from?.uid && msg.from.uid === myUid,
          name: msg.from?.nickname ?? '玩家',
          avatar: msg.from?.avatarUrl,
          url: msg.content,
          time: formatTime(msg.at),
        });
      } else if (msg.type === 'GAME_PACKET') {
        const packet = parseGamePacketContent(msg.content);
        if (seenGamePacketIds.has(packet.id)) continue;
        seenGamePacketIds.add(packet.id);
        const isCurrent = packet.id === state?.round?.packetId;
        const isPublishingCurrentRound =
          packet.roundId === state?.round?.id && state?.round?.phase === 'SENDING_PACKET';
        const canOpen =
          isCurrent && state?.round?.phase === 'CLAIMING' && state?.me.canClaim === true;
        // 内部红包抢过后仍可点开查看手气名单
        const canView =
          isCurrent &&
          state?.round?.packetChannel === 'INTERNAL' &&
          !!state?.me.claimedAmountCents &&
          (state?.round?.phase === 'CLAIMING' || state?.round?.phase === 'CLAIM_EXPIRED');
        // 红包结束/过期后所有人都可点开回看抢包名单（微信式）
        const viewEnded =
          !canOpen &&
          !canView &&
          !isPublishingCurrentRound &&
          (!isCurrent || state?.round?.phase === 'CLAIM_EXPIRED');
        if (isCurrent) hasCurrentGamePacket = true;
        items.push({
          kind: 'packet',
          id: msg.id,
          packetId: packet.id,
          title: packet.greeting,
          subtitle: canOpen
            ? '点击打开红包'
            : canView
              ? `已领取 RM ${rm(state!.me.claimedAmountCents!)} · 点击查看`
              : isPublishingCurrentRound
                ? '红包已发出 · 点击查看'
                : '点击查看红包',
          endsAt: canOpen ? deadline : null,
          claimable: canOpen,
          opened: canView || viewEnded,
          view: viewEnded,
          waiting: isPublishingCurrentRound,
          demo: false,
          asChat: true,
          name: ASSISTANT_NAME,
          avatar: ASSISTANT_AVATAR,
        });
      } else if (msg.type === 'USER_PACKET') {
        const packet = parseUserPacketContent(msg.content);
        items.push({
          kind: 'userPacket',
          id: msg.id,
          packetId: packet.id,
          greeting: packet.greeting,
          mine: !!msg.from?.uid && msg.from.uid === myUid,
          name: msg.from?.nickname ?? '玩家',
          avatar: msg.from?.avatarUrl,
          administrator:
            packet.administrator || msg.from?.role === 'GAME_ADMIN',
          time: formatTime(msg.at),
        });
      } else if (msg.type === 'USER_TIP') {
        const tip = parseUserTipContent(msg.content);
        items.push({
          kind: 'userTip',
          id: msg.id,
          amountCents: tip.amountCents,
          label: tip.label,
          message: tip.message,
          mine: !!msg.from?.uid && msg.from.uid === myUid,
          name: msg.from?.nickname ?? '玩家',
          avatar: msg.from?.avatarUrl,
          time: formatTime(msg.at),
        });
      } else {
        const mine = !!msg.from?.uid && msg.from.uid === myUid;
        const gameAction = msg.type !== 'EMOJI' ? msg.gameAction : undefined;
        items.push({
          kind: 'chat',
          id: msg.id,
          mine,
          name: msg.from?.nickname ?? '玩家',
          avatar: msg.from?.avatarUrl,
          text: msg.content,
          emoji: msg.type === 'EMOJI',
          gameAction,
          administrator: msg.from?.role === 'GAME_ADMIN',
          replyTo: msg.replyTo,
          time: formatTime(msg.at),
        });
      }
    }

    // 兼容升级前没有 GAME_PACKET 历史事件的进行中牌局。
    if (
      state?.round?.packetId &&
      !hasCurrentGamePacket &&
      (state.round.phase === 'CLAIMING' || state.round.phase === 'CLAIM_EXPIRED')
    ) {
      const canOpen =
        state.round.phase === 'CLAIMING' && state.me.canClaim;
      const canView =
        state.round.packetChannel === 'INTERNAL' && !!state.me.claimedAmountCents;
      const viewEnded = !canOpen && !canView && state.round.phase === 'CLAIM_EXPIRED';
      const fallbackPacket: FeedItem = {
        kind: 'packet',
        id: `packet-${state.round.packetId}`,
        packetId: state.round.packetId,
        title: '恭喜发财，大吉大利',
        subtitle: canOpen
          ? '点击打开红包'
          : canView
            ? `已领取 RM ${rm(state.me.claimedAmountCents!)} · 点击查看`
            : '点击查看红包',
        endsAt: canOpen ? deadline : null,
        claimable: canOpen,
        opened: canView || viewEnded,
        view: viewEnded,
        demo: false,
        asChat: true,
        name: ASSISTANT_NAME,
        avatar: ASSISTANT_AVATAR,
      };
      let claimStartIndex = -1;
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (
          item?.kind === 'banner' &&
          item.alt === '开始抢包' &&
          !item.id.startsWith('demo-')
        ) {
          claimStartIndex = index;
          break;
        }
      }
      if (claimStartIndex >= 0) items.splice(claimStartIndex, 0, fallbackPacket);
      else items.push(fallbackPacket);
    }

    return items;
  }, [state, chat, myUid, showDemoFeed, liveBusy, deadline]);

  // 消息窗口达到上限后每来一条就挤掉最旧一条，feed.length 恒定；
  // 贴底必须以「末条身份」为触发条件，否则新消息会停在输入栏下方看不见。
  const feedTailId = feed.length > 0 ? feed[feed.length - 1]!.id : '';
  const feedHeadId = feed.length > 0 ? feed[0]!.id : '';

  async function refresh() {
    if (!roomId) return;
    // 被动刷新只读状态即可；join（带成员写入）只在进房与断线重连时做，
    // 否则每次广播都触发全员 join 会把后端打满，导致整个互动群响应变卡。
    const next = await api.roomState(roomId);
    startTransition(() => setState(next));
    setError('');
  }

  async function rejoin() {
    if (!roomId) return;
    // 重新 join，恢复可能被标记为 LEFT 的成员身份，避免竞标/下注被拒
    const next = await api.joinRoom(roomId);
    startTransition(() => setState(next));
    setError('');
  }

  async function refreshRoomManually() {
    if (refreshingRef.current) return;
    if (!state || loading || connState === 'kicked') {
      retryEntry();
      return;
    }
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      // 在线时只读刷新即可；断线恢复时才重新 join，避免正常刷新重复走进房流程。
      if (connState === 'online') await refresh();
      else {
        await rejoin();
        reconnectNowRef.current();
      }
    } catch {
      setError('刷新失败，请检查网络后重试');
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }

  function retryEntry() {
    setError('');
    setLoading(true);
    setEntryRetryKey((key) => key + 1);
  }

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    let socket: WebSocket | null = null;
    let refreshTimer: number | null = null;
    let refreshDueAt = 0;
    let reconnectTimer: number | null = null;
    let disposeActiveSocketTimers: () => void = () => {};
    let reconnectAttempts = 0;
    let hasOpenedSocket = false;
    let suppressHeartbeatRefreshUntil = 0;
    let ticketRequestInFlight = false;
    /** 当前 WebSocket 开始握手的时间戳，用于「立即重连」判断是否已卡住 */
    let wsConnectingSince = 0;
    setLoading(true);
    setState(null);
    setError('');
    setConnState('connecting');
    stickToBottomRef.current = true;
    didInitialScrollRef.current = false;
    setChannelOpen(false);
    setQuickActionsOpen(false);
    setChat([]);
    chatRef.current = [];
    markNewBelow(false);
    didReceiveHistoryRef.current = false;
    historyRequestIdRef.current = null;
    historyRequestTombstoneGenerationRef.current = 0;
    if (historyLoadTimerRef.current !== null) {
      window.clearTimeout(historyLoadTimerRef.current);
      historyLoadTimerRef.current = null;
    }
    markHistoryLoading(false);
    markHistoryHasMore(false);
    markHistoryControlVisible(false);
    setHistoryLoadFailed(false);
    chatDeleteTombstonesRef.current.clear();
    chatDeleteGenerationRef.current = 0;
    clearPendingBet();
    dismissPrivateBetNotice();
    const storedClaims = readStoredPacketClaims(roomId);
    packetClaimsRef.current = storedClaims;
    setPacketClaims(storedClaims);
    packetDetailCacheRef.current = {};
    setAnimatedDiceIds({});

    const scheduleRefresh = (delayMs = 250) => {
      const dueAt = Date.now() + delayMs;
      // 已有更早的刷新时，不让后来的恢复心跳把它推迟。
      if (refreshTimer !== null && refreshDueAt <= dueAt) return;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshDueAt = dueAt;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        refreshDueAt = 0;
        void refresh().catch(() => undefined);
      }, delayMs);
    };

    // 回到前台时若连接已断开，立即重连而不是等退避计时
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      reconnectNowRef.current();
      scheduleRefresh(0);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    (async () => {
      try {
        const joined = await api.joinRoom(roomId);
        if (cancelled) return;
        // 进房响应内嵌的首连票据：首次建连直接使用，省一次串行取票往返。
        let inlineWsTicket: string | null = joined.wsTicket?.ticket ?? null;
        setMyUid(session.uid);
        setMyProfile({
          nickname: session.nickname || session.uid,
          avatarUrl: session.avatarUrl,
        });
        setState(joined);
        setError('');
        suppressHeartbeatRefreshUntil = Date.now() + 2_500;

        if (!getToken()) throw new Error('未登录');

        const handleSocketMessage = (
          event: MessageEvent,
          acknowledgePong: () => void,
        ) => {
          try {
            const payload = JSON.parse(String(event.data)) as {
              type?: string;
              messages?: ChatMsg[];
              /** chat 事件为消息对象，chat_error 事件为错误文本 */
              message?: ChatMsg | string;
              online?: number;
              nickname?: string;
              amountCents?: string;
              status?: 'success' | 'failed';
              action?: 'bet' | 'all_in';
              acceptance?: unknown;
              reason?: string;
              heartbeat?: boolean;
              hasMore?: boolean;
              error?: string;
              /** tip_thanks 附带祝福语 */
              tipMessage?: string;
              avatarUrl?: string | null;
              user?: { uid: string; nickname: string; avatarUrl?: string | null };
              requestId?: string;
              messageId?: string;
              muted?: boolean;
              mutedAt?: string | null;
              mutedUntil?: string | null;
            };
            if (payload.type === 'pong') {
              acknowledgePong();
            } else if (
              payload.type === 'room_moderation'
              && typeof payload.muted === 'boolean'
            ) {
              setState((current) =>
                current
                  ? {
                      ...current,
                      room: {
                        ...current.room,
                        chatMute: payload.muted
                          ? {
                              muted: true,
                              mutedAt: payload.mutedAt ?? new Date().toISOString(),
                              reason: payload.reason ?? null,
                            }
                          : {
                              muted: false,
                              mutedAt: null,
                              reason: null,
                            },
                      },
                    }
                  : current,
              );
              setReplyTarget(null);
            } else if (payload.type === 'moderation' && typeof payload.muted === 'boolean') {
              setState((current) =>
                current
                  ? {
                      ...current,
                      me: {
                        ...current.me,
                        chatMute: payload.muted
                          ? {
                              active: true,
                              mutedAt: payload.mutedAt ?? new Date().toISOString(),
                              mutedUntil: payload.mutedUntil ?? null,
                              reason: payload.reason ?? null,
                            }
                          : {
                              active: false,
                              mutedAt: null,
                              mutedUntil: null,
                              reason: null,
                            },
                      },
                    }
                  : current,
              );
              setError(
                payload.muted
                  ? payload.reason
                    ? `你已被管理员禁言：${payload.reason}`
                    : '你已被管理员禁言'
                  : '',
              );
            } else if (payload.type === 'chat_history' && payload.messages) {
              const recentMessages = filterHistoryMessages(payload.messages)
                .slice(-CLIENT_CHAT_LIMIT);
              const isInitialHistory = !didReceiveHistoryRef.current;
              didReceiveHistoryRef.current = true;
              const knownIds = new Set(chatRef.current.map((message) => message.id));
              let reconnectHistory = isInitialHistory
                ? null
                : mergeContiguousChatWindows(chatRef.current, recentMessages);
              if (reconnectHistory) {
                const recentPacketIds = new Set(
                  recentMessages
                    .filter((message) => message.type === 'USER_PACKET')
                    .map((message) => parseUserPacketContent(message.content).id),
                );
                reconnectHistory = reconnectHistory.filter(
                  (message) =>
                    !message.id.startsWith('local-packet-')
                    || !recentPacketIds.has(
                      parseUserPacketContent(message.content).id,
                    ),
                );
              }
              const resetDisjointHistory =
                !isInitialHistory
                && reconnectHistory === null;
              const projectedCount = Math.min(
                CLIENT_CHAT_LIMIT,
                isInitialHistory
                  ? chatRef.current.length
                    + recentMessages.filter((message) => !knownIds.has(message.id)).length
                  : (reconnectHistory ?? recentMessages).length,
              );
              markHistoryHasMore(
                (
                  payload.hasMore === true
                  || (
                    payload.hasMore === undefined
                    && recentMessages.length >= INITIAL_CHAT_HISTORY_LIMIT
                  )
                )
                && projectedCount < CLIENT_CHAT_LIMIT,
              );
              setHistoryLoadFailed(false);
              if (isInitialHistory || resetDisjointHistory) {
                stickToBottomRef.current = true;
                didInitialScrollRef.current = false;
              }
              // 历史加载可能晚于实时 chat；按 ID 合并，不能覆盖刚收到的对局红包。
              setChat((prev) => {
                if (!isInitialHistory) {
                  const next = (reconnectHistory ?? recentMessages)
                    .slice(-CLIENT_CHAT_LIMIT);
                  chatRef.current = next;
                  return next;
                }
                const merged = [...recentMessages];
                const ids = new Set(merged.map((message) => message.id));
                for (const current of prev) {
                  if (ids.has(current.id)) continue;
                  if (current.type === 'USER_PACKET') {
                    const packetId = parseUserPacketContent(current.content).id;
                    const exists = merged.some(
                      (message) =>
                        message.type === 'USER_PACKET' &&
                        parseUserPacketContent(message.content).id === packetId,
                    );
                    if (exists) continue;
                  }
                  merged.push(current);
                  ids.add(current.id);
                }
                const next = merged
                  .sort(compareChatMessages)
                  .slice(-CLIENT_CHAT_LIMIT);
                chatRef.current = next;
                return next;
              });
              const packetIds = [
                ...new Set(
                  recentMessages
                    .filter((message) => message.type === 'USER_PACKET')
                    .map((message) => parseUserPacketContent(message.content).id)
                    .filter(Boolean),
                ),
              ];
              if (packetIds.length) {
                void api.groupPacketClaimStatus(packetIds).then((result) => {
                  if (cancelled) return;
                  applyClaimStatusItems(result.items);
                });
              }
            } else if (payload.type === 'chat_history_page' && payload.messages) {
              if (
                payload.requestId
                && payload.requestId !== historyRequestIdRef.current
              ) {
                return;
              }
              if (historyLoadTimerRef.current !== null) {
                window.clearTimeout(historyLoadTimerRef.current);
                historyLoadTimerRef.current = null;
              }
              const authoritativeTombstoneGeneration =
                historyRequestTombstoneGenerationRef.current;
              historyRequestIdRef.current = null;
              historyRequestTombstoneGenerationRef.current = 0;

              if (
                payload.error === 'HISTORY_UNAVAILABLE'
                || payload.error === 'RATE_LIMITED'
              ) {
                markHistoryHasMore(true);
                markHistoryLoading(false);
                setHistoryLoadFailed(true);
                return;
              }
              if (
                payload.error === 'HISTORY_CURSOR_EXPIRED'
              ) {
                const resetMessages = filterHistoryMessages(
                  payload.messages,
                  authoritativeTombstoneGeneration,
                )
                  .slice(-CLIENT_CHAT_LIMIT);
                chatRef.current = resetMessages;
                setChat(resetMessages);
                stickToBottomRef.current = true;
                didInitialScrollRef.current = false;
                markHistoryHasMore(
                  payload.hasMore === true
                  && resetMessages.length < CLIENT_CHAT_LIMIT,
                );
                markHistoryLoading(false);
                setHistoryLoadFailed(false);
                return;
              }
              if (payload.error === 'INVALID_HISTORY_CURSOR') {
                markHistoryHasMore(false);
                markHistoryLoading(false);
                setHistoryLoadFailed(false);
                return;
              }
              setHistoryLoadFailed(false);

              const olderMessages = filterHistoryMessages(
                payload.messages,
                authoritativeTombstoneGeneration,
              );
              const knownIds = new Set(chatRef.current.map((message) => message.id));
              const uniqueOlderCount = olderMessages.reduce(
                (count, message) => count + (knownIds.has(message.id) ? 0 : 1),
                0,
              );
              const reachesClientLimit =
                chatRef.current.length + uniqueOlderCount >= CLIENT_CHAT_LIMIT;

              setChat((prev) => {
                const byId = new Map<string, ChatMsg>();
                for (const message of olderMessages) byId.set(message.id, message);
                for (const message of prev) byId.set(message.id, message);
                const merged = [...byId.values()]
                  .sort(compareChatMessages)
                  .slice(-CLIENT_CHAT_LIMIT);
                chatRef.current = merged;
                return merged;
              });
              markHistoryHasMore(
                payload.hasMore === true
                && !reachesClientLimit,
              );
              markHistoryLoading(false);

              const packetIds = [
                ...new Set(
                  olderMessages
                    .filter((message) => message.type === 'USER_PACKET')
                    .map((message) => parseUserPacketContent(message.content).id)
                    .filter(Boolean),
                ),
              ];
              if (packetIds.length) {
                void api.groupPacketClaimStatus(packetIds).then((result) => {
                  if (cancelled) return;
                  applyClaimStatusItems(result.items);
                });
              }
            } else if (
              payload.type === 'chat' &&
              payload.message &&
              typeof payload.message === 'object'
            ) {
              const incoming = payload.message;
              chatDeleteTombstonesRef.current.delete(incoming.id);
              const pendingAck = pendingChatAckRef.current;
              const legacyPendingAmount = pendingAck
                ? canonicalNumericCommand(pendingAck.content)
                : null;
              if (
                incoming.from?.uid === session.uid
                && pendingAck
                && (
                  incoming.requestId === pendingAck.requestId
                  || (
                    !incoming.requestId
                    && (
                      pendingAck.content === incoming.content.trim()
                      || (
                        legacyPendingAmount !== null
                        && legacyPendingAmount === canonicalNumericCommand(incoming.content)
                      )
                    )
                  )
                )
              ) {
                settlePendingChat(true);
              }
              if (incoming.type === 'DICE') {
                setAnimatedDiceIds((prev) => ({ ...prev, [incoming.id]: true }));
              }
              setChat((prev) => {
                if (incoming.type === 'USER_PACKET') {
                  const packetId = parseUserPacketContent(incoming.content).id;
                  const withoutLocal = prev.filter((msg) => {
                    if (msg.type !== 'USER_PACKET') return true;
                    if (!msg.id.startsWith('local-packet-')) return true;
                    return parseUserPacketContent(msg.content).id !== packetId;
                  });
                  if (
                    withoutLocal.some(
                      (msg) =>
                        msg.type === 'USER_PACKET' &&
                        parseUserPacketContent(msg.content).id === packetId,
                    )
                  ) {
                    return withoutLocal;
                  }
                  return [
                    ...withoutLocal.slice(-(CLIENT_CHAT_LIMIT - 1)),
                    incoming,
                  ];
                }
                const existingIndex = prev.findIndex((message) => message.id === incoming.id);
                if (existingIndex >= 0) {
                  return prev.map((message, index) =>
                    index === existingIndex ? { ...message, ...incoming } : message,
                  );
                }
                return [...prev.slice(-(CLIENT_CHAT_LIMIT - 1)), incoming];
              });
            } else if (
              payload.type === 'chat_update' &&
              payload.message &&
              typeof payload.message === 'object'
            ) {
              const updated = payload.message;
              if (chatDeleteTombstonesRef.current.has(updated.id)) return;
              setChat((prev) => {
                const exists = prev.some((item) => item.id === updated.id);
                if (!exists) {
                  return [...prev.slice(-(CLIENT_CHAT_LIMIT - 1)), updated];
                }
                return prev.map((item) => (item.id === updated.id ? { ...item, ...updated } : item));
              });
            } else if (
              payload.type === 'chat_delete'
              && typeof payload.messageId === 'string'
            ) {
              chatDeleteGenerationRef.current += 1;
              chatDeleteTombstonesRef.current.set(
                payload.messageId,
                chatDeleteGenerationRef.current,
              );
              setChat((prev) => prev.filter((message) => message.id !== payload.messageId));
              setReplyTarget((current) =>
                current?.messageId === payload.messageId ? null : current,
              );
            } else if (
              payload.type === 'bet_confirmation' &&
              (payload.status === 'success' || payload.status === 'failed') &&
              (payload.action === 'bet' || payload.action === 'all_in') &&
              typeof payload.amountCents === 'string'
            ) {
              const matchesPendingBet =
                !payload.requestId
                || payload.requestId === betPendingRequestIdRef.current;
              const matchesPendingChat =
                !payload.requestId
                || payload.requestId === pendingChatAckRef.current?.requestId;
              if (matchesPendingBet) clearPendingBet();
              if (matchesPendingChat) {
                settlePendingChat(payload.status === 'success');
              }
              setError('');
              pushPrivateBetNotice({
                status: payload.status,
                action: payload.action,
                amountCents: payload.amountCents,
                acceptance: parseBetAcceptanceNotice(payload.acceptance),
                reason: typeof payload.reason === 'string' ? payload.reason : undefined,
              });
              scheduleRefresh();
            } else if (payload.type === 'profile_update' && payload.user?.uid) {
              const profile = payload.user;
              setChat((prev) =>
                prev.map((message) =>
                  message.from?.uid === profile.uid
                    ? {
                        ...message,
                        from: {
                          uid: profile.uid,
                          nickname: profile.nickname || profile.uid,
                          avatarUrl: profile.avatarUrl,
                        },
                      }
                    : message,
                ),
              );
              if (profile.uid === session.uid) {
                setMyProfile({
                  nickname: profile.nickname || profile.uid,
                  avatarUrl: profile.avatarUrl,
                });
              }
              scheduleRefresh();
            } else if (payload.type === 'chat_error' && typeof payload.message === 'string') {
              const matchesPendingChat =
                !!payload.requestId
                && payload.requestId === pendingChatAckRef.current?.requestId;
              if (
                payload.requestId
                && payload.requestId === betPendingRequestIdRef.current
              ) {
                clearPendingBet();
              }
              if (matchesPendingChat) settlePendingChat(false);
              setError(payload.message);
              setDiceSent(false);
              // 指令被拒时立刻同步阶段，避免顶栏仍显示「竞标中」
              scheduleRefresh();
            } else if (payload.type === 'chat_notice' && typeof payload.message === 'string') {
              setError(payload.message);
              scheduleRefresh();
            } else if (
              payload.type === 'tip_thanks' &&
              typeof payload.nickname === 'string' &&
              typeof payload.amountCents === 'string'
            ) {
              const tipPayload = payload as {
                nickname: string;
                amountCents: string;
                message?: string;
                avatarUrl?: string | null;
              };
              enqueueTipDanmaku({
                nickname: tipPayload.nickname,
                amountCents: tipPayload.amountCents,
                message:
                  typeof tipPayload.message === 'string' ? tipPayload.message : undefined,
                avatarUrl:
                  typeof tipPayload.avatarUrl === 'string' || tipPayload.avatarUrl === null
                    ? tipPayload.avatarUrl
                    : undefined,
              });
            } else if (payload.type === 'round') {
              if (
                payload.heartbeat
                && Date.now() < suppressHeartbeatRefreshUntil
              ) {
                return;
              }
              // 周期恢复心跳让各客户端随机错峰，避免数百人同一毫秒请求 state。
              scheduleRefresh(
                payload.heartbeat
                  ? 250 + Math.floor(Math.random() * 1_750)
                  : 250,
              );
            } else if (
              payload.type === 'claim' ||
              payload.type === 'activity' ||
              payload.type === 'reward'
            ) {
              scheduleRefresh();
            }
          } catch {
            // ignore
          }
        };
        const connectSocket = async () => {
          if (cancelled || ticketRequestInFlight) return;
          disposeActiveSocketTimers();
          if (reconnectTimer) {
            window.clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }
          setConnState(hasOpenedSocket ? 'reconnecting' : 'connecting');
          // 首次建连优先使用进房响应内嵌的票据（60 秒有效），跳过一次串行取票往返；
          // 重连时票据大概率已过期，走原有取票流程。
          const prefetchedTicket = inlineWsTicket;
          inlineWsTicket = null;
          ticketRequestInFlight = true;
          let ticket: string;
          try {
            ticket = prefetchedTicket ?? (await api.roomWsTicket(roomId)).ticket;
          } catch (error) {
            if (cancelled) return;
            const code = (error as Error & { code?: string }).code;
            if (
              code === 'DEVICE_SESSION_EXPIRED'
              || code === 'DEVICE_MISMATCH'
              || code === 'UNAUTHORIZED'
            ) {
              invalidateDeviceSession(
                code === 'UNAUTHORIZED' ? 'DEVICE_SESSION_EXPIRED' : code,
              );
              return;
            }
            if (code === 'NOT_IN_ROOM' || code === 'USER_BANNED') {
              setConnState('kicked');
              setError(
                code === 'USER_BANNED'
                  ? '账号已停用，请联系客服'
                  : '您已不在互动群内，请返回后重新进入房间',
              );
              return;
            }
            setConnState('reconnecting');
            reconnectAttempts += 1;
            const delay = Math.min(
              15_000,
              1_000 * 2 ** Math.min(reconnectAttempts - 1, 4),
            );
            reconnectTimer = window.setTimeout(() => void connectSocket(), delay);
            return;
          } finally {
            ticketRequestInFlight = false;
          }
          if (cancelled) return;
          const ws = new WebSocket(roomWsUrl(roomId, ticket));
          wsConnectingSince = Date.now();
          socket = ws;
          socketRef.current = ws;
          wsConnectingSince = Date.now();
          let wsConnectTimeout: number | null = null;
          let wsHeartbeatTimer: number | null = null;
          let wsPongTimeout: number | null = null;
          const clearWsTimers = () => {
            if (wsConnectTimeout !== null) window.clearTimeout(wsConnectTimeout);
            if (wsHeartbeatTimer !== null) window.clearInterval(wsHeartbeatTimer);
            if (wsPongTimeout !== null) window.clearTimeout(wsPongTimeout);
            wsConnectTimeout = null;
            wsHeartbeatTimer = null;
            wsPongTimeout = null;
          };
          disposeActiveSocketTimers = clearWsTimers;
          wsConnectTimeout = window.setTimeout(() => {
            if (ws.readyState !== WebSocket.CONNECTING) return;
            try {
              ws.close(4000, 'CONNECT_TIMEOUT');
            } catch {
              // 浏览器最终仍会触发 error/close；避免连接看门狗本身抛错。
            }
          }, 8_000);
          ws.onopen = () => {
            if (cancelled || socket !== ws) {
              clearWsTimers();
              ws.close();
              return;
            }
            if (wsConnectTimeout !== null) window.clearTimeout(wsConnectTimeout);
            wsConnectTimeout = null;
            const isReconnect = hasOpenedSocket;
            hasOpenedSocket = true;
            reconnectAttempts = 0;
            suppressHeartbeatRefreshUntil = Math.max(
              suppressHeartbeatRefreshUntil,
              Date.now() + 1_500,
            );
            setConnState('online');
            wsHeartbeatTimer = window.setInterval(() => {
              if (ws.readyState !== WebSocket.OPEN) return;
              ws.send(JSON.stringify({ type: 'ping' }));
              if (wsPongTimeout !== null) window.clearTimeout(wsPongTimeout);
              wsPongTimeout = window.setTimeout(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.close(4001, 'HEARTBEAT_TIMEOUT');
                }
              }, 10_000);
            }, 20_000);
            // 首次进房已完成 join；重连后只读同步状态，避免重复写成员记录。
            if (isReconnect) scheduleRefresh();
          };
          ws.onmessage = (event) => {
            if (cancelled || socket !== ws) return;
            handleSocketMessage(event, () => {
              if (wsPongTimeout !== null) window.clearTimeout(wsPongTimeout);
              wsPongTimeout = null;
            });
          };
          ws.onclose = (event) => {
            clearWsTimers();
            if (cancelled || socket !== ws) return;
            settlePendingChat(false);
            // 新连接会从 Redis 权威窗口重建；不要让旧连接的删除标记屏蔽合法重建 ID。
            chatDeleteTombstonesRef.current.clear();
            const historyWasLoading = historyLoadingRef.current;
            if (historyLoadTimerRef.current !== null) {
              window.clearTimeout(historyLoadTimerRef.current);
              historyLoadTimerRef.current = null;
            }
            historyRequestIdRef.current = null;
            historyRequestTombstoneGenerationRef.current = 0;
            markHistoryLoading(false);
            if (historyWasLoading) setHistoryLoadFailed(true);
            socket = null;
            if (socketRef.current === ws) socketRef.current = null;
            if (event.code === 4401 || event.reason === 'DEVICE_SESSION_EXPIRED') {
              invalidateDeviceSession(
                event.reason === 'DEVICE_SESSION_EXPIRED'
                  ? event.reason
                  : 'DEVICE_SESSION_EXPIRED',
              );
              return;
            }
            // 被移出房间 / 房间不可用属于终态：重连只会被立刻再次关闭，
            // 停止重试并明确提示，避免顶栏永远「重连中…」
            if (
              event.reason === 'NOT_IN_ROOM'
              || event.reason === 'GAME_NOT_SUPPORTED'
              || event.reason === 'USER_NOT_ACTIVE'
              || event.reason === 'USER_BANNED'
            ) {
              setConnState('kicked');
              setError(
                event.reason === 'NOT_IN_ROOM'
                  ? '您已不在互动群内，请返回后重新进入房间'
                  : event.reason === 'GAME_NOT_SUPPORTED'
                    ? '该房间已不可用，请返回大厅'
                    : '账号已停用，请联系客服',
              );
              return;
            }
            // 断线自动重连：指数退避，最长 15 秒重试一次
            setConnState('reconnecting');
            reconnectAttempts += 1;
            const delay = Math.min(
              15_000,
              1_000 * 2 ** Math.min(reconnectAttempts - 1, 4),
            );
            reconnectTimer = window.setTimeout(() => void connectSocket(), delay);
          };
        };
        reconnectNowRef.current = () => {
          if (socket) {
            if (socket.readyState === WebSocket.OPEN) return;
            if (socket.readyState === WebSocket.CONNECTING) {
              // 握手刚开始（<3 秒）时不打断；卡住超过 3 秒则强制断开，
              // 由 onclose 立即触发新一轮重连，避免干等 8 秒看门狗。
              if (Date.now() - wsConnectingSince < 3_000) return;
              reconnectAttempts = 0;
              try {
                socket.close(4002, 'MANUAL_RETRY');
              } catch {
                // close 抛错时浏览器仍会触发 close 事件，自动重连不受影响。
              }
              return;
            }
          }
          reconnectAttempts = 0;
          void connectSocket();
        };
        void connectSocket();
      } catch (e) {
        const code = (e as Error & { code?: string }).code;
        if (code === 'KYC_REQUIRED') {
          navigate('/kyc', { replace: true });
          return;
        }
        setError((e as Error).message || '进群失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      disposeActiveSocketTimers();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      reconnectNowRef.current = () => {};
      socket?.close();
      socketRef.current = null;
      if (historyLoadTimerRef.current !== null) {
        window.clearTimeout(historyLoadTimerRef.current);
        historyLoadTimerRef.current = null;
      }
      historyRequestIdRef.current = null;
      historyRequestTombstoneGenerationRef.current = 0;
      historyLoadingRef.current = false;
      clearPendingBet();
      settlePendingChat(false);
      dismissPrivateBetNotice();
      // 不在卸载时 leaveRoom：React 重挂载/切页会把成员打成 LEFT，
      // 导致竞标失败且凑不齐开局人数。主动返回时再离房。
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    roomId,
    navigate,
    session.uid,
    session.nickname,
    session.avatarUrl,
    entryRetryKey,
  ]);

  useEffect(() => {
    // 进入可发送金额的阶段时，清掉上一阶段残留的红色提示
    if (state?.round?.phase === 'BANKER_BID' || state?.round?.phase === 'BETTING') {
      setError('');
    }
  }, [state?.round?.id, state?.round?.phase]);

  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    const onScroll = () => {
      const nextScrollTop = el.scrollTop;
      markHistoryControlVisible(nextScrollTop <= CHAT_HISTORY_TOP_THRESHOLD);
      const roomFeatureScrollTop = roomFeatureScrollTopRef.current;
      if (roomFeatureScrollTop !== null) {
        const lockedScrollTop = Math.min(
          roomFeatureScrollTop,
          Math.max(0, el.scrollHeight - el.clientHeight),
        );
        if (Math.abs(nextScrollTop - lockedScrollTop) > 0.5) {
          el.scrollTop = lockedScrollTop;
        }
        programmaticFeedScrollRef.current = false;
        stickToBottomRef.current = false;
        lastScrollTopRef.current = lockedScrollTop;
        lastScrollHeightRef.current = el.scrollHeight;
        return;
      }
      if (programmaticFeedScrollRef.current) {
        programmaticFeedScrollRef.current = false;
        lastScrollTopRef.current = nextScrollTop;
        lastScrollHeightRef.current = el.scrollHeight;
        if (isFeedNearBottom(el)) {
          stickToBottomRef.current = true;
          feedViewportAnchorRef.current = null;
          markNewBelow(false);
        } else if (!stickToBottomRef.current) {
          feedViewportAnchorRef.current = captureFeedViewport(el, feedIdsRef.current);
        }
        return;
      }
      const movedUp = nextScrollTop < lastScrollTopRef.current - 1;
      if (movedUp || !isFeedNearBottom(el)) {
        stickToBottomRef.current = false;
        feedViewportAnchorRef.current = captureFeedViewport(el, feedIdsRef.current);
      } else {
        stickToBottomRef.current = true;
        feedViewportAnchorRef.current = null;
        markNewBelow(false);
      }
      lastScrollTopRef.current = nextScrollTop;
      lastScrollHeightRef.current = el.scrollHeight;
      if (nextScrollTop <= CHAT_HISTORY_TOP_THRESHOLD) {
        requestOlderHistory();
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const keepPinned = () => {
      const roomFeatureScrollTop = roomFeatureScrollTopRef.current;
      if (roomFeatureScrollTop !== null) {
        const lockedScrollTop = Math.min(
          roomFeatureScrollTop,
          Math.max(0, el.scrollHeight - el.clientHeight),
        );
        if (Math.abs(el.scrollTop - lockedScrollTop) > 0.5) {
          programmaticFeedScrollRef.current = true;
          el.scrollTop = lockedScrollTop;
        }
        stickToBottomRef.current = false;
        lastScrollTopRef.current = lockedScrollTop;
        lastScrollHeightRef.current = el.scrollHeight;
        return;
      }
      if (stickToBottomRef.current) {
        const bottomScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
        if (Math.abs(el.scrollTop - bottomScrollTop) > 0.5) {
          programmaticFeedScrollRef.current = true;
        }
        el.scrollTop = bottomScrollTop;
        feedViewportAnchorRef.current = null;
      } else {
        const anchor = feedViewportAnchorRef.current;
        if (anchor) {
          restoreFeedViewport(
            el,
            feedIdsRef.current,
            anchor,
            () => { programmaticFeedScrollRef.current = true; },
          );
        }
        if (isFeedNearBottom(el)) {
          stickToBottomRef.current = true;
          feedViewportAnchorRef.current = null;
          markNewBelow(false);
        } else {
          feedViewportAnchorRef.current = captureFeedViewport(el, feedIdsRef.current);
        }
      }
      lastScrollTopRef.current = el.scrollTop;
      lastScrollHeightRef.current = el.scrollHeight;
    };
    const observer = new ResizeObserver(keepPinned);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      observer.disconnect();
    };
  }, [loading, markHistoryControlVisible, requestOlderHistory]);

  useLayoutEffect(() => {
    const el = streamRef.current;
    const roomFeatureScrollTop = roomFeatureScrollTopRef.current;
    if (!freezeFeed) {
      if (!el || roomFeatureScrollTop === null) return;
      stickToBottomRef.current = false;
      const restoredScrollTop = Math.min(
        roomFeatureScrollTop,
        Math.max(0, el.scrollHeight - el.clientHeight),
      );
      if (Math.abs(el.scrollTop - restoredScrollTop) > 0.5) {
        programmaticFeedScrollRef.current = true;
      }
      el.scrollTop = restoredScrollTop;
      lastScrollTopRef.current = restoredScrollTop;
      lastScrollHeightRef.current = el.scrollHeight;
      const restoredAtBottom = isFeedNearBottom(el);
      stickToBottomRef.current = restoredAtBottom;
      feedViewportAnchorRef.current = restoredAtBottom
        ? null
        : captureFeedViewport(el, feedIdsRef.current);
      if (restoredAtBottom) markNewBelow(false);
      let settleFrame = 0;
      const restoreFrame = window.requestAnimationFrame(() => {
        settleFrame = window.requestAnimationFrame(() => {
          if (roomFeatureScrollTopRef.current !== roomFeatureScrollTop) return;
          const settledScrollTop = Math.min(
            roomFeatureScrollTop,
            Math.max(0, el.scrollHeight - el.clientHeight),
          );
          if (Math.abs(el.scrollTop - settledScrollTop) > 0.5) {
            programmaticFeedScrollRef.current = true;
          }
          el.scrollTop = settledScrollTop;
          lastScrollTopRef.current = settledScrollTop;
          lastScrollHeightRef.current = el.scrollHeight;
          const settledAtBottom = isFeedNearBottom(el);
          stickToBottomRef.current = settledAtBottom;
          feedViewportAnchorRef.current = settledAtBottom
            ? null
            : captureFeedViewport(el, feedIdsRef.current);
          if (settledAtBottom) markNewBelow(false);
          roomFeatureScrollTopRef.current = null;
        });
      });
      return () => {
        window.cancelAnimationFrame(restoreFrame);
        if (settleFrame) window.cancelAnimationFrame(settleFrame);
      };
    }

    stickToBottomRef.current = false;
    if (!el) return;
    if (roomFeatureScrollTop !== null) {
      const lockedScrollTop = Math.min(
        roomFeatureScrollTop,
        Math.max(0, el.scrollHeight - el.clientHeight),
      );
      if (Math.abs(el.scrollTop - lockedScrollTop) > 0.5) {
        programmaticFeedScrollRef.current = true;
      }
      el.scrollTop = lockedScrollTop;
    }
    feedViewportAnchorRef.current = captureFeedViewport(el, feedIdsRef.current);
    lastScrollTopRef.current = el.scrollTop;
    lastScrollHeightRef.current = el.scrollHeight;
  }, [freezeFeed]);

  useLayoutEffect(() => {
    if (loading || freezeFeed) return;
    const el = streamRef.current;
    if (!el) return;
    const nextFeedIds = feed.map((item) => item.id);
    const appendedBelow = hasAppendedFeedItems(
      feedIdsRef.current,
      nextFeedIds,
    );

    // 贴底时同步改 scrollTop，避免新消息先入画再 smooth 上滑，把正在看的内容顶走。
    if (!didInitialScrollRef.current || stickToBottomRef.current) {
      feedIdsRef.current = nextFeedIds;
      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
      lastScrollHeightRef.current = el.scrollHeight;
      didInitialScrollRef.current = true;
      stickToBottomRef.current = true;
      feedViewportAnchorRef.current = null;
      markNewBelow(false);
      markHistoryControlVisible(el.scrollTop <= CHAT_HISTORY_TOP_THRESHOLD);
      return;
    }

    // 上翻看历史时，以屏幕内正在阅读的消息作为锚点。即使窗口挤掉了
    // 顶部旧消息，或新消息高度不同，也不会用总高度差把视口向下推。
    const anchor = feedViewportAnchorRef.current;
    feedIdsRef.current = nextFeedIds;
    const restored = anchor
      ? restoreFeedViewport(
          el,
          nextFeedIds,
          anchor,
          () => { programmaticFeedScrollRef.current = true; },
        )
      : false;
    if (!restored) {
      const nextScrollTop = Math.min(
        lastScrollTopRef.current,
        Math.max(0, el.scrollHeight - el.clientHeight),
      );
      if (Math.abs(el.scrollTop - nextScrollTop) > 0.5) {
        programmaticFeedScrollRef.current = true;
      }
      el.scrollTop = nextScrollTop;
    }
    lastScrollTopRef.current = el.scrollTop;
    lastScrollHeightRef.current = el.scrollHeight;
    if (isFeedNearBottom(el)) {
      stickToBottomRef.current = true;
      feedViewportAnchorRef.current = null;
      markNewBelow(false);
    } else {
      feedViewportAnchorRef.current = captureFeedViewport(el, nextFeedIds);
      if (appendedBelow) markNewBelow(true);
    }
    markHistoryControlVisible(el.scrollTop <= CHAT_HISTORY_TOP_THRESHOLD);
  }, [
    loading,
    freezeFeed,
    feed.length,
    feedTailId,
    feedHeadId,
    markHistoryControlVisible,
  ]);

  useEffect(() => {
    void api
      .stickers()
      .then((result) => setStickers(result.items))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    packetClaimsRef.current = packetClaims;
  }, [packetClaims]);

  useEffect(() => {
    if (!roomId || !myUid) return;
    const packetIds = [
      ...new Set(
        chat
          .filter((message) => message.type === 'USER_PACKET')
          .map((message) => parseUserPacketContent(message.content).id)
          .filter(Boolean),
      ),
    ];
    if (!packetIds.length) return;
    const missing = packetIds.filter((id) => packetClaimsRef.current[id] === undefined);
    if (!missing.length) return;
    let cancelled = false;
    void api.groupPacketClaimStatus(missing).then((result) => {
      if (cancelled) return;
      applyClaimStatusItems(result.items);
    });
    return () => {
      cancelled = true;
    };
  }, [chat, roomId, myUid]);

  useEffect(() => {
    if (state?.round?.phase !== 'SENDING_PACKET') setDiceSent(false);
  }, [state?.round?.phase, state?.round?.id]);

  useEffect(() => {
    if (!tipNotice) return;
    const activeId = tipNotice.id;
    const timer = window.setTimeout(() => {
      setTipDanmakuQueue((current) =>
        current[0]?.id === activeId ? current.slice(1) : current,
      );
    }, 7_400);
    return () => window.clearTimeout(timer);
  }, [tipNotice]);

  /** 打赏页返回时，本人也能立刻看到群内弹幕；其他在线玩家由 WS 接收。 */
  useEffect(() => {
    const notice = (location.state as PlayLocationState | null)?.tipNotice;
    if (!notice?.nickname || !notice.amountCents) return;
    enqueueTipDanmaku(notice);
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [
    enqueueTipDanmaku,
    location.state,
    location.pathname,
    location.search,
    navigate,
  ]);

  /** 从发红包页返回时立刻插入自己的红包气泡，避免 WS 重连/历史竞态导致「发出去看不见」 */
  useEffect(() => {
    const sent = (location.state as PlayLocationState | null)?.sentPacket;
    if (!sent?.packetId || !myUid) return;
    setChat((prev) => {
      const exists = prev.some(
        (msg) =>
          msg.type === 'USER_PACKET' &&
          parseUserPacketContent(msg.content).id === sent.packetId,
      );
      if (exists) return prev;
      return [
        ...prev.slice(-(CLIENT_CHAT_LIMIT - 1)),
        {
          id: `local-packet-${sent.packetId}`,
          type: 'USER_PACKET',
          content: JSON.stringify({ id: sent.packetId, greeting: sent.greeting }),
          from: {
            uid: myUid,
            nickname: myProfile?.nickname ?? myUid,
            avatarUrl: myProfile?.avatarUrl,
          },
          at: new Date().toISOString(),
        },
      ];
    });
    stickToBottomRef.current = true;
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [location.state, location.pathname, location.search, myUid, myProfile, navigate]);

  async function runAction(action: () => Promise<RoomState>) {
    setBusy(true);
    setError('');
    try {
      setState(await action());
    } catch (e) {
      setError((e as Error).message || '操作失败');
    } finally {
      setBusy(false);
    }
  }

  /** 自己发出内容后强制回到底部：即使之前上翻了历史，也应立刻看到自己的消息 */
  function jumpToBottom() {
    stickToBottomRef.current = true;
    markNewBelow(false);
    const el = streamRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastScrollTopRef.current = el.scrollTop;
    lastScrollHeightRef.current = el.scrollHeight;
  }

  /** 连接未就绪时给出可见提示，避免玩家以为消息/出价已发出 */
  function ensureSocketReady(): boolean {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) return true;
    setError('实时连接已断开，正在自动重连，请稍后再试');
    reconnectNowRef.current();
    return false;
  }

  function requestComposerInput(insertText?: string) {
    composerInputRequestIdRef.current += 1;
    setComposerInputRequest({
      id: composerInputRequestIdRef.current,
      ...(insertText ? { insertText } : {}),
    });
  }

  function mentionPlayer(nickname: string) {
    const normalized = nickname.trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!normalized) return;
    requestComposerInput(`@${normalized} `);
  }

  function selectMessageReply(item: Extract<FeedItem, { kind: 'chat' }>) {
    setReplyTarget({
      messageId: item.id,
      nickname: item.name,
      content: item.text,
    });
    requestComposerInput();
  }

  /** 服务端回显/确认后才清空输入；拒绝、断线或超时均返回 false 并保留草稿。 */
  function sendChat(content: string): Promise<boolean> | false {
    if (!content) return false;
    if (!ensureSocketReady()) return false;
    if (pendingChatAckRef.current) return false;
    const selectedReply = activeReplyTarget;
    const pendingBet =
      !selectedReply && phase === 'BETTING'
        ? parsePendingBetCommand(content)
        : null;
    if (pendingBet && betPendingRef.current) return false;

    setError('');
    const requestId = createChatRequestId();
    return new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => {
        if (pendingChatAckRef.current?.requestId !== requestId) return;
        settlePendingChat(false);
        setError('服务器暂未确认，请检查网络后重试；输入内容已为您保留');
      }, 10_000);
      pendingChatAckRef.current = {
        requestId,
        content: content.trim(),
        ...(selectedReply ? { replyToMessageId: selectedReply.messageId } : {}),
        resolve,
        timer,
      };
      setChatSendPending(true);

      try {
        socketRef.current!.send(
          JSON.stringify({
            type: 'chat',
            content,
            requestId,
            ...(selectedReply ? { replyToId: selectedReply.messageId } : {}),
          }),
        );
        jumpToBottom();
      } catch {
        settlePendingChat(false);
        setError('发送失败，请检查网络后重试；输入内容已为您保留');
        return;
      }

      if (pendingBet) {
        betPendingRef.current = true;
        betPendingRequestIdRef.current = requestId;
        setBetPending(true);
        if (betPendingTimerRef.current !== null) {
          window.clearTimeout(betPendingTimerRef.current);
        }
        betPendingTimerRef.current = window.setTimeout(() => {
          if (betPendingRequestIdRef.current !== requestId) return;
          clearPendingBet();
          settlePendingChat(false);
          pushPrivateBetNotice({
            status: 'unknown',
            action: pendingBet.action,
            amountCents: pendingBet.amountCents,
            reason: '暂未收到服务器确认，请刷新核对后再操作，避免重复下注',
          });
        }, 10_000);
      }
    });
  }

  function leaveAndGoBack() {
    // 对局进行中且本人已参与（坐庄/已下注）时先确认，避免误触退出
    const activePhase =
      !!phase && !['WAITING', 'FINISHED', 'CANCELLED'].includes(phase);
    const involved = !!state?.me.isBanker || !!state?.me.bet;
    if (
      activePhase &&
      involved &&
      !window.confirm('对局进行中，离开不会撤销您的下注/坐庄。确定要离开吗？')
    ) {
      return;
    }
    if (roomId) void api.leaveRoom(roomId).catch(() => undefined);
    // 互动群属于「消息」会话：无论从大厅、规则页还是深链进入，都统一回消息列表。
    goToTab(navigate, 'chat');
  }

  function sendSticker(stickerId: string) {
    if (!ensureSocketReady()) return;
    socketRef.current!.send(
      JSON.stringify({
        type: 'sticker',
        stickerId,
        requestId: createChatRequestId(),
      }),
    );
    jumpToBottom();
  }

  function freezeCurrentFeedPosition() {
    stickToBottomRef.current = false;
    const el = streamRef.current;
    if (!el) return;
    feedViewportAnchorRef.current = captureFeedViewport(el, feedIdsRef.current);
    lastScrollTopRef.current = el.scrollTop;
    lastScrollHeightRef.current = el.scrollHeight;
  }

  function prepareRoomFeatureOpen() {
    const el = streamRef.current;
    if (el && roomFeatureScrollTopRef.current === null) {
      roomFeatureScrollTopRef.current = el.scrollTop;
    }
    freezeCurrentFeedPosition();
  }

  function openRoomFeature(
    feature: 'leaderboards' | 'rewards' | 'send-packet' | 'tip',
  ) {
    if (!roomId) return;
    setQuickActionsOpen(false);
    prepareRoomFeatureOpen();
    disposeChatInputFocus();
    navigate(`/game/${roomId}/${feature}`, {
      state: { backgroundLocation: location },
    });
  }

  function openPacketResult(opts: {
    packetId: string;
    kind: 'game' | 'group';
    greeting?: string;
    sender?: { name: string; avatar?: string | null };
    amountCents?: string;
    gone?: boolean;
  }) {
    if (!roomId || !opts.packetId) return;
    freezeCurrentFeedPosition();
    navigate(`/game/${roomId}/packets/${opts.packetId}?kind=${opts.kind}`, {
      state: { ...opts, backgroundLocation: location },
    });
  }

  function patchPacketDialog(
    packetId: string,
    patch: Partial<Omit<PacketDialogState, 'packetId'>>,
  ) {
    setPacketDialog((current) =>
      current?.packetId === packetId ? { ...current, ...patch } : current,
    );
  }

  /** 所有玩家红包先展示红包封面，再由用户明确选择领取或查看详情。 */
  async function openUserPacket(item: {
    packetId: string;
    greeting: string;
    name: string;
    avatar?: string | null;
    mine: boolean;
  }) {
    if (rpBusy) return;
    freezeCurrentFeedPosition();
    const { packetId } = item;
    const existing = packetClaimsRef.current[packetId];
    const sender = { name: item.name, avatar: item.avatar };
    setError('');
    setPacketDialog({
      packetId,
      kind: 'group',
      greeting: item.greeting,
      sender,
      status: existing === 'GONE' ? 'gone' : existing ? 'claimed' : 'loading',
      amountCents: existing && existing !== 'GONE' ? existing : undefined,
    });

    const applyDetail = (detail: GroupPacketDetail) => {
      packetDetailCacheRef.current[packetId] = detail;
      const ownClaim = detail.claims.find((claimEntry) => claimEntry.uid === myUid);
      const amountCents = ownClaim?.amountCents ?? (existing !== 'GONE' ? existing : undefined);
      if (ownClaim) {
        updatePacketClaims((prev) => ({ ...prev, [packetId]: ownClaim.amountCents }));
      }
      const gone =
        existing === 'GONE' || detail.remainingCount <= 0 || detail.status !== 'ACTIVE';
      patchPacketDialog(packetId, {
        status: amountCents ? 'claimed' : gone ? 'gone' : 'claimable',
        amountCents,
      });
    };

    const cached = packetDetailCacheRef.current[packetId];
    if (cached) {
      applyDetail(cached);
      return;
    }
    try {
      applyDetail(await api.groupPacket(packetId));
    } catch {
      patchPacketDialog(packetId, {
        status: existing === 'GONE' ? 'gone' : existing ? 'claimed' : 'claimable',
      });
    }
  }

  /** 牌局红包（包括 TNG）同样先展示封面，不再从聊天卡片直接跳转。 */
  async function openGamePacketDialog(
    packetId: string,
    greeting = GAME_PACKET_GREETING,
  ) {
    if (!packetId || rpBusy) return;
    freezeCurrentFeedPosition();
    setError('');

    const isCurrent = state?.round?.packetId === packetId;
    const currentPhase = isCurrent ? state?.round?.phase : undefined;
    const currentAmount = isCurrent ? state?.me.claimedAmountCents ?? undefined : undefined;
    const currentBanker = isCurrent ? state?.round?.banker : null;
    const initialSender = currentBanker
      ? { name: currentBanker.nickname, avatar: currentBanker.avatarUrl }
      : { name: ASSISTANT_NAME, avatar: ASSISTANT_AVATAR };
    const currentStatus: PacketDialogStatus = currentAmount
      ? 'claimed'
      : currentPhase === 'SENDING_PACKET'
        ? 'waiting'
        : currentPhase === 'CLAIMING' && state?.me.canClaim
          ? 'claimable'
          : currentPhase === 'CLAIMING'
            ? 'ineligible'
            : 'loading';

    setPacketDialog({
      packetId,
      kind: 'game',
      channel: isCurrent ? state?.round?.packetChannel : undefined,
      greeting,
      sender: initialSender,
      status: currentStatus,
      amountCents: currentAmount,
    });

    try {
      const detail = await api.gamePacket(packetId);
      const ownClaim = detail.claims.find((claimEntry) => claimEntry.uid === myUid);
      const amountCents = ownClaim?.amountCents ?? currentAmount;
      const expiresAtMs = detail.expiresAt ? Date.parse(detail.expiresAt) : Number.NaN;
      const expired = Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
      const claimOpen =
        detail.phase === 'CLAIMING' && detail.status === 'SENT' && !expired;
      const canClaim =
        detail.canClaim === true ||
        (detail.canClaim == null && isCurrent && state?.me.canClaim === true);
      const status: PacketDialogStatus = amountCents
        ? 'claimed'
        : detail.phase === 'SENDING_PACKET'
          ? 'waiting'
          : claimOpen && canClaim
            ? 'claimable'
            : claimOpen
              ? 'ineligible'
              : 'gone';
      patchPacketDialog(packetId, {
        channel: detail.channel,
        sender: detail.banker
          ? { name: detail.banker.nickname, avatar: detail.banker.avatarUrl }
          : initialSender,
        status,
        amountCents,
      });
      if (!isCurrent && (detail.phase === 'SENDING_PACKET' || detail.phase === 'CLAIMING')) {
        void refresh().catch(() => undefined);
      }
    } catch {
      patchPacketDialog(packetId, {
        status: currentStatus === 'loading' ? 'error' : currentStatus,
        error:
          currentStatus === 'loading'
            ? '红包状态暂时没有同步成功，请点击重试'
            : undefined,
      });
    }
  }

  async function claimDialogPacket() {
    const dialog = packetDialog;
    if (!dialog || rpBusy) return;
    if (dialog.status === 'external' && dialog.externalUrl) {
      openExternalLink(dialog.externalUrl);
      return;
    }
    if (dialog.status !== 'claimable' && dialog.status !== 'error') return;

    const { packetId } = dialog;
    setRpBusy(true);
    setError('');
    patchPacketDialog(packetId, { status: 'opening', error: undefined });
    const openingAnimation = waitForRedPacketOpeningAnimation();

    try {
      if (dialog.kind === 'group') {
        const result = await api.claimGroupPacket(packetId);
        await openingAnimation;
        updatePacketClaims((prev) => ({ ...prev, [packetId]: result.amountCents }));
        patchPacketDialog(packetId, {
          status: 'claimed',
          amountCents: result.amountCents,
        });
        void api.groupPacket(packetId).then((detail) => {
          packetDetailCacheRef.current[packetId] = detail;
        }).catch(() => undefined);
        return;
      }

      const result = await api.claimPacket(packetId);
      await openingAnimation;
      if (result.url) {
        patchPacketDialog(packetId, {
          channel: 'TNG',
          status: 'external',
          externalUrl: result.url,
        });
        openExternalLink(result.url);
        return;
      }

      const claimedAmount = result.amountCents;
      if (!claimedAmount) throw new Error('红包领取结果异常，请重试');
      patchPacketDialog(packetId, {
        channel: 'INTERNAL',
        status: 'claimed',
        amountCents: claimedAmount,
      });
      startTransition(() => {
        setState((current) =>
          current?.round?.packetId === packetId
            ? {
                ...current,
                me: {
                  ...current.me,
                  canClaim: false,
                  claimedAmountCents: claimedAmount,
                },
              }
            : current,
        );
      });
      void refresh().catch(() => undefined);
    } catch (claimError) {
      await openingAnimation;
      const code =
        (claimError as { code?: string }).code ?? (claimError as Error).message;
      if (dialog.kind === 'group' && code === 'ALREADY_CLAIMED') {
        const detail = await api.groupPacket(packetId).catch(() => null);
        const ownClaim = detail?.claims.find((entry) => entry.uid === myUid);
        if (detail) packetDetailCacheRef.current[packetId] = detail;
        if (ownClaim) {
          updatePacketClaims((prev) => ({ ...prev, [packetId]: ownClaim.amountCents }));
        }
        patchPacketDialog(packetId, {
          status: ownClaim ? 'claimed' : 'gone',
          amountCents: ownClaim?.amountCents,
        });
        return;
      }
      if (dialog.kind === 'game' && code === 'ALREADY_CLAIMED') {
        const detail: GamePacketDetail | null = await api.gamePacket(packetId).catch(() => null);
        const ownClaim = detail?.claims.find((entry) => entry.uid === myUid);
        patchPacketDialog(packetId, {
          channel: detail?.channel ?? dialog.channel,
          sender: detail?.banker
            ? { name: detail.banker.nickname, avatar: detail.banker.avatarUrl }
            : dialog.sender,
          status: ownClaim ? 'claimed' : 'gone',
          amountCents: ownClaim?.amountCents,
        });
        return;
      }
      if (code === 'PACKET_EMPTY' || code === 'PACKET_EXPIRED') {
        if (dialog.kind === 'group') {
          updatePacketClaims((prev) => ({ ...prev, [packetId]: 'GONE' }));
        }
        patchPacketDialog(packetId, { status: 'gone', amountCents: undefined });
        return;
      }
      if (
        code === 'NOT_ELIGIBLE_TO_CLAIM' ||
        String((claimError as Error).message).includes('NOT_ELIGIBLE')
      ) {
        patchPacketDialog(packetId, { status: 'ineligible' });
        return;
      }
      patchPacketDialog(packetId, {
        status: 'error',
        error: packetErrorText(claimError),
      });
    } finally {
      setRpBusy(false);
    }
  }

  function viewPacketDialogDetails() {
    if (!packetDialog) return;
    const detail = packetDialog;
    setPacketDialog(null);
    openPacketResult({
      packetId: detail.packetId,
      kind: detail.kind,
      greeting: detail.greeting,
      sender: detail.sender,
      amountCents: detail.amountCents,
      gone: detail.status === 'gone' && !detail.amountCents,
    });
  }

  const canBid = phase === 'BANKER_BID' && !bidWindowClosed;
  const canBet = phase === 'BETTING' && !state?.me.isBanker;
  const ownMentionTokens = useMemo(
    () =>
      collectOwnMentionTokens({
        uid: myUid || session.uid,
        nickname: myProfile?.nickname || session.nickname,
      }),
    [myUid, myProfile?.nickname, session.uid, session.nickname],
  );
  const memberChatMuted =
    state?.me.chatMute?.active === true
    && (
      !state.me.chatMute.mutedUntil
      || !memberMuteDeadlineReached
    );
  const canThrowDice =
    phase === 'SENDING_PACKET'
    && !!state?.me.isBanker
    && !state?.round?.diceThrown
    && !state?.round?.diceStarted
    && diceWindowOpen
    && !diceSent;
  const muteAllowsGameCommand =
    canBid
    || canBet
    || canThrowDice
    || (repostWindowOpen && state?.me.isBanker === true);
  const displayedMutedStage: MutedChatStage =
    mutedChatStage
    ?? (
      phase === 'BANKER_BID' || phase === 'BETTING'
        ? 'STARTING'
        : phase === 'WAITING' || phase === 'FINISHED' || phase === 'CANCELLED'
          ? 'NEXT_ROUND'
          : 'STARTING'
    );
  const stageLockDetail =
    displayedMutedStage === 'DICE'
      ? repostWindowOpen
        ? state?.me.isBanker
          ? '不重推可等待倒计时结束；发送「重推」将取消本局并原路退款'
          : '等待庄家确认是否重推本局'
        : canThrowDice
          ? '请在倒计时内投骰，三颗骰子将依次同步到群内'
          : diceWindowTimedOut
            ? '投骰已超时，系统正在取消本局并原路退款'
            : packetDiceDone
              ? '庄家已完成投骰，系统正在发送本局红包'
              : '等待本局庄家完成投骰'
      : displayedMutedStage === 'CLAIMING'
        ? state?.me.isBanker || state?.me.bet || state?.me.canClaim
          ? '请先完成本局红包领取，抢包结束后继续流程'
          : '您未参与本局，请等待抢包结束'
        : displayedMutedStage === 'SETTLING'
          ? phase === 'CLAIM_EXPIRED'
            ? '系统正在核对本局红包领取结果'
            : '系统正在计算并发布本局成绩'
          : CHAT_STAGE_COPY[displayedMutedStage].detail;

  function sendDice() {
    if (
      phase !== 'SENDING_PACKET' ||
      !state?.me.isBanker ||
      state?.round?.diceThrown ||
      state?.round?.diceStarted ||
      !diceWindowOpen ||
      diceSent
    ) {
      return;
    }
    if (!ensureSocketReady()) return;
    socketRef.current!.send(
      JSON.stringify({ type: 'dice', requestId: createChatRequestId() }),
    );
    setDiceSent(true);
    jumpToBottom();
  }

  const bankerCanRepostByChat =
    repostWindowOpen && state?.me.isBanker === true && !roomGloballyMuted;
  const composerUnavailable = loading || !state || connState !== 'online';
  const canUseChatGestures =
    !roomGloballyMuted
    && !chatMuted
    && !memberChatMuted
    && !composerUnavailable;
  const activeReplyTarget = canUseChatGestures ? replyTarget : null;
  const composerControlsHidden =
    composerUnavailable
    || roomGloballyMuted
    || (chatMuted && !bankerCanRepostByChat)
    || bidWindowClosed
    || (memberChatMuted && !muteAllowsGameCommand);
  const composerHint =
    loading || !state
      ? '正在进入互动群'
      : connState !== 'online'
        ? null
        : roomGloballyMuted
          ? '互动群已禁言'
          : bankerCanRepostByChat
            ? '倒计时内发送「重推」即可取消本局并原路退款'
          : bidWindowClosed
            ? '竞标最终确认 · 暂不可发言'
            : memberChatMuted && !muteAllowsGameCommand
              ? '您当前已被禁言'
              : null;

  return (
    <div
      ref={roomRootRef}
      className="game-room"
      aria-hidden={freezeFeed ? true : undefined}
    >
      <div className="game-room-top">
        <header className="game-room-header">
          <button className="chat-back" type="button" onClick={leaveAndGoBack} aria-label="返回">
            ‹
          </button>
          <div className="game-room-title">
            <strong>
              {state?.room.interactionGroupTitle ?? state?.room.title ?? '至尊牛牛互动群'}
            </strong>
            <small className={connState === 'online' ? undefined : 'offline'}>
              <i />
              {connState === 'online'
                ? '互动中'
                : connState === 'connecting'
                  ? '连接中…'
                  : connState === 'kicked'
                    ? '已断开'
                    : '重连中…'}
            </small>
          </div>
          <div className="game-room-header-actions" aria-label="牌桌操作">
            <button
              className={`game-room-refresh${refreshing ? ' refreshing' : ''}`}
              type="button"
              onClick={() => void refreshRoomManually()}
              disabled={refreshing}
              aria-busy={refreshing}
              aria-label="刷新牌桌"
              title="刷新"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7" />
              </svg>
            </button>
          </div>
        </header>

        {channelPreview && (
          <button
            type="button"
            className="game-room-channel"
            onClick={() => setChannelOpen(true)}
          >
            <span className="game-room-channel-tag">
              通告{channelNotices.length > 1 ? ` ${channelNotices.length}` : ''}
            </span>
            <span className="game-room-channel-text">
              <b>{channelPreview.title}</b>
              <em>{channelPreview.body.replace(/\s+/g, ' ')}</em>
            </span>
            <i aria-hidden>›</i>
          </button>
        )}

        <div className="game-room-phase">
          <div className="game-room-phase-main">
            <div className="game-room-phase-row">
              <span className="phase-pill">{phaseLabel}</span>
              <span className="game-room-status-meta">
                {state?.config.autoTailPacketEnabled ? '自动认尾包' : '认尾包关闭'}
                <i aria-hidden>·</i>
                24h {state?.me.playedRounds24h ?? 0} 局
              </span>
            </div>
            <p>{phaseHint}</p>
          </div>
          <div className="game-room-phase-timer">
            <b>{phaseAside.value}</b>
            <em>{phaseAside.label}</em>
          </div>
        </div>
      </div>

      <div className={`game-room-feed-shell${stakeStrip || canBid ? ' has-stake-strip' : ''}`}>
        {tipNotice && (
          <div className="room-tip-danmaku-stage" aria-live="polite">
            <div className="room-tip-danmaku" role="status" key={tipNotice.id}>
              <span className="room-tip-danmaku-avatar" aria-hidden>
                {tipNotice.avatarUrl ? (
                  <img src={tipNotice.avatarUrl} alt="" />
                ) : (
                  <b>{(tipNotice.nickname || '?').slice(0, 1)}</b>
                )}
                <i>♥</i>
              </span>
              <span className="room-tip-danmaku-copy">
                <strong>
                  <b>{tipNotice.nickname}</b>
                  <span>打赏客服小妹</span>
                </strong>
                <small>{tipNotice.message || '感谢这份心意'}</small>
              </span>
              <em>
                <b>{rm(tipNotice.amountCents)}</b>
              </em>
              <span className="room-tip-danmaku-glint" aria-hidden />
            </div>
          </div>
        )}
        {historyControlVisible && (
          historyLoading ? (
            <div className="feed-history-control is-loading" role="status">
              正在加载更早消息…
            </div>
          ) : historyHasMore ? (
            <button
              className={`feed-history-control is-button${historyLoadFailed ? ' failed' : ''}`}
              type="button"
              onClick={requestOlderHistory}
              aria-controls="room-message-feed"
            >
              {historyLoadFailed ? '重试加载更早消息' : '查看更早消息'}
            </button>
          ) : null
        )}
        <nav
          className={`game-room-quick-actions${quickActionsOpen ? ' is-open' : ''}${
            quickActionsDocked && !quickActionsOpen ? ' is-docked' : ''
          }`}
          aria-label="房间快捷入口"
          onKeyDown={(event) => {
            if (event.key === 'Escape') setQuickActionsOpen(false);
          }}
        >
          {quickActionsOpen && (
            <div className="game-room-quick-menu" id="room-quick-menu">
              <button
                className="game-room-quick-link leaderboard"
                type="button"
                onPointerDown={prepareRoomFeatureOpen}
                onClick={() => openRoomFeature('leaderboards')}
                aria-label="打开排行榜"
              >
                <img
                  src={LEADERBOARD_EMBLEM}
                  width="44"
                  height="44"
                  alt=""
                  aria-hidden="true"
                />
                <span>榜单</span>
              </button>
              <button
                className="game-room-quick-link rewards"
                type="button"
                onPointerDown={prepareRoomFeatureOpen}
                onClick={() => openRoomFeature('rewards')}
                aria-label="打开每日奖励"
              >
                <img
                  src={REWARDS_EMBLEM}
                  width="44"
                  height="44"
                  alt=""
                  aria-hidden="true"
                />
                <span>奖励</span>
              </button>
            </div>
          )}
          <button
            className="game-room-quick-toggle"
            type="button"
            aria-expanded={quickActionsOpen}
            aria-controls="room-quick-menu"
            aria-label={
              quickActionsDocked && !quickActionsOpen
                ? '呼出任务入口'
                : quickActionsOpen
                  ? '收起任务入口'
                  : '展开任务入口'
            }
            onClick={() => {
              if (quickActionsDocked && !quickActionsOpen) {
                setQuickActionsDocked(false);
                return;
              }
              setQuickActionsOpen((open) => !open);
            }}
          >
            <svg
              className={
                quickActionsDocked && !quickActionsOpen
                  ? 'is-peek'
                  : quickActionsOpen
                    ? 'is-collapse'
                    : 'is-gift'
              }
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              {quickActionsDocked && !quickActionsOpen ? (
                <path d="M14.75 5.75 8.5 12l6.25 6.25" />
              ) : quickActionsOpen ? (
                <>
                  <path d="M6.5 5.5 13 12l-6.5 6.5" />
                  <path d="M11.5 5.5 18 12l-6.5 6.5" />
                </>
              ) : (
                <>
                  <path d="M4.25 10.25h15.5v10H4.25z" />
                  <path d="M3.25 7h17.5v4.25H3.25z" />
                  <path d="M12 7v13.25" />
                  <path d="M11.85 6.9H8.7A2.45 2.45 0 1 1 11 3.65l1 3.25Z" />
                  <path d="M12.15 6.9h3.15A2.45 2.45 0 1 0 13 3.65l-1 3.25Z" />
                </>
              )}
            </svg>
            <span>{quickActionsOpen ? '收起' : '任务'}</span>
          </button>
        </nav>

        <div
          id="room-message-feed"
          className={`game-room-feed${!loading && state ? ' has-quick-actions' : ''}`}
          ref={streamRef}
          role="region"
          aria-label="互动群消息记录"
          tabIndex={0}
        >
          {loading && (
            <div className="feed-entry-skeleton" role="status" aria-label="正在进入互动群">
              <div className="feed-entry-skeleton-title">正在进入互动群…</div>
              <i /><i /><i /><i />
            </div>
          )}
          {!loading && !state && (
            <div className="feed-entry-error" role="alert">
              <strong>暂时无法进入互动群</strong>
              <p>{error || '网络连接没有完成，请重试。'}</p>
              <button type="button" onClick={retryEntry}>重新进入</button>
            </div>
          )}
          {!loading &&
            state &&
            feed.map((item) => {
            if (item.kind === 'system') {
              return (
                <div className="feed-assistant" key={item.id}>
                  <img className="feed-assistant-avatar" src={ASSISTANT_AVATAR} alt="" aria-hidden />
                  <div className="feed-assistant-body">
                    <div className="feed-assistant-name">{ASSISTANT_NAME}</div>
                    <div className="feed-assistant-bubble">
                      <AssistantCopy text={item.text} ownTokens={ownMentionTokens} />
                      {item.time && <time>{item.time}</time>}
                    </div>
                  </div>
                </div>
              );
            }
            if (item.kind === 'countdown') {
              return (
                <div className="feed-assistant" key={item.id}>
                  <img className="feed-assistant-avatar" src={ASSISTANT_AVATAR} alt="" aria-hidden />
                  <div className="feed-assistant-body">
                    <div className="feed-assistant-name">{ASSISTANT_NAME}</div>
                    <div
                      className={`feed-assistant-bubble${item.lockText ? ' countdown-lock' : ' countdown-live'}`}
                    >
                      {item.lockText ? (
                        <p className="countdown-lock-text" aria-live="polite">
                          {item.lockText}
                        </p>
                      ) : (
                        <p aria-live="polite">
                          <RemainingCopy
                            endsAt={item.endsAt}
                            afterEndsAt={item.afterEndsAt}
                            mode={item.mode}
                            template={item.template ?? ''}
                            afterTemplate={item.afterTemplate}
                          />
                        </p>
                      )}
                      {item.time && <time>{item.time}</time>}
                    </div>
                  </div>
                </div>
              );
            }
            if (item.kind === 'banner') {
              return (
                <div className="feed-chat theirs feed-phase-sticker-row" key={item.id}>
                  <img className="feed-assistant-avatar" src={ASSISTANT_AVATAR} alt="" aria-hidden />
                  <div className="feed-chat-body">
                    <div className="feed-chat-name">{ASSISTANT_NAME}</div>
                    <img
                      className="feed-phase-sticker"
                      src={item.image}
                      alt={item.alt}
                      loading="lazy"
                    />
                  </div>
                </div>
              );
            }
            if (item.kind === 'dice') {
              const play = animatedDiceIds[item.id] ?? item.id.startsWith('demo-');
              return (
                <div className={`feed-chat ${item.mine ? 'mine' : 'theirs'}`} key={item.id}>
                  {!item.mine && <ChatAvatar url={item.avatar} name={item.name} />}
                  <div className="feed-chat-body">
                    {!item.mine && <div className="feed-chat-name">{item.name}</div>}
                    <div className="feed-dice-bubble">
                      <SequentialDice values={item.values} animate={play} />
                    </div>
                  </div>
                </div>
              );
            }
            if (item.kind === 'sticker') {
              return (
                <div className={`feed-chat ${item.mine ? 'mine' : 'theirs'}`} key={item.id}>
                  {!item.mine && <ChatAvatar url={item.avatar} name={item.name} />}
                  <div className="feed-chat-body">
                    {!item.mine && <div className="feed-chat-name">{item.name}</div>}
                    <img className="feed-sticker" src={item.url} alt="贴纸" loading="lazy" />
                  </div>
                </div>
              );
            }
            if (item.kind === 'userPacket') {
              const claimed = packetClaims[item.packetId];
              const gone = claimed === 'GONE';
              const opened = !!claimed && !gone;
              const isDemo = !!item.demo;
              return (
                <div className={`feed-chat ${item.mine ? 'mine' : 'theirs'}`} key={item.id}>
                  {!item.mine && <ChatAvatar url={item.avatar} name={item.name} />}
                  <div className="feed-chat-body">
                    {!item.mine && (
                      <div className="feed-chat-name">
                        {item.name}
                        {item.administrator && <em className="game-admin-badge">管理员</em>}
                      </div>
                    )}
                    <button
                      type="button"
                      className={`wx-rp ${item.administrator ? 'wx-rp-admin' : 'wx-rp-standard'}`}
                      onClick={() => {
                        if (isDemo) return;
                        void openUserPacket({
                          packetId: item.packetId,
                          greeting: item.greeting,
                          name: item.name,
                          avatar: item.avatar,
                          mine: item.mine,
                        });
                      }}
                      disabled={isDemo || rpBusy}
                    >
                      <div className="wx-rp-body">
                        <span className="wx-rp-icon" aria-hidden />
                        <div className="wx-rp-copy">
                          <strong>{item.greeting}</strong>
                          <small>
                            {isDemo
                              ? '演示红包'
                              : opened
                                ? `已领取 RM ${rm(claimed!)} · 点击查看`
                                : gone
                                  ? '点击查看红包'
                                  : '点击打开红包'}
                          </small>
                        </div>
                      </div>
                      <div className="wx-rp-foot">
                        <span className="wx-rp-brand">
                          {item.administrator ? '管理员福利红包' : '普通红包'}
                        </span>
                      </div>
                    </button>
                  </div>
                </div>
              );
            }
            if (item.kind === 'userTip') {
              return (
                <div className={`feed-chat ${item.mine ? 'mine' : 'theirs'}`} key={item.id}>
                  {!item.mine && <ChatAvatar url={item.avatar} name={item.name} />}
                  <div className="feed-chat-body">
                    {!item.mine && <div className="feed-chat-name">{item.name}</div>}
                    <div
                      className={`wx-transfer ${item.mine ? 'mine' : 'theirs'}`}
                      aria-label="转账给客服"
                    >
                      <div className="wx-transfer-body">
                        <span className="wx-transfer-mark" aria-hidden>
                          <TransferSwapIcon />
                        </span>
                        <div className="wx-transfer-copy">
                          <strong>{rm(item.amountCents)}</strong>
                          <small>{item.message}</small>
                        </div>
                      </div>
                      <div className="wx-transfer-foot">转账给{item.label}</div>
                    </div>
                    {item.time && (
                      <time className="feed-transfer-time">{item.time}</time>
                    )}
                  </div>
                </div>
              );
            }
            if (item.kind === 'chat') {
              return (
                <div className={`feed-chat ${item.mine ? 'mine' : 'theirs'}`} key={item.id}>
                  {!item.mine && (
                    <ChatAvatar
                      url={item.avatar}
                      name={item.name}
                      onLongPress={
                        canUseChatGestures
                          ? () => mentionPlayer(item.name)
                          : undefined
                      }
                    />
                  )}
                  <div className="feed-chat-body">
                    {!item.mine && (
                      <div className="feed-chat-name">
                        {item.name}
                        {item.administrator && (
                          <em className="game-admin-badge">管理员</em>
                        )}
                      </div>
                    )}
                    <LongPressSurface
                      className={`feed-chat-bubble ${item.emoji ? 'emoji' : ''}`}
                      ariaLabel={`来自${item.name}的消息，长按回复`}
                      onLongPress={
                        !item.mine && canUseChatGestures
                          ? () => selectMessageReply(item)
                          : undefined
                      }
                    >
                      {item.replyTo && (
                        <div className="feed-chat-reply">
                          <strong>回复 {item.replyTo.nickname}</strong>
                          <span>{item.replyTo.content}</span>
                        </div>
                      )}
                      <AssistantCopy text={item.text} ownTokens={ownMentionTokens} />
                      {item.time && <time>{item.time}</time>}
                    </LongPressSurface>
                  </div>
                </div>
              );
            }
            if (item.kind === 'packet') {
              const senderName = ASSISTANT_NAME;
              const interactive = !!item.asChat && !item.demo;
              return (
                <div className="feed-chat theirs" key={item.id}>
                  <ChatAvatar url={ASSISTANT_AVATAR} name={senderName} />
                  <div className="feed-chat-body">
                    <div className="feed-chat-name">{senderName}</div>
                    {interactive ? (
                      <button
                        type="button"
                        className="wx-rp wx-rp-niuniu"
                        disabled={busy || rpBusy || !item.packetId}
                        onClick={() =>
                          item.packetId
                            ? void openGamePacketDialog(item.packetId, item.title)
                            : undefined
                        }
                      >
                        <div className="wx-rp-body">
                          <span className="wx-rp-icon" aria-hidden />
                          <div className="wx-rp-copy">
                            <strong>{item.title}</strong>
                            <small>
                              {item.claimable ? (
                                <PacketSubtitle
                                  subtitle={item.subtitle}
                                  endsAt={item.endsAt}
                                  staticSeconds={item.staticSeconds}
                                />
                              ) : (
                                item.subtitle
                              )}
                            </small>
                          </div>
                        </div>
                        <div className="wx-rp-foot">
                          <span className="wx-rp-brand">牛牛红包</span>
                        </div>
                      </button>
                    ) : (
                      <div className="wx-rp wx-rp-niuniu">
                        <div className="wx-rp-body">
                          <span className="wx-rp-icon" aria-hidden />
                          <div className="wx-rp-copy">
                            <strong>{item.title}</strong>
                            <small>{item.subtitle}</small>
                          </div>
                        </div>
                        <div className="wx-rp-foot">
                          <span className="wx-rp-brand">牛牛红包</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            }
            return null;
            })}
        </div>

        {stakeStrip && (
          <StakeStatusBar
            key={
              stakeStrip.variant === 'progress'
                ? `progress:${stakeStrip.roundId}`
                : 'alert'
            }
            strip={stakeStrip}
            visibleCount={
              stakeStrip.variant === 'progress' ? Math.max(1, stakeVisibleCount) : undefined
            }
            onClose={dismissPrivateBetNotice}
          />
        )}
        {newBelow && (
          <button
            type="button"
            className="feed-jump-latest"
            onClick={jumpToBottom}
          >
            ↓ 有新消息
          </button>
        )}
      </div>

      <div className={`game-room-footer${stakeStrip ? ' has-stake-strip' : ''}`}>
        {state && connState !== 'online' && (
          <div className={`room-connection-bar ${connState}`} role="status">
            <span>
              {connState === 'kicked'
                ? '实时连接已断开'
                : connState === 'connecting'
                  ? '正在连接实时群聊，暂时不能发送'
                  : '网络不稳定，正在恢复实时连接'}
            </span>
            <button
              type="button"
              onClick={
                connState === 'kicked'
                  ? retryEntry
                  : () => reconnectNowRef.current()
              }
            >
              {connState === 'kicked' ? '重新进入' : '立即重连'}
            </button>
          </div>
        )}
        {state && error && (
          <div className="chat-error-bar" role="alert">
            <span>{error}</span>
            <button type="button" aria-label="关闭提示" onClick={() => setError('')}>×</button>
          </div>
        )}

        {roomGloballyMuted ? (
          <div
            className="room-chat-lock-state room-global-mute-state"
            role="status"
            aria-live="polite"
          >
            互动群已禁言
          </div>
        ) : continuationActive && continuation ? (
          <ContinuationGate
            deadline={continuation.deadline}
            mine={continuation.mine}
            busy={busy}
            onConfirm={() =>
              void runAction(() => api.continueBanker(roomId, continuation.previousRoundId))
            }
          />
        ) : chatMuted && !bankerCanRepostByChat ? (
          <StageLockPanel stage={displayedMutedStage} detail={stageLockDetail}>
            {canThrowDice ? (
              <button
                className="stage-control-button dice"
                type="button"
                disabled={diceSent || connState !== 'online'}
                onClick={sendDice}
              >
                <span>{diceSent ? '投骰已发送…' : '投骰开包'}</span>
                <small>三颗骰子将依次同步到群内</small>
              </button>
            ) : null}
          </StageLockPanel>
        ) : (
          <>
          {memberChatMuted && !composerControlsHidden && (
          <div className="room-member-mute-bar" role="status">
            <span className="room-member-mute-icon">禁</span>
            <span>
              <strong>
                {state?.me.chatMute?.mutedUntil
                  ? `禁言至 ${new Date(state.me.chatMute.mutedUntil).toLocaleString('zh-MY', {
                      timeZone: 'Asia/Kuala_Lumpur',
                      hour12: false,
                    })}`
                  : '已被永久禁言'}
              </strong>
              <small>
                {state?.me.chatMute?.reason || '管理员未填写原因'}
                {muteAllowsGameCommand ? ' · 游戏指令仍可使用' : ''}
              </small>
            </span>
          </div>
        )}

        {composerHint && (
          <div className="room-chat-lock-state" role="status" aria-live="polite">
            {composerHint}
          </div>
        )}

        {!composerControlsHidden && (
          <ChatComposer
            onSend={sendChat}
            disabled={composerControlsHidden}
            busy={betPending || chatSendPending}
            placeholder={bankerCanRepostByChat ? '发送 重推 取消本局并退款' : ''}
            amountMode={activeReplyTarget ? null : canBid ? 'bid' : canBet ? 'bet' : null}
            bidHighCents={
              canBid && state?.round?.topBids?.[0]
                ? Number(state.round.topBids[0].amountCents)
                : null
            }
            myBidCents={
              canBid && state?.me.bidCents ? Number(state.me.bidCents) : null
            }
            bidTopIsMine={
              canBid
              && !!state?.round?.topBids?.[0]
              && state.round.topBids[0].uid === (myUid || session.uid)
            }
            restrictedToGameCommands={memberChatMuted}
            inputRequest={composerInputRequest ?? undefined}
            replyPreview={activeReplyTarget}
            onCancelReply={() => setReplyTarget(null)}
            stickers={stickers}
            onSendSticker={sendSticker}
            plusActions={[
              {
                key: 'packet',
                icon: <RedPacketIcon />,
                iconClass: 'packet filled',
                label: '发红包',
                onClick: () => openRoomFeature('send-packet'),
              },
              {
                key: 'tip',
                icon: <TransferIcon />,
                iconClass: 'tip filled',
                label: '打赏',
                onClick: () => openRoomFeature('tip'),
              },
              {
                key: 'history',
                icon: <MyHistoryIcon />,
                iconClass: 'history filled',
                label: '我的战绩',
                onClick: () => {
                  freezeCurrentFeedPosition();
                  setHistoryOpen(true);
                },
              },
            ]}
          />
        )}
          </>
        )}
      </div>

      {channelOpen &&
        createPortal(
          <div className="channel-sheet" role="dialog" aria-modal="true" aria-label="通道通告">
            <button
              type="button"
              className="channel-sheet-backdrop"
              aria-label="关闭"
              onClick={() => setChannelOpen(false)}
            />
            <div className="channel-sheet-panel">
              <div className="channel-sheet-handle" aria-hidden />
              <header className="channel-sheet-head">
                <div>
                  <small>通道</small>
                  <strong>群内通告</strong>
                </div>
                <button type="button" onClick={() => setChannelOpen(false)} aria-label="关闭">
                  ×
                </button>
              </header>
              <div className="channel-sheet-list">
                {channelNotices.map((notice) => (
                  <article className="channel-sheet-card" key={notice.id}>
                    <span>通告</span>
                    <strong>{notice.title}</strong>
                    <p>{notice.body}</p>
                  </article>
                ))}
              </div>
            </div>
          </div>,
          document.body,
        )}

      {historyOpen && roomId && (
        <MyHistorySheet roomId={roomId} onClose={() => setHistoryOpen(false)} />
      )}

      {packetDialog &&
        createPortal(
          <RedPacketDialog
            data={packetDialog}
            busy={rpBusy}
            onClose={() => {
              if (!rpBusy) setPacketDialog(null);
            }}
            onClaim={() => void claimDialogPacket()}
            onDetails={viewPacketDialogDetails}
          />,
          document.body,
        )}
    </div>
  );
}

function stakeSegmentText(segment: StakeSegment): string {
  if (segment.kind === 'stake') {
    return `${segment.isAllIn ? '梭哈' : '下注'}：${rm(segment.amountCents)}`;
  }
  if (segment.kind === 'claim') {
    return `抢：${rm(segment.amountCents)}`;
  }
  return `${segment.label}：${rm(segment.amountCents)}`;
}

function stakeSegmentTone(segment: StakeSegment): string {
  if (segment.kind === 'claim') return 'claim';
  if (segment.kind === 'result') {
    return segment.label === '赢' ? 'win' : segment.label === '输' ? 'lose' : 'tie';
  }
  return segment.isAllIn ? 'success all-in' : 'success';
}

function StakeStatusBar({
  strip,
  visibleCount,
  onClose,
}: {
  strip: StakeStrip;
  visibleCount?: number;
  onClose: () => void;
}) {
  const shown =
    strip.variant === 'progress'
      ? strip.segments.slice(
          0,
          Math.min(
            strip.segments.length,
            Math.max(0, visibleCount ?? strip.segments.length),
          ),
        )
      : [];
  const newestIndex = shown.length - 1;

  if (strip.variant === 'alert') {
    const notice = strip.notice;
    const unknown = notice.status === 'unknown';
    const actionName = notice.action === 'all_in' ? '梭哈' : '下注';
    const title = unknown ? '确认超时' : `${actionName}失败`;
    const detail = notice.reason || (unknown ? '请刷新后再核对' : '操作未完成');
    return (
      <div
        className={`bet-result-toast ${notice.status}`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <p>
          {title}：{rm(notice.amountCents)}
          {detail ? ` · ${detail}` : ''}
        </p>
        <button type="button" className="bet-result-toast-close" aria-label="关闭" onClick={onClose}>
          ×
        </button>
      </div>
    );
  }

  if (shown.length === 0) return null;

  return (
    <div
      className="bet-result-toast progress"
      role="status"
      aria-live="polite"
    >
      {shown.map((segment, index) => {
        const isNew = index === newestIndex && shown.length > 1;
        return (
          <Fragment key={segment.kind}>
            {index > 0 && (
              <span
                className={`bet-result-toast-dot${isNew ? ' is-new' : ''}`}
                aria-hidden
              >
                ·
              </span>
            )}
            <span
              className={`bet-result-toast-seg ${stakeSegmentTone(segment)}${isNew ? ' is-new' : ''}`}
            >
              {stakeSegmentText(segment)}
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

function RedPacketSenderAvatar({
  url,
  name,
}: {
  url?: string | null;
  name: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="wx-rp-sender-avatar" aria-hidden>
      <b>{(name || '玩').slice(0, 1)}</b>
      {url && !failed ? (
        <img src={url} alt="" onError={() => setFailed(true)} />
      ) : null}
    </span>
  );
}

function RedPacketDialog({
  data,
  busy,
  onClose,
  onClaim,
  onDetails,
}: {
  data: PacketDialogState;
  busy: boolean;
  onClose: () => void;
  onClaim: () => void;
  onDetails: () => void;
}) {
  const isTng = data.channel === 'TNG';
  const opening = data.status === 'opening';
  const pending = data.status === 'loading' || data.status === 'opening';
  const canClaim = data.status === 'claimable';

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [busy, onClose]);

  let statusTitle = '';
  let statusHint = '';
  if (data.status === 'loading') {
    statusTitle = '正在查看红包';
    statusHint = '请稍候…';
  } else if (data.status === 'opening') {
    statusTitle = isTng ? '正在打开 TNG 红包' : '正在拆红包';
    statusHint = isTng ? '即将前往 TNG 领取' : '好运正在赶来…';
  } else if (data.status === 'claimed') {
    statusTitle = `RM ${rm(data.amountCents ?? '0')}`;
    statusHint = '已领取，可查看领取详情';
  } else if (data.status === 'gone') {
    statusTitle = '手慢了，红包已抢完';
    statusHint = '可以查看大家的领取记录';
  } else if (data.status === 'waiting') {
    statusTitle = '红包还未开抢';
    statusHint = '开始抢包后即可领取';
  } else if (data.status === 'ineligible') {
    statusTitle = '本局红包仅限参与玩家';
    statusHint = '庄家与已下注闲家可领取';
  } else if (data.status === 'external') {
    statusTitle = 'TNG 红包已打开';
    statusHint = '请在 TNG 页面完成领取';
  } else if (data.status === 'error') {
    statusTitle = '红包打开失败';
    statusHint = data.error || '请稍后重试';
  }

  return (
    <div
      className="wx-rp-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="红包"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="wx-rp-dialog-stack">
        <section className={`wx-rp-dialog-panel status-${data.status}`}>
          <div className="wx-rp-dialog-flap" aria-hidden />
          <header className="wx-rp-dialog-sender">
            <span>
              <RedPacketSenderAvatar url={data.sender.avatar} name={data.sender.name} />
              <b>{data.sender.name}</b>
              发出的{data.kind === 'game' ? '牛牛红包' : '红包'}
            </span>
            {isTng && <em>TNG</em>}
          </header>

          <div className="wx-rp-dialog-content" aria-live="polite">
            {canClaim || opening ? (
              <>
                <strong className={`wx-rp-dialog-greeting${opening ? ' is-opening' : ''}`}>
                  {data.greeting}
                </strong>
                <span className={`wx-rp-dialog-open-stage${opening ? ' is-opening' : ''}`}>
                  <button
                    type="button"
                    className={`wx-rp-dialog-open${opening ? ' is-opening' : ''}`}
                    onClick={onClaim}
                    disabled={busy || opening}
                    aria-busy={opening || undefined}
                    aria-label={
                      opening
                        ? '正在打开红包'
                        : isTng
                          ? '打开并前往 TNG 领取'
                          : '打开红包'
                    }
                  >
                    <span>開</span>
                  </button>
                </span>
                <small>
                  {opening
                    ? statusHint
                    : isTng
                      ? '点击后前往 TNG 领取'
                      : '点击開字领取红包'}
                </small>
              </>
            ) : (
              <>
                {data.status === 'loading' && <span className="wx-rp-dialog-loader" aria-hidden />}
                {data.status === 'claimed' && (
                  <span className="wx-rp-dialog-received">已领取</span>
                )}
                <strong
                  className={
                    data.status === 'claimed'
                      ? 'wx-rp-dialog-status wx-rp-dialog-amount'
                      : 'wx-rp-dialog-status'
                  }
                >
                  {statusTitle}
                </strong>
                <small>{statusHint}</small>
                {(data.status === 'claimed' || data.status === 'gone') && (
                  <p>{data.greeting}</p>
                )}
              </>
            )}
          </div>

          <footer className="wx-rp-dialog-footer">
            {data.status === 'external' && data.externalUrl && (
              <button
                type="button"
                className="wx-rp-dialog-secondary"
                onClick={onClaim}
              >
                再次打开 TNG
              </button>
            )}
            {data.status === 'error' && (
              <button
                type="button"
                className="wx-rp-dialog-secondary"
                onClick={onClaim}
                disabled={busy}
              >
                重新打开
              </button>
            )}
            <button
              type="button"
              className="wx-rp-dialog-details"
              onClick={onDetails}
              disabled={pending || busy}
            >
              查看领取详情
              <span aria-hidden>›</span>
            </button>
          </footer>
        </section>

        <button
          type="button"
          className="wx-rp-dialog-close"
          onClick={onClose}
          disabled={busy}
          aria-label="关闭红包"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function useLongPressAction(onLongPress?: () => void, delayMs = 480) {
  const timerRef = useRef<number | null>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const triggeredRef = useRef(false);
  const [pressing, setPressing] = useState(false);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    originRef.current = null;
    setPressing(false);
  }, []);

  useEffect(() => cancel, [cancel]);

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!onLongPress || (event.pointerType === 'mouse' && event.button !== 0)) return;
    cancel();
    triggeredRef.current = false;
    originRef.current = { x: event.clientX, y: event.clientY };
    setPressing(true);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      originRef.current = null;
      triggeredRef.current = true;
      setPressing(false);
      onLongPress();
    }, delayMs);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const origin = originRef.current;
    if (!origin) return;
    if (
      Math.abs(event.clientX - origin.x) > 10
      || Math.abs(event.clientY - origin.y) > 10
    ) {
      cancel();
    }
  };

  const onContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    if (!onLongPress) return;
    event.preventDefault();
    cancel();
    if (!triggeredRef.current) onLongPress();
    triggeredRef.current = false;
  };

  return {
    pressing,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onPointerLeave: cancel,
      onContextMenu,
    },
  };
}

function LongPressSurface({
  children,
  className,
  ariaLabel,
  onLongPress,
}: {
  children: ReactNode;
  className: string;
  ariaLabel: string;
  onLongPress?: () => void;
}) {
  const { pressing, handlers } = useLongPressAction(onLongPress);
  const interactive = !!onLongPress;
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!onLongPress || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    onLongPress();
  };
  return (
    <div
      className={`${className}${interactive ? ' long-pressable' : ''}${pressing ? ' is-pressing' : ''}`}
      {...(interactive ? handlers : {})}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? ariaLabel : undefined}
      onKeyDown={interactive ? onKeyDown : undefined}
    >
      {children}
    </div>
  );
}

function ChatAvatar({
  url,
  name,
  onLongPress,
}: {
  url?: string | null;
  name: string;
  onLongPress?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const { pressing, handlers } = useLongPressAction(onLongPress);
  const avatar = url && !failed
    ? (
      <img
        className="feed-chat-avatar"
        src={url}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
      />
    )
    : (
      <div className="feed-chat-avatar" aria-hidden>
        {(name || '?').slice(0, 1)}
      </div>
    );
  if (!onLongPress) return avatar;
  return (
    <button
      type="button"
      className={`feed-chat-avatar-action${pressing ? ' is-pressing' : ''}`}
      aria-label={`长按艾特${name}`}
      {...handlers}
      onClick={(event) => {
        if (event.detail === 0) onLongPress();
      }}
    >
      {avatar}
    </button>
  );
}

function formatTime(value?: string) {
  if (!value) return undefined;
  try {
    return new Date(value).toLocaleTimeString('zh-MY', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return undefined;
  }
}

function formatDateTime(value?: string | null) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString('zh-MY', {
      hour12: false,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function stripAssistHtml(value: string) {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}
