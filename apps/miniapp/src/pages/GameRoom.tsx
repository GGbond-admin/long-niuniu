import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  api,
  getToken,
  invalidateDeviceSession,
  rm,
  roomWsUrl,
  type RoomState,
} from '../api';
import ChatComposer from '../components/ChatComposer';
import { RedPacketIcon, TransferIcon, TransferSwapIcon } from '../components/MoneyIcons';
import type { Session } from '../sessionStore';
import { openExternalLink } from '../telegram';

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
  from: { uid: string; nickname: string; avatarUrl?: string | null } | null;
  requestId?: string;
  at: string;
};

type BetAcceptanceNotice = {
  requestedAmountCents: string;
  liabilityBalanceCents: string;
  maxAffordableCents: string;
  roomMaxCents: string;
  maxAcceptedCents: string;
  maxMultiplier: number;
  reservedCents: string;
  adjusted: boolean;
  adjustedBy: string[];
};

type PrivateBetNoticePayload = {
  status: 'success' | 'failed' | 'unknown';
  action: 'bet' | 'all_in';
  amountCents: string;
  acceptance?: BetAcceptanceNotice;
  reason?: string;
};

type PendingChatAck = {
  requestId: string;
  content: string;
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
  mode?: 'bid' | 'bet' | 'claim' | 'lock';
  endsAt?: string;
  template?: string;
  emoji?: string;
};

type ChannelNotice = { id: string; title: string; body: string };

type FeedItem =
  | { kind: 'system'; id: string; text: string; time?: string }
  | {
      kind: 'countdown';
      id: string;
      /** lock：大号数字；其余：与顶栏同步的实时文案 */
      lockEmoji?: string;
      endsAt?: string | null;
      template?: string;
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
const GAME_PACKET_GREETING = '恭喜发财，大吉大利';
const LEADERBOARD_EMBLEM = '/game-ui/leaderboard-emblem-128.png';
const REWARDS_EMBLEM = '/game-ui/rewards-emblem-128.png';
/** 大群只渲染最近消息窗口，历史由后端持久化，重连时再取最近一段。 */
const CLIENT_CHAT_LIMIT = 100;

const PACKET_ERROR_TEXT: Record<string, string> = {
  PACKET_EMPTY: '来晚啦，红包已被抢光',
  PACKET_EXPIRED: '红包已过期',
  ALREADY_CLAIMED: '你已领取过该红包',
  INSUFFICIENT_BALANCE: '余额不足，请先充值',
  KYC_REQUIRED: '请先完成实名认证',
  INVALID_PACKET_AMOUNT: '红包金额超出范围（RM0.10 ~ RM10000）',
  INVALID_PACKET_COUNT: '红包个数需在 1 ~ 50 之间',
  PACKET_TOO_SMALL: '金额太小，每份至少 RM0.01',
  INVALID_TIP_AMOUNT: '打赏金额需在 RM1 ~ RM5000 之间',
};

function packetErrorText(e: unknown): string {
  const raw = (e as Error).message || '';
  return PACKET_ERROR_TEXT[raw] ?? raw ?? '操作失败';
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
    adjusted: row.adjusted,
    adjustedBy: row.adjustedBy.map(String),
  };
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

function parseUserPacketContent(raw: string): { id: string; greeting: string } {
  try {
    const parsed = JSON.parse(raw) as { id?: string; greeting?: string };
    if (parsed?.id) {
      return { id: parsed.id, greeting: parsed.greeting || '恭喜发财，大吉大利' };
    }
  } catch {
    // 兼容旧格式：content 直接是 packetId
  }
  return { id: raw, greeting: '恭喜发财，大吉大利' };
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

/** 简洁白骰：转动时不亮点数，落地再揭晓 */
function Die({
  value,
  size = 'md',
  spinning = false,
}: {
  value: number;
  size?: 'md' | 'lg';
  spinning?: boolean;
}) {
  const v = Math.min(6, Math.max(1, Math.trunc(value || 1)));
  const showDots = !spinning;
  return (
    <span
      className={`die die-${showDots ? v : 'blank'} die-${size}${spinning ? ' is-spinning' : ''}`}
      aria-label={spinning ? '骰子转动中' : `骰子 ${v} 点`}
    >
      {showDots &&
        Array.from({ length: v }).map((_, i) => (
          <i key={i} />
        ))}
    </span>
  );
}

/** 与后端 BANKER_DICE_BETWEEN_MS(1400) 对齐 */
const DIE_SPIN_MS = 920;
const DIE_LAND_MS = 360;
const DIE_GAP_MS = 120;

/** 一颗一颗依次掷出：轻晃减速 → 定点 → 下一颗 */
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
  const [active, setActive] = useState(animate ? 0 : finals.length);
  const [spinning, setSpinning] = useState(animate && finals.length > 0);
  const [landed, setLanded] = useState<number[]>(() =>
    animate ? [] : finals.slice(),
  );
  const doneRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    doneRef.current = false;
    if (!animate || finals.length === 0) {
      setActive(finals.length);
      setSpinning(false);
      setLanded(finals.slice());
      return;
    }
    setActive(0);
    setSpinning(true);
    setLanded([]);
  }, [animate, finals.join(',')]);

  useEffect(() => {
    if (!animate || !spinning || active >= finals.length) return;
    const stop = window.setTimeout(() => {
      setSpinning(false);
      setLanded((prev) => {
        const next = prev.slice();
        next[active] = finals[active];
        return next;
      });
      window.setTimeout(() => {
        const nextIndex = active + 1;
        if (nextIndex >= finals.length) {
          setActive(finals.length);
          if (!doneRef.current) {
            doneRef.current = true;
            onDoneRef.current?.();
          }
          return;
        }
        setActive(nextIndex);
        setSpinning(true);
      }, DIE_LAND_MS + DIE_GAP_MS);
    }, DIE_SPIN_MS);
    return () => window.clearTimeout(stop);
  }, [animate, spinning, active, finals.join(',')]);

  return (
    <div className={`seq-dice ${className}`.trim()} aria-label={`骰子 ${finals.join('·')}`}>
      {finals.map((final, idx) => {
        const isDone = idx < active || (idx === active && !spinning && landed[idx] != null);
        const isSpin = idx === active && spinning;
        const show = idx < active || idx === active || !animate;
        if (!show && animate) {
          return <span className={`seq-dice-slot pending die-${size}`} key={idx} aria-hidden />;
        }
        return (
          <span
            className={`seq-dice-slot${isSpin ? ' spinning' : ''}${isDone && idx === active && !spinning ? ' landing' : ''}${isDone && idx < active ? ' settled' : ''}`}
            key={idx}
          >
            <Die value={final} size={size} spinning={isSpin} />
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
  SENDING_PACKET: '等待小助手发包',
  CLAIMING: '红包领取中',
  CLAIM_EXPIRED: '认额核对中',
  SETTLING: '成绩计算中',
  FINISHED: '本局结束',
  CANCELLED: '本局取消',
};

/** 空闲/预览用完整一局演示：小助手播报、@庄家、对局红包 vs 玩家拼手气红包 */
const DEMO_FEED: FeedItem[] = [
  {
    kind: 'system',
    id: 'demo-bid',
    text: '🔔 第 1 局开始竞标\n请直接发送庄钱金额。\n竞标时间：30 秒\n最低：RM 100.00',
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
    name: '小美',
    avatar: '/avatars/glam-01.jpg',
    text: '8800',
    time: '21:41',
  },
  {
    kind: 'banner',
    id: 'demo-banner-bet-start',
    image: '/banners/banner-bet-start.jpg',
    alt: '开始下注',
  },
  {
    kind: 'system',
    id: 'demo-banker-selected',
    text: '👑 庄家确认\n恭喜 @小美 成为第 1 局庄家！\n庄钱：RM 8800.00',
    time: '21:41',
  },
  {
    kind: 'system',
    id: 'demo-banker',
    text: '🐂 第 1 局开注\n本局庄家：@小美\n庄钱：RM 8800.00\n下注时长：50 秒\n下注范围：RM 2.00 ~ 44.00\n梭哈范围：RM 20.00 ~ 440.00\n\n下注请发送金额；梭哈发送 sh金额；发送 0 撤回。',
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
    image: '/banners/banner-bet-stop.jpg',
    alt: '停止下注',
  },
  {
    kind: 'system',
    id: 'demo-sealed',
    text: '🛑 停止下注\n庄家：@小美\n庄钱：8800.00\n发包金额：3.00\n发包数量：3\n总下注额：225.00\n总梭哈额：200.00\n\n本局下注成功名单：\n@阿强 25.00\n@阿杰 200.00梭哈',
    time: '21:42',
  },
  {
    kind: 'system',
    id: 'demo-dice-prompt',
    text: '🎲 请庄家 @小美 于 60 秒内投出 3 颗骰子。\n如需重开本局，可发送 /重推。',
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
    text: '【庄家开骰】\n庄家：@小美\n点数：2·5·6\n牌型据此开算，请各位看结果。',
    time: '21:42',
  },
  {
    kind: 'system',
    id: 'demo-wait',
    text: '⏳ 等待小助手在后台完成 TNG 发包\n请耐心等待，期间请勿退出本页面，以免错过抢包。',
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
    name: '小助手',
    avatar: ASSISTANT_AVATAR,
  },
  {
    kind: 'banner',
    id: 'demo-banner-claim-start',
    image: '/banners/banner-claim-start.jpg',
    alt: '开始抢包',
  },
  {
    kind: 'system',
    id: 'demo-claim-start',
    text: '🧧 小助手已发包，开始抢包\n仅本局庄家与已下注闲家可领取。\n红包将在 30 秒后过期。',
    time: '21:43',
  },
  {
    kind: 'banner',
    id: 'demo-banner-claim-stop',
    image: '/banners/banner-claim-stop.jpg',
    alt: '停止抢包',
  },
  {
    kind: 'system',
    id: 'demo-claim-end',
    text: '⏰ 抢包已结束，正在等待平台核对领取明细并结算。',
    time: '21:43',
  },
  {
    kind: 'system',
    id: 'demo-rake',
    text: '⭐ 小通告\n玩家盈利抽 5%，庄家盈利抽 5%。\n祝各位老板发发发！',
    time: '21:43',
  },
  {
    kind: 'system',
    id: 'demo-next',
    text: '📣 下一局准备中。上方为演示流程：竞标 → @宣布庄家 → 下注 → 小助手发包 → 抢包 → 结算。',
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
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= targetMs) window.clearInterval(timer);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [target]);
  return remainingSeconds(target, now);
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

function RemainingValue({ endsAt }: { endsAt: string }) {
  return <>{useRemainingSeconds(endsAt) ?? '—'}</>;
}

function RemainingCopy({
  endsAt,
  template,
}: {
  endsAt?: string | null;
  template: string;
}) {
  const remaining = useRemainingSeconds(endsAt) ?? 0;
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

function ContinuationConfirm({
  deadline,
  busy,
  onConfirm,
}: {
  deadline: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  const seconds = useRemainingSeconds(deadline);
  if (seconds === null || seconds <= 0) return null;
  return (
    <div className="game-room-actions compact">
      <button className="primary-action" type="button" disabled={busy} onClick={onConfirm}>
        续庄确认（{seconds}s）
      </button>
    </div>
  );
}

const SCORE_HAND_TEXT: Record<string, string> = {
  BAOZI: '豹子',
  MANNIU: '满牛',
  FANSHUN: '反顺',
  SHUNZI: '顺子',
  DUIZI: '对子',
  JINNIU: '金牛',
  NIUNIU: '牛牛',
  MIANSI: '免死',
  NORMAL: '普通',
};

function scoreRm(cents: unknown): string {
  const n = Number(cents ?? 0);
  return Number.isFinite(n) ? (n / 100).toFixed(2) : '0.00';
}

function scoreSignedRm(cents: unknown): string {
  const n = Number(cents ?? 0);
  return `${n >= 0 ? '+' : '-'}RM ${(Math.abs(n) / 100).toFixed(2)}`;
}

function scoreHandText(type: unknown, points: unknown): string {
  if (type === 'NORMAL') return `${points}点`;
  return SCORE_HAND_TEXT[String(type)] ?? String(type ?? '');
}

function scoreLines(board: RoomState['lastScoreboard']): string[] {
  if (!board) return [];
  if (typeof board.playerLines === 'string') return board.playerLines.split('\n');
  if (!Array.isArray(board.playerLines)) return [];
  return board.playerLines.map((raw) => {
    if (typeof raw === 'string') return raw;
    const line = (raw ?? {}) as Record<string, unknown>;
    const name = String(line.nickname || (line.uid ? `UID ${line.uid}` : '玩家'));
    const multiplier = Number(line.multiplier ?? 0);
    const outcome =
      line.outcome === 'PLAYER_WIN'
        ? `赢 ${scoreSignedRm(line.netCents)}`
        : line.outcome === 'BANKER_WIN'
          ? `输 ${scoreSignedRm(line.netCents)}${multiplier > 1 ? `（庄家牌型 ×${multiplier}）` : ''}`
          : '平';
    const shortfall = Number(line.shortfallCents ?? 0);
    // 庄钱赔完后排在后面的赢家一分未得，按规则叫「喝水」
    const drank = line.outcome === 'PLAYER_WIN' && shortfall > 0 && Number(line.netCents ?? 0) === 0;
    const shortfallText = drank
      ? '（喝水 · 庄钱已赔完）'
      : shortfall > 0
        ? `（免赔 RM ${scoreRm(shortfall)}）`
        : '';
    return (
      `${line.isBust ? '💥 ' : ''}${name} · 抢 RM ${scoreRm(line.claimCents)} · ` +
      `${line.isAllIn ? '梭哈' : '下注'} RM ${scoreRm(line.betCents)} · ` +
      `${scoreHandText(line.handType, line.points)} → ${outcome}` +
      `${shortfallText} · ` +
      `积分 RM ${scoreRm(line.balanceBeforeCents)} → RM ${scoreRm(line.balanceAfterCents)}`
    );
  });
}

function scoreFooter(board: RoomState['lastScoreboard']): string {
  if (!board) return '';
  if (typeof board.bankerSummary === 'string') return board.bankerSummary;
  const banker = board.bankerSummary as Record<string, unknown> | null;
  if (!banker || typeof banker !== 'object') return '';
  const fees = (banker.fees ?? {}) as Record<string, unknown>;
  const name = String(banker.nickname || (banker.uid ? `UID ${banker.uid}` : '庄家'));
  return [
    `${banker.isBust ? '💥 ' : ''}庄家 ${name} · 抢 RM ${scoreRm(banker.claimCents)} · ${scoreHandText(banker.handType, banker.points)}`,
    `庄家盈利 ${scoreSignedRm(banker.grossCents ?? banker.netCents)}（已扣抽水）`,
    `上庄费 -RM ${scoreRm(fees.seatFeeCents)} · 服务费 -RM ${scoreRm(fees.serviceFeeCents)} · 代包费 -RM ${scoreRm(fees.packetFeeCents)}`,
    `庄家实际盈利 ${scoreSignedRm(banker.netCents)}`,
    `上庄积分 RM ${scoreRm(banker.balanceBeforeCents)} · 盈利 ${scoreSignedRm(banker.netCents)} · 庄总积分 RM ${scoreRm(banker.balanceAfterCents)}`,
  ].join('\n');
}

type PlayLocationState = {
  sentPacket?: { packetId: string; greeting: string };
  tipNotice?: {
    nickname: string;
    amountCents: string;
    message?: string;
    avatarUrl?: string | null;
  };
};

type GroupPacketDetail = Awaited<ReturnType<typeof api.groupPacket>>;

export default function GameRoom({ session }: { session: Session }) {
  const { roomId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
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
  const [betNotice, setBetNotice] = useState<
    (PrivateBetNoticePayload & { id: number }) | null
  >(null);
  /** 新到达的骰子消息在聊天里播放转动 */
  const [animatedDiceIds, setAnimatedDiceIds] = useState<Record<string, boolean>>({});
  /** packetId -> 已领金额（分）；'GONE' 表示已抢光/过期 */
  const [packetClaims, setPacketClaims] = useState<Record<string, string>>({});
  const packetClaimsRef = useRef<Record<string, string>>({});
  const packetDetailCacheRef = useRef<Record<string, GroupPacketDetail>>({});

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
  /** 微信风格拆红包结果弹窗 */
  const [rpModal, setRpModal] = useState<null | {
    packetId: string;
    greeting: string;
    sender: { name: string; avatar?: string | null };
    amountCents?: string;
    gone?: boolean;
    claims: Array<{
      uid: string;
      nickname: string | null;
      avatarUrl: string | null;
      amountCents: string;
      at: string;
    }>;
    total: string;
    count: number;
    remaining: number;
  }>(null);
  const [rpOpening, setRpOpening] = useState<null | {
    packetId: string;
    greeting: string;
    sender: { name: string; avatar?: string | null };
  }>(null);
  const [rpBusy, setRpBusy] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const didReceiveHistoryRef = useRef(false);
  const betPendingRef = useRef(false);
  const betPendingTimerRef = useRef<number | null>(null);
  const betPendingRequestIdRef = useRef<string | null>(null);
  const pendingChatAckRef = useRef<PendingChatAck | null>(null);
  const betNoticeTimerRef = useRef<number | null>(null);
  const privateBetNoticeIdRef = useRef(0);
  const [tipNotice, setTipNotice] = useState<{
    id: number;
    nickname: string;
    amountCents: string;
    message?: string;
    avatarUrl?: string | null;
  } | null>(null);
  /** 靠近底部时跟随新消息；进房强制贴底一次 */
  const stickToBottomRef = useRef(true);
  const didInitialScrollRef = useRef(false);
  const [channelOpen, setChannelOpen] = useState(false);
  /** 上翻看历史期间有新消息：不强拉回底部，浮出「有新消息」按钮 */
  const [newBelow, setNewBelow] = useState(false);
  const newBelowRef = useRef(false);
  function markNewBelow(value: boolean) {
    if (newBelowRef.current === value) return;
    newBelowRef.current = value;
    setNewBelow(value);
  }

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
    pending.resolve(accepted);
  }

  function pushPrivateBetNotice(notice: PrivateBetNoticePayload) {
    privateBetNoticeIdRef.current += 1;
    const id = privateBetNoticeIdRef.current;
    if (betNoticeTimerRef.current !== null) {
      window.clearTimeout(betNoticeTimerRef.current);
      betNoticeTimerRef.current = null;
    }
    setBetNotice({ ...notice, id });
    const dismissMs =
      notice.status === 'success' && notice.acceptance?.adjusted
        ? 7_000
        : notice.status === 'success'
          ? 2_200
          : notice.status === 'failed'
            ? 3_200
            : 4_000;
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
  const deadline = (() => {
    const round = state?.round;
    if (!round) return null;
    if (round.phase === 'BANKER_BID') return round.bidEndsAt ?? null;
    if (round.phase === 'BETTING') return round.betEndsAt ?? null;
    if (round.phase === 'CLAIMING') return round.claimEndsAt ?? null;
    return null;
  })();
  const continuation = state?.continuation;
  const packetDiceDone =
    phase === 'SENDING_PACKET' && (!!state?.round?.diceThrown || diceSent);
  const phaseLabel =
    phase === 'SENDING_PACKET'
      ? packetDiceDone
        ? '等待小助手发包'
        : state?.me.isBanker
          ? '请完成庄家投骰'
          : '等待庄家投骰'
      : phases[phase ?? 'WAITING'] ?? '等待开局';
  const phaseAside =
    deadline
      ? { value: <RemainingValue endsAt={deadline} />, label: '秒' }
      : phase === 'SENDING_PACKET'
        ? packetDiceDone
          ? { value: '准备', label: '发包' }
          : { value: '待投', label: '骰子' }
        : { value: '—', label: '倒计时' };

  const phaseHint = useMemo(() => {
    if (phase === 'BANKER_BID') {
      return `竞标 RM ${rm(state?.config.bankerBidMinCents ?? 0)} ~ ${rm(state?.config.bankerBidMaxCents ?? 0)}`;
    }
    if (phase === 'BETTING' && state?.round?.betRange) {
      const r = state.round.betRange;
      return `下注 ${rm(r.betMinCents)}~${rm(r.betMaxCents)} · 梭哈 ${rm(r.shMinCents)}~${rm(r.shMaxCents)}`;
    }
    if (phase === 'SENDING_PACKET') {
      if (packetDiceDone) return '庄家投骰已完成，正在等待小助手发包';
      return state?.me.isBanker
        ? '已封盘，请投骰；完成后由小助手发包'
        : '已封盘，等待庄家投骰；完成后由小助手发包';
    }
    if (phase === 'CLAIMING') {
      const isParticipant =
        !!state?.me.isBanker || !!state?.me.bet || !!state?.me.canClaim;
      return isParticipant
        ? '仅庄家与已下注闲家可领 · 抢包期间禁止发言'
        : '未参与本局，请等待下一局';
    }
    if (phase === 'CLAIM_EXPIRED') return '抢包已结束，正在核对领取金额 · 可正常发言';
    if (phase === 'SETTLING') return '核对完成，正在计算本局成绩 · 可正常发言';
    if (phase === 'WAITING' || !phase) return '凑齐人数后自动开局';
    return '系统自动结算';
  }, [phase, state, packetDiceDone]);

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
        items.push({
          kind: 'system',
          id: msg.id,
          text,
          time: formatTime(msg.at),
        });
      } else if (msg.type === 'COUNTDOWN') {
        const payload = parseCountdownPayload(msg.content);
        // 抢包倒计时气泡已停发；历史局里的同款消息也不再展示
        if (payload?.mode === 'claim') continue;
        if (payload?.mode === 'lock') {
          items.push({
            kind: 'countdown',
            id: msg.id,
            lockEmoji: payload.emoji || '3',
            time: formatTime(msg.at),
          });
        } else {
          const endsAt = payload?.endsAt ?? deadline;
          const template =
            payload?.template ||
            (payload?.mode === 'bid'
              ? '竞标倒计时 · 还剩 {{remaining}} 秒\n直接发送金额出价，时间到进入最终确认！'
              : '下注倒计时 · 还剩 {{remaining}} 秒\n未出手的抓紧了，时间到立刻封盘！');
          items.push({
            kind: 'countdown',
            id: msg.id,
            endsAt,
            template: stripAssistHtml(template),
            time: formatTime(msg.at),
          });
        }
      } else if (msg.type === 'BANNER') {
        items.push({
          kind: 'banner',
          id: msg.id,
          image: `/banners/banner-${msg.content}.jpg`,
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
            ? '点击领取'
            : canView
              ? `已抢到 RM ${rm(state!.me.claimedAmountCents!)}，点击查看`
              : isCurrent && state?.round?.phase === 'CLAIM_EXPIRED'
                ? '红包已过期，点击查看'
                : isCurrent
                  ? '未参与本局，无法领取'
                  : isPublishingCurrentRound
                    ? '红包已发出，等待开抢'
                    : '红包已结束，点击查看',
          endsAt: canOpen ? deadline : null,
          claimable: canOpen || canView,
          view: viewEnded,
          waiting: isPublishingCurrentRound,
          demo: false,
          asChat: true,
          name: '小助手',
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
        items.push({
          kind: 'chat',
          id: msg.id,
          mine: !!msg.from?.uid && msg.from.uid === myUid,
          name: msg.from?.nickname ?? '玩家',
          avatar: msg.from?.avatarUrl,
          text: msg.content,
          emoji: msg.type === 'EMOJI',
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
          ? '点击领取'
          : canView
            ? `已抢到 RM ${rm(state.me.claimedAmountCents!)}，点击查看`
            : state.round.phase === 'CLAIM_EXPIRED'
              ? '红包已过期，点击查看'
              : '未参与本局，无法领取',
        endsAt: canOpen ? deadline : null,
        claimable: canOpen || canView,
        view: viewEnded,
        demo: false,
        asChat: true,
        name: '小助手',
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

  // 消息窗口满 100 条后每来一条就挤掉最旧一条，feed.length 恒定；
  // 贴底必须以「末条身份」为触发条件，否则新消息会停在输入栏下方看不见。
  const feedTailId = feed.length > 0 ? feed[feed.length - 1]!.id : '';

  async function refresh() {
    if (!roomId) return;
    // 被动刷新只读状态即可；join（带成员写入）只在进房与断线重连时做，
    // 否则每次广播都触发全员 join 会把后端打满，导致整个互动群响应变卡。
    const next = await api.roomState(roomId);
    setState(next);
    setError('');
  }

  async function rejoin() {
    if (!roomId) return;
    // 重新 join，恢复可能被标记为 LEFT 的成员身份，避免竞标/下注被拒
    const next = await api.joinRoom(roomId);
    setState(next);
    setError('');
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
    setLoading(true);
    setState(null);
    setError('');
    setConnState('connecting');
    stickToBottomRef.current = true;
    didInitialScrollRef.current = false;
    setChannelOpen(false);
    setChat([]);
    markNewBelow(false);
    didReceiveHistoryRef.current = false;
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
              /** tip_thanks 附带祝福语 */
              tipMessage?: string;
              avatarUrl?: string | null;
              user?: { uid: string; nickname: string; avatarUrl?: string | null };
              requestId?: string;
            };
            if (payload.type === 'pong') {
              acknowledgePong();
            } else if (payload.type === 'chat_history' && payload.messages) {
              const recentMessages = payload.messages.slice(-CLIENT_CHAT_LIMIT);
              const isInitialHistory = !didReceiveHistoryRef.current;
              didReceiveHistoryRef.current = true;
              if (isInitialHistory) {
                stickToBottomRef.current = true;
                didInitialScrollRef.current = false;
              }
              // 历史加载可能晚于实时 chat；按 ID 合并，不能覆盖刚收到的对局红包。
              setChat((prev) => {
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
                return merged
                  .sort((left, right) => left.at.localeCompare(right.at))
                  .slice(-CLIENT_CHAT_LIMIT);
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
            } else if (
              payload.type === 'chat' &&
              payload.message &&
              typeof payload.message === 'object'
            ) {
              const incoming = payload.message;
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
                requestAnimationFrame(() => {
                  const el = streamRef.current;
                  if (el) el.scrollTop = el.scrollHeight;
                });
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
              setChat((prev) => {
                const exists = prev.some((item) => item.id === updated.id);
                if (!exists) {
                  return [...prev.slice(-(CLIENT_CHAT_LIMIT - 1)), updated];
                }
                return prev.map((item) => (item.id === updated.id ? { ...item, ...updated } : item));
              });
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
              setTipNotice({
                id: Date.now(),
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
        const connectSocket = () => {
          if (cancelled) return;
          disposeActiveSocketTimers();
          if (reconnectTimer) {
            window.clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }
          const auth = getToken();
          if (!auth) return;
          setConnState(hasOpenedSocket ? 'reconnecting' : 'connecting');
          const ws = new WebSocket(roomWsUrl(roomId, auth));
          socket = ws;
          socketRef.current = ws;
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
            if (event.reason === 'NOT_IN_ROOM' || event.reason === 'GAME_NOT_SUPPORTED') {
              setConnState('kicked');
              setError(
                event.reason === 'NOT_IN_ROOM'
                  ? '您已不在互动群内，请返回后重新进入房间'
                  : '该房间已不可用，请返回大厅',
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
            reconnectTimer = window.setTimeout(connectSocket, delay);
          };
        };
        reconnectNowRef.current = () => {
          if (
            socket &&
            (socket.readyState === WebSocket.OPEN ||
              socket.readyState === WebSocket.CONNECTING)
          ) {
            return;
          }
          reconnectAttempts = 0;
          connectSocket();
        };
        connectSocket();
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
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distance < 140;
      if (stickToBottomRef.current) markNewBelow(false);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [loading]);

  useEffect(() => {
    if (loading) return;
    const el = streamRef.current;
    if (!el) return;
    const force = !didInitialScrollRef.current || stickToBottomRef.current;
    if (!force) {
      markNewBelow(true);
      return;
    }
    markNewBelow(false);
    const jump = () => {
      // 几百人同时刷屏时平滑滚动会被连续打断、停在半路导致「脱底」，
      // 落后超过一屏的一小段就直接瞬时跳到底，只有小距离才用平滑。
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const behavior: ScrollBehavior =
        !didInitialScrollRef.current || distance > 240 ? 'auto' : 'smooth';
      el.scrollTo({ top: el.scrollHeight, behavior });
      didInitialScrollRef.current = true;
      stickToBottomRef.current = true;
    };
    // 双 rAF：等 feed 渲染完成后再贴底，避免进房停在最上方
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(jump);
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [loading, feed.length, feedTailId]);

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
    const timer = window.setTimeout(() => setTipNotice(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [tipNotice]);

  /** 打赏页返回时，本人也能立刻看到房间顶部感谢条；其他在线玩家由 WS 接收。 */
  useEffect(() => {
    const notice = (location.state as PlayLocationState | null)?.tipNotice;
    if (!notice?.nickname || !notice.amountCents) return;
    setTipNotice({ id: Date.now(), ...notice });
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [location.state, location.pathname, location.search, navigate]);

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
        ...prev,
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
    requestAnimationFrame(() => {
      const el = streamRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  /** 连接未就绪时给出可见提示，避免玩家以为消息/出价已发出 */
  function ensureSocketReady(): boolean {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) return true;
    setError('实时连接已断开，正在自动重连，请稍后再试');
    reconnectNowRef.current();
    return false;
  }

  /** 服务端回显/确认后才清空输入；拒绝、断线或超时均返回 false 并保留草稿。 */
  function sendChat(content: string): Promise<boolean> | false {
    if (!content) return false;
    if (!ensureSocketReady()) return false;
    if (pendingChatAckRef.current) return false;
    const pendingBet = phase === 'BETTING' ? parsePendingBetCommand(content) : null;
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
        resolve,
        timer,
      };
      setChatSendPending(true);

      try {
        socketRef.current!.send(
          JSON.stringify({ type: 'chat', content, requestId }),
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
    // 深链直接进房时没有上一页历史，navigate(-1) 会退出小程序
    if (location.key !== 'default') navigate(-1);
    else navigate(roomId ? `/game/${roomId}` : '/', { replace: true });
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

  /** 首次领取才播放短动效；已领取/已结束的红包直接打开领取详情。 */
  async function openUserPacket(item: {
    packetId: string;
    greeting: string;
    name: string;
    avatar?: string | null;
    mine: boolean;
  }) {
    if (rpBusy) return;
    const { packetId } = item;
    const existing = packetClaims[packetId];
    const sender = { name: item.name, avatar: item.avatar };

    const showDetail = (
      detail: GroupPacketDetail | null,
      amountCents?: string,
      gone = false,
      updateOnly = false,
    ) => {
      if (detail) packetDetailCacheRef.current[packetId] = detail;
      const ownClaim = detail?.claims.find((claimEntry) => claimEntry.uid === myUid);
      const resolvedAmount = amountCents ?? ownClaim?.amountCents;
      if (ownClaim) {
        updatePacketClaims((prev) => ({ ...prev, [packetId]: ownClaim.amountCents }));
      }
      const nextModal = {
        packetId,
        greeting: item.greeting,
        sender,
        amountCents: resolvedAmount,
        gone: gone && !resolvedAmount,
        claims: detail?.claims ?? [],
        total: detail?.totalCents ?? '0',
        count: detail?.count ?? 0,
        remaining: detail?.remainingCount ?? 0,
      };
      setRpModal((current) =>
        updateOnly && current?.packetId !== packetId ? current : nextModal,
      );
    };

    setRpBusy(true);
    setError('');
    try {
      if (existing) {
        const cached = packetDetailCacheRef.current[packetId] ?? null;
        if (cached) {
          showDetail(cached, existing === 'GONE' ? undefined : existing, existing === 'GONE');
          return;
        }
        const detail = await api.groupPacket(packetId).catch(() => null);
        showDetail(detail, existing === 'GONE' ? undefined : existing, existing === 'GONE');
        return;
      }

      setRpOpening({ packetId, greeting: item.greeting, sender });
      const openingStartedAt = Date.now();
      let claimedAmount: string;
      try {
        const result = await api.claimGroupPacket(packetId);
        claimedAmount = result.amountCents;
        updatePacketClaims((prev) => ({ ...prev, [packetId]: result.amountCents }));
      } catch (claimError) {
        const code = (claimError as Error).message;
        setRpOpening(null);
        if (code === 'ALREADY_CLAIMED') {
          const detail = await api.groupPacket(packetId).catch(() => null);
          showDetail(detail);
          return;
        }
        if (code === 'PACKET_EMPTY' || code === 'PACKET_EXPIRED') {
          updatePacketClaims((prev) => ({ ...prev, [packetId]: 'GONE' }));
          const detail = await api.groupPacket(packetId).catch(() => null);
          showDetail(detail, undefined, true);
          return;
        }
        setError(packetErrorText(claimError));
        return;
      }

      const detailPromise = api.groupPacket(packetId).catch(() => null);
      const minimumMotion = new Promise<void>((resolve) => {
        const remainingMs = Math.max(0, 380 - (Date.now() - openingStartedAt));
        window.setTimeout(resolve, remainingMs);
      });
      const fastDetail = await Promise.race([
        detailPromise,
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 180)),
      ]);
      await minimumMotion;
      setRpOpening(null);
      showDetail(fastDetail, claimedAmount);
      if (!fastDetail) {
        void detailPromise.then((detail) => {
          if (detail) showDetail(detail, claimedAmount, false, true);
        });
      }
    } finally {
      setRpOpening(null);
      setRpBusy(false);
    }
  }

  /** 内部红包结果弹窗数据：复用群红包样式，展示我的金额与全部领取名单 */
  function gamePacketModalData(snapshot: RoomState | null, mineCents?: string) {
    const round = snapshot?.round;
    const claims = (round?.claims ?? []).map((claim) => ({
      uid: claim.uid,
      nickname: claim.nickname,
      avatarUrl: claim.avatarUrl,
      amountCents: claim.amountCents,
      at: claim.at,
    }));
    const count = round?.participantCount ?? 0;
    return {
      packetId: round?.packetId ?? 'game-packet',
      greeting: GAME_PACKET_GREETING,
      sender: { name: '小助手', avatar: ASSISTANT_AVATAR },
      amountCents: mineCents,
      claims,
      total: round?.packetTotalCents ?? '0',
      count,
      remaining: Math.max(0, count - claims.length),
    };
  }

  /** 红包结束后点开查看抢包/认额名单（微信式手气榜，所有人可看） */
  async function viewGamePacket(packetId: string) {
    if (rpBusy) return;
    setRpBusy(true);
    setError('');
    try {
      const detail = await api.gamePacket(packetId);
      const mine = detail.claims.find((claimEntry) => claimEntry.uid === myUid);
      setRpModal({
        packetId,
        greeting: GAME_PACKET_GREETING,
        sender: { name: '小助手', avatar: ASSISTANT_AVATAR },
        amountCents: mine?.amountCents,
        claims: detail.claims,
        total: detail.totalCents,
        count: detail.participantCount,
        remaining: Math.max(0, detail.participantCount - detail.claims.length),
      });
    } catch {
      setError('红包数据加载失败，请稍后再试');
    } finally {
      setRpBusy(false);
    }
  }

  async function claim(packetId?: string) {
    const activePacketId = state?.round?.packetId;
    if (!activePacketId || (packetId && packetId !== activePacketId)) {
      // 已结束的红包点开直接看名单，不再报错
      if (packetId) return viewGamePacket(packetId);
      setError('红包已结束');
      return;
    }
    const isInternal = state.round?.packetChannel === 'INTERNAL';
    if (!state.me.canClaim) {
      // 内部红包：已抢过的点开直接看结果
      if (isInternal && state.me.claimedAmountCents) {
        setRpModal(gamePacketModalData(state, state.me.claimedAmountCents));
        return;
      }
      setError('仅本局庄家与已下注闲家可领取红包');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (!isInternal) {
        const { url } = await api.claimPacket(activePacketId);
        if (url) openExternalLink(url);
        return;
      }

      // 内部红包：小助手直发，金额随机拆分并即时入余额
      setRpOpening({
        packetId: activePacketId,
        greeting: GAME_PACKET_GREETING,
        sender: { name: '小助手', avatar: ASSISTANT_AVATAR },
      });
      const openingStartedAt = Date.now();
      let claimedAmount: string;
      try {
        const result = await api.claimPacket(activePacketId);
        claimedAmount = result.amountCents ?? '0';
      } catch (claimError) {
        setRpOpening(null);
        const code = (claimError as Error).message;
        if (code === 'ALREADY_CLAIMED' && state.me.claimedAmountCents) {
          setRpModal(gamePacketModalData(state, state.me.claimedAmountCents));
          return;
        }
        setError(packetErrorText(claimError));
        return;
      }
      const latest = roomId ? await api.roomState(roomId).catch(() => null) : null;
      if (latest) setState(latest);
      const remainingMs = Math.max(0, 380 - (Date.now() - openingStartedAt));
      await new Promise((resolve) => window.setTimeout(resolve, remainingMs));
      setRpOpening(null);
      setRpModal(gamePacketModalData(latest ?? state, claimedAmount));
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === 'NOT_ELIGIBLE_TO_CLAIM' || err.message.includes('NOT_ELIGIBLE')) {
        setError('仅本局庄家与已下注闲家可领取红包');
      } else {
        setError(err.message || '领取失败');
      }
    } finally {
      setRpOpening(null);
      setBusy(false);
    }
  }

  const canBid = phase === 'BANKER_BID';
  const canBet = phase === 'BETTING' && !state?.me.isBanker;
  const claimLocked = phase === 'CLAIMING';
  const chatMuted = claimLocked;
  const canThrowDice =
    phase === 'SENDING_PACKET' && !!state?.me.isBanker && !state?.round?.diceThrown && !diceSent;

  function sendDice() {
    if (
      phase !== 'SENDING_PACKET' ||
      !state?.me.isBanker ||
      state?.round?.diceThrown ||
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

  const composerUnavailable = loading || !state || connState !== 'online';
  const composerHint = loading
    ? '正在进入互动群…'
    : connState === 'kicked'
      ? '连接已断开，请重新进入'
      : connState !== 'online'
        ? '实时连接中，暂时不能发送'
        : chatSendPending
          ? '等待服务器确认，成功后自动清空'
          : betPending
            ? '下注确认中，请勿重复发送'
          : chatMuted
            ? '抢包中，暂不可发言'
            : canBid
              ? '竞庄金额，如 8800'
              : canBet
                ? '下注金额，如 100'
                : phase === 'SENDING_PACKET' && state?.me.isBanker
                  ? '可发消息，/重推取消本局'
                  : phase === 'CLAIM_EXPIRED' || phase === 'SETTLING'
                    ? '可发言（数字也会当聊天发出）'
                    : '发送消息…';

  return (
    <div className="game-room">
      {tipNotice && (
        <div className="room-tip-notice" role="status" aria-live="polite" key={tipNotice.id}>
          <span className="room-tip-notice-glow" aria-hidden />
          <span className="room-tip-notice-rays" aria-hidden />
          <span className="room-tip-notice-coins" aria-hidden>
            <i /><i /><i /><i /><i /><i />
          </span>
          <span className="room-tip-notice-avatar" aria-hidden>
            {tipNotice.avatarUrl ? (
              <img src={tipNotice.avatarUrl} alt="" />
            ) : (
              <b>{(tipNotice.nickname || '?').slice(0, 1)}</b>
            )}
            <em>
              <TransferIcon />
            </em>
          </span>
          <span className="room-tip-notice-copy">
            <small>心意送达</small>
            <strong>{tipNotice.nickname} 打赏客服小妹</strong>
            {tipNotice.message && <p>{tipNotice.message}</p>}
            <em>
              <b>RM</b> {rm(tipNotice.amountCents)}
            </em>
          </span>
          <button type="button" aria-label="关闭感谢通知" onClick={() => setTipNotice(null)}>
            ×
          </button>
          <i className="room-tip-notice-bar" aria-hidden />
        </div>
      )}

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
              <i />{' '}
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
              className="game-room-refresh"
              type="button"
              onClick={() => {
                if (!state || loading || connState === 'kicked') {
                  retryEntry();
                  return;
                }
                // 用户主动刷新时重新 join，可恢复短暂断线后被标记 LEFT 的成员身份。
                void rejoin()
                  .then(() => reconnectNowRef.current())
                  .catch(() => setError('刷新失败，请检查网络后重试'));
              }}
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

      <div className="game-room-feed-shell">
        <nav className="game-room-quick-actions" aria-label="房间快捷入口">
          <button
            className="game-room-quick-link leaderboard"
            type="button"
            onClick={() => navigate(`/game/${roomId}/leaderboards`)}
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
            onClick={() => navigate(`/game/${roomId}/rewards`)}
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
        </nav>

        <div className="game-room-feed" ref={streamRef}>
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
                    <div className="feed-assistant-name">至尊牛牛小助手</div>
                    <div className="feed-assistant-bubble">
                      <p>{item.text}</p>
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
                    <div className="feed-assistant-name">至尊牛牛小助手</div>
                    <div
                      className={`feed-assistant-bubble${item.lockEmoji ? ' countdown-lock' : ' countdown-live'}`}
                    >
                      {item.lockEmoji ? (
                        <p className="countdown-lock-emoji" aria-live="polite">
                          {item.lockEmoji}
                        </p>
                      ) : (
                        <p aria-live="polite">
                          <RemainingCopy
                            endsAt={item.endsAt}
                            template={item.template ?? ''}
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
                    <div className="feed-chat-name">至尊牛牛小助手</div>
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
                    {!item.mine && <div className="feed-chat-name">{item.name}</div>}
                    <button
                      type="button"
                      className={`wx-rp wx-rp-standard ${opened || gone || isDemo ? 'opened' : ''}`}
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
                        {!opened && !gone && !isDemo && (
                          <span className="wx-rp-icon" aria-hidden />
                        )}
                        <div className="wx-rp-copy">
                          <strong>{item.greeting}</strong>
                          <small>
                            {isDemo
                              ? '演示红包'
                              : opened
                                ? `已领取 RM ${rm(claimed!)}`
                                : gone
                                  ? '红包已被领完'
                                  : item.mine
                                    ? '我发出的红包 · 点击领取'
                                    : '点击拆红包'}
                          </small>
                        </div>
                      </div>
                      <div className="wx-rp-foot">
                        <span className="wx-rp-brand">
                          {opened || gone ? '已开过' : '普通红包'}
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
                          <strong>RM{rm(item.amountCents)}</strong>
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
                  {!item.mine && <ChatAvatar url={item.avatar} name={item.name} />}
                  <div className="feed-chat-body">
                    {!item.mine && <div className="feed-chat-name">{item.name}</div>}
                    <div className={`feed-chat-bubble ${item.emoji ? 'emoji' : ''}`}>
                      <p>{item.text}</p>
                      {item.time && <time>{item.time}</time>}
                    </div>
                  </div>
                </div>
              );
            }
            if (item.kind === 'packet') {
              const senderName = item.name ?? '小助手';
              const interactive = !!item.asChat && !item.demo;
              const dimmed = !!item.waiting || !item.claimable;
              const clickable =
                !item.waiting && (!!item.claimable || (!!item.view && !!item.packetId));
              return (
                <div className="feed-chat theirs" key={item.id}>
                  <ChatAvatar url={item.avatar ?? ASSISTANT_AVATAR} name={senderName} />
                  <div className="feed-chat-body">
                    <div className="feed-chat-name">{senderName}</div>
                    {interactive ? (
                      <button
                        type="button"
                        className={`wx-rp wx-rp-niuniu ${dimmed ? 'opened' : ''}`}
                        disabled={busy || rpBusy || !clickable}
                        onClick={() =>
                          item.view && item.packetId
                            ? void viewGamePacket(item.packetId)
                            : void claim(item.packetId)
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
                      <div className={`wx-rp wx-rp-niuniu ${dimmed ? 'opened' : ''}`}>
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

      <div className="game-room-footer">
        {betNotice && (
          <BetResultToast notice={betNotice} onClose={dismissPrivateBetNotice} />
        )}
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

        {continuation?.mine && continuation.deadline && (
          <ContinuationConfirm
            deadline={continuation.deadline}
            busy={busy}
            onConfirm={() =>
              void runAction(() => api.continueBanker(roomId, continuation.previousRoundId))
            }
          />
        )}

        {state && connState === 'online' && (canBid || canBet) && (
          <div className="composer-mode-tip" role="status">
            <b>{canBid ? '竞庄模式' : '下注模式'}</b>
            <span>输入纯数字即提交金额，单位 RM；文字仍作为群消息发送</span>
          </div>
        )}

        <ChatComposer
          onSend={sendChat}
          disabled={chatMuted || composerUnavailable}
          busy={betPending || chatSendPending}
          placeholder={composerHint}
          stickers={stickers}
          onSendSticker={sendSticker}
          toolsHighlight={canThrowDice}
          defaultToolTab={canThrowDice ? 'dice' : 'emoji'}
          dicePanel={
            canThrowDice ? (
              <>
                <p className="dice-panel-hint">庄家投骰后，结果会一颗一颗发到群聊</p>
                <button
                  className="primary-action dice-action"
                  type="button"
                  onClick={sendDice}
                  disabled={diceSent}
                >
                  {diceSent ? '已发送到群聊…' : '投骰子到群聊'}
                </button>
              </>
            ) : (
              <p>
                {phase !== 'SENDING_PACKET'
                  ? '当前不是掷骰阶段'
                  : state?.me.isBanker
                    ? '本局已投过骰子'
                    : '仅本局庄家可投骰，结果将发到群聊'}
              </p>
            )
          }
          plusActions={[
            {
              key: 'packet',
              icon: <RedPacketIcon />,
              iconClass: 'packet filled',
              label: '发红包',
              onClick: () => navigate(`/game/${roomId}/send-packet`),
            },
            {
              key: 'tip',
              icon: <TransferIcon />,
              iconClass: 'tip filled',
              label: '打赏',
              onClick: () => navigate(`/game/${roomId}/tip`),
            },
          ]}
        />
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

      {rpOpening &&
        createPortal(
          <RedPacketOpening data={rpOpening} />,
          document.body,
        )}

      {rpModal &&
        createPortal(
          <RedPacketModal data={rpModal} onClose={() => setRpModal(null)} />,
          document.body,
        )}
    </div>
  );
}

function BetResultToast({
  notice,
  onClose,
}: {
  notice: PrivateBetNoticePayload;
  onClose: () => void;
}) {
  const success = notice.status === 'success';
  const unknown = notice.status === 'unknown';
  const acceptance = notice.acceptance;
  const adjusted = success && acceptance?.adjusted === true;
  const actionName = notice.action === 'all_in' ? '梭哈' : '下注';
  const title = adjusted
    ? `${actionName}已自动调整`
    : success
      ? `${actionName}成功`
      : unknown
        ? '确认超时'
        : `${actionName}失败`;
  const detail =
    success
      ? '已记录，请等待本局流程'
      : notice.reason || (unknown ? '请刷新核对后再操作' : '操作未完成');

  return (
    <div
      className={`bet-result-toast ${notice.status}${adjusted ? ' adjusted' : ''}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="bet-result-toast-mark" aria-hidden>
        {adjusted ? '↘' : success ? '✓' : unknown ? '…' : '!'}
      </span>
      <div className="bet-result-toast-copy">
        <strong>
          {title}<i>｜</i>RM{rm(notice.amountCents)}
        </strong>
        {adjusted && acceptance ? (
          <div className="bet-adjustment-detail">
            <span>
              输入 <b>RM{rm(acceptance.requestedAmountCents)}</b>
              <i>当前余额 RM{rm(acceptance.liabilityBalanceCents)}</i>
            </span>
            <span>
              {acceptance.maxMultiplier} 倍余额上限{' '}
              <b>RM{rm(acceptance.maxAffordableCents)}</b>
              <i>本局最高 RM{rm(acceptance.maxAcceptedCents)}</i>
            </span>
            <span>
              实际接受 <b>RM{rm(notice.amountCents)}</b>
              <i>最大赔付已预留 RM{rm(acceptance.reservedCents)}</i>
            </span>
          </div>
        ) : (
          <small>{detail}</small>
        )}
      </div>
      <button type="button" className="bet-result-toast-close" aria-label="关闭" onClick={onClose}>
        ×
      </button>
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

function RedPacketOpening({
  data,
}: {
  data: {
    packetId: string;
    greeting: string;
    sender: { name: string; avatar?: string | null };
  };
}) {
  return (
    <div className="wx-rp-opening" role="status" aria-live="polite" aria-label="正在拆红包">
      <div className="wx-rp-opening-stage">
        <div className="wx-rp-opening-packet">
          <div className="wx-rp-opening-flap" aria-hidden />
          <div className="wx-rp-opening-copy">
            <span className="wx-rp-opening-sender">
              <RedPacketSenderAvatar url={data.sender.avatar} name={data.sender.name} />
              {data.sender.name} 的红包
            </span>
            <strong>{data.greeting}</strong>
          </div>
          <div className="wx-rp-opening-rays" aria-hidden />
          <div className="wx-rp-opening-coin" aria-hidden>
            <span>開</span>
          </div>
        </div>
        <div className="wx-rp-opening-status">
          <strong>正在拆红包</strong>
          <span>好运正在赶来，请稍候…</span>
        </div>
      </div>
    </div>
  );
}

function RedPacketModal({
  data,
  onClose,
}: {
  data: {
    packetId: string;
    greeting: string;
    sender: { name: string; avatar?: string | null };
    amountCents?: string;
    gone?: boolean;
    claims: Array<{
      uid: string;
      nickname: string | null;
      avatarUrl: string | null;
      amountCents: string;
      at: string;
    }>;
    total: string;
    count: number;
    remaining: number;
  };
  onClose: () => void;
}) {
  const luckyUid = data.claims.length
    ? data.claims.reduce((best, c) =>
        Number(c.amountCents) > Number(best.amountCents) ? c : best,
      ).uid
    : null;
  const claimedCount = data.claims.length;
  const grabbedOut = data.count > 0 && data.remaining <= 0;

  return (
    <div className="wx-rp-modal" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="wx-rp-modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="wx-rp-modal-hero">
          <span className="wx-rp-sender">
            <RedPacketSenderAvatar url={data.sender.avatar} name={data.sender.name} />
            {data.sender.name} 发出的红包
          </span>
          <div className="wx-rp-greet">{data.greeting}</div>
          {data.gone ? (
            <div className="wx-rp-miss">手慢了，红包已被领完</div>
          ) : data.amountCents ? (
            <div className="wx-rp-amount">
              <span>RM</span>
              <b>{rm(data.amountCents)}</b>
              <i>已存入零钱余额</i>
            </div>
          ) : (
            <div className="wx-rp-coin" aria-hidden>
              開
            </div>
          )}
        </div>

        <div className="wx-rp-modal-list">
          <div className="wx-rp-list-head">
            <span>
              {data.count > 0
                ? `已领取 ${claimedCount}/${data.count} 个`
                : `已领取 ${claimedCount} 个`}
              ，共 RM {rm(data.total)}
            </span>
            {grabbedOut && <span>已抢光</span>}
          </div>
          {claimedCount ? (
            data.claims.map((c) => {
              const name = c.nickname || '玩家';
              return (
                <div className="wx-rp-row" key={`${c.uid}-${c.at}`}>
                  {c.avatarUrl ? (
                    <img src={c.avatarUrl} alt="" />
                  ) : (
                    <span className="wx-rp-row-ph">{name.slice(0, 1)}</span>
                  )}
                  <div className="wx-rp-row-main">
                    <strong>{name}</strong>
                    <small>{formatClaimTime(c.at)}</small>
                  </div>
                  <div className="wx-rp-row-amt">
                    <b>RM {rm(c.amountCents)}</b>
                    {c.uid === luckyUid && claimedCount > 1 && (
                      <span className="wx-rp-lucky">手气最佳</span>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="wx-rp-modal-empty">还没有人领取，快抢一个吧</div>
          )}
        </div>
      </div>
      <button type="button" className="wx-rp-modal-close" onClick={onClose} aria-label="关闭">
        ×
      </button>
    </div>
  );
}

function formatClaimTime(value: string): string {
  try {
    return new Date(value).toLocaleString('zh-MY', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function ChatAvatar({ url, name }: { url?: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    return (
      <img
        className="feed-chat-avatar"
        src={url}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div className="feed-chat-avatar" aria-hidden>
      {(name || '?').slice(0, 1)}
    </div>
  );
}

function formatTime(value?: string) {
  if (!value) return undefined;
  try {
    return new Date(value).toLocaleTimeString('zh-MY', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return undefined;
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
