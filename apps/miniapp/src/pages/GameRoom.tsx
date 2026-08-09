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
  at: string;
};

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
      text?: string;
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
      seconds?: number | null;
      claimable?: boolean;
      demo?: boolean;
      waiting?: boolean;
      /** 作为真人聊天气泡展示（微信红包样式） */
      asChat?: boolean;
      name?: string;
      avatar?: string | null;
    }
  | { kind: 'score'; id: string; seqNo: number; lines: string[]; footer: string };

const BANNER_ALT: Record<string, string> = {
  'bet-start': '开始下注',
  'bet-stop': '停止下注',
  'claim-start': '开始抢包',
  'claim-stop': '停止抢包',
};

const ASSISTANT_AVATAR = '/avatars/assistant.jpg';
const LEADERBOARD_EMBLEM = '/game-ui/leaderboard-emblem-128.png';
const REWARDS_EMBLEM = '/game-ui/rewards-emblem-128.png';

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
    seconds: 28,
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
    text: '⏰ 抢包已结束，正在等待平台核对领取明细并公布成绩单。',
    time: '21:43',
  },
  {
    kind: 'system',
    id: 'demo-rake',
    text: '⭐ 小通告\n玩家盈利抽 5%，庄家盈利抽 5%。\n祝各位老板发发发！',
    time: '21:43',
  },
  {
    kind: 'score',
    id: 'demo-score',
    seqNo: 1,
    lines: [
      '@小美 抢到 2.80 · 庄家 · 10点',
      '@阿强 抢到 1.22 · 下注 25 · 对子 · 赢 ×12',
      '@阿杰 抢到 0.31 · 梭哈 200 · 自爆 · 输',
    ],
    footer: '庄家汇总：抽水后盈利 RM 168.50 · 上庄费/服务费/代包费已扣',
  },
  {
    kind: 'system',
    id: 'demo-next',
    text: '📣 下一局准备中。上方为演示流程：竞标 → @宣布庄家 → 下注 → 小助手发包 → 抢包 → 成绩单。',
    time: '21:44',
  },
];

/** 每秒刷新一次，供顶栏与聊天倒计时共用，避免两端时间错位 */
function useNowTick() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
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

function scoreLines(board: RoomState['lastScoreboard']): string[] {
  if (!board) return [];
  if (Array.isArray(board.playerLines)) return board.playerLines.map((line) => String(line));
  if (typeof board.playerLines === 'string') return board.playerLines.split('\n');
  return [JSON.stringify(board.playerLines)];
}

function scoreFooter(board: RoomState['lastScoreboard']): string {
  if (!board) return '';
  if (typeof board.bankerSummary === 'string') return board.bankerSummary;
  if (board.bankerSummary) return JSON.stringify(board.bankerSummary);
  return '';
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

export default function GameRoom() {
  const { roomId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  /** 默认展示演示流；地址加 ?demo=0 可关闭 */
  const showDemoFeed = searchParams.get('demo') !== '0';
  const [state, setState] = useState<RoomState | null>(null);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [myUid, setMyUid] = useState('');
  const [myProfile, setMyProfile] = useState<{
    nickname: string;
    avatarUrl?: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [stickers, setStickers] = useState<Array<{ id: string; name: string; url: string }>>([]);
  const [diceSent, setDiceSent] = useState(false);
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

  // 倒计时必须跟当前阶段绑定，避免沿用上阶段时间戳造成「还有 N 秒」的假象
  const phase = state?.round?.phase;
  const nowTick = useNowTick();
  const deadline = (() => {
    const round = state?.round;
    if (!round) return null;
    if (round.phase === 'BANKER_BID') return round.bidEndsAt ?? null;
    if (round.phase === 'BETTING') return round.betEndsAt ?? null;
    if (round.phase === 'CLAIMING') return round.claimEndsAt ?? null;
    return null;
  })();
  const seconds = remainingSeconds(deadline, nowTick);
  const continuation = state?.continuation;
  const continuationSeconds = remainingSeconds(continuation?.deadline, nowTick);
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
    seconds !== null
      ? { value: String(seconds), label: '秒' }
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
          ? '演示流程预览中：竞标 → 宣布庄家 → 下注 → 抢包 → 成绩单。地址加 ?demo=0 可关闭演示。点击查看详情。'
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
        if (payload?.mode === 'lock') {
          items.push({
            kind: 'countdown',
            id: msg.id,
            lockEmoji: payload.emoji || '3',
            time: formatTime(msg.at),
          });
        } else {
          const endsAt = payload?.endsAt ?? null;
          const remaining = remainingSeconds(endsAt, nowTick) ?? seconds ?? 0;
          const template =
            payload?.template ||
            (payload?.mode === 'bid'
              ? '竞标倒计时 · 还剩 {{remaining}} 秒\n直接发送金额出价，时间到进入最终确认！'
              : payload?.mode === 'claim'
                ? '抢包进行中 · 还剩 {{remaining}} 秒\n仅本局庄家与已下注闲家可领，过期即止。'
                : '下注倒计时 · 还剩 {{remaining}} 秒\n未出手的抓紧了，时间到立刻封盘！');
          items.push({
            kind: 'countdown',
            id: msg.id,
            text: fillRemaining(stripAssistHtml(template), remaining),
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
        if (isCurrent) hasCurrentGamePacket = true;
        items.push({
          kind: 'packet',
          id: msg.id,
          packetId: packet.id,
          title: packet.greeting,
          subtitle: canOpen
            ? '点击领取'
            : isCurrent && state?.round?.phase === 'CLAIM_EXPIRED'
              ? '红包已过期'
              : isCurrent
                ? '未参与本局，无法领取'
                : isPublishingCurrentRound
                  ? '红包已发出，等待开抢'
                  : '红包已结束',
          seconds: canOpen ? seconds : null,
          claimable: canOpen,
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
      const fallbackPacket: FeedItem = {
        kind: 'packet',
        id: `packet-${state.round.packetId}`,
        packetId: state.round.packetId,
        title: '恭喜发财，大吉大利',
        subtitle: canOpen
          ? '点击领取'
          : state.round.phase === 'CLAIM_EXPIRED'
            ? '红包已过期'
            : '未参与本局，无法领取',
        seconds: canOpen ? seconds : null,
        claimable: canOpen,
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

    if (state?.lastScoreboard) {
      items.push({
        kind: 'score',
        id: `score-${state.lastScoreboard.seqNo}`,
        seqNo: state.lastScoreboard.seqNo,
        lines: scoreLines(state.lastScoreboard),
        footer: scoreFooter(state.lastScoreboard),
      });
    }
    return items;
  }, [state, chat, myUid, seconds, nowTick, showDemoFeed, liveBusy]);

  async function refresh() {
    if (!roomId) return;
    // 刷新时重新 join，避免短暂离房后成员变成 LEFT 导致竞标/下注被拒
    const next = await api.joinRoom(roomId);
    setState(next);
    setError('');
  }

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    let socket: WebSocket | null = null;
    let refreshTimer: number | null = null;
    stickToBottomRef.current = true;
    didInitialScrollRef.current = false;
    setChannelOpen(false);
    setChat([]);
    const storedClaims = readStoredPacketClaims(roomId);
    packetClaimsRef.current = storedClaims;
    setPacketClaims(storedClaims);
    packetDetailCacheRef.current = {};
    setAnimatedDiceIds({});

    const scheduleRefresh = () => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        void refresh().catch(() => undefined);
      }, 250);
    };

    (async () => {
      try {
        const [me, joined] = await Promise.all([api.me(), api.joinRoom(roomId)]);
        if (cancelled) return;
        setMyUid(me.user.uid);
        setMyProfile({
          nickname: me.user.nickname || me.user.uid,
          avatarUrl: me.user.avatarUrl,
        });
        setState(joined);
        setError('');

        const auth = getToken();
        if (!auth) throw new Error('未登录');
        socket = new WebSocket(roomWsUrl(roomId, auth));
        socketRef.current = socket;

        socket.onmessage = (event) => {
          try {
            const payload = JSON.parse(String(event.data)) as {
              type?: string;
              messages?: ChatMsg[];
              /** chat 事件为消息对象，chat_error 事件为错误文本 */
              message?: ChatMsg | string;
              online?: number;
              nickname?: string;
              amountCents?: string;
              /** tip_thanks 附带祝福语 */
              tipMessage?: string;
              avatarUrl?: string | null;
              user?: { uid: string; nickname: string; avatarUrl?: string | null };
            };
            if (payload.type === 'chat_history' && payload.messages) {
              stickToBottomRef.current = true;
              didInitialScrollRef.current = false;
              // 历史加载可能晚于实时 chat；按 ID 合并，不能覆盖刚收到的对局红包。
              setChat((prev) => {
                const merged = [...payload.messages!];
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
                return merged.sort((left, right) => left.at.localeCompare(right.at));
              });
              const packetIds = [
                ...new Set(
                  payload.messages
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
                  return [...withoutLocal.slice(-99), incoming];
                }
                const existingIndex = prev.findIndex((message) => message.id === incoming.id);
                if (existingIndex >= 0) {
                  return prev.map((message, index) =>
                    index === existingIndex ? { ...message, ...incoming } : message,
                  );
                }
                return [...prev.slice(-99), incoming];
              });
            } else if (
              payload.type === 'chat_update' &&
              payload.message &&
              typeof payload.message === 'object'
            ) {
              const updated = payload.message;
              setChat((prev) => {
                const exists = prev.some((item) => item.id === updated.id);
                if (!exists) return [...prev.slice(-99), updated];
                return prev.map((item) => (item.id === updated.id ? { ...item, ...updated } : item));
              });
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
              if (profile.uid === me.user.uid) {
                setMyProfile({
                  nickname: profile.nickname || profile.uid,
                  avatarUrl: profile.avatarUrl,
                });
              }
              scheduleRefresh();
            } else if (payload.type === 'chat_error' && typeof payload.message === 'string') {
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
            } else if (
              payload.type === 'round' ||
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
        socket.onerror = () => setError('实时连接异常，可点右上角刷新状态');
        socket.onclose = (event) => {
          if (cancelled) return;
          if (event.code === 4401 || event.reason === 'DEVICE_SESSION_EXPIRED') {
            invalidateDeviceSession(
              event.reason === 'DEVICE_SESSION_EXPIRED'
                ? event.reason
                : 'DEVICE_SESSION_EXPIRED',
            );
            return;
          }
          setError('实时连接已断开，请重新进入房间');
        };
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
      if (refreshTimer) window.clearTimeout(refreshTimer);
      socket?.close();
      socketRef.current = null;
      // 不在卸载时 leaveRoom：React 重挂载/切页会把成员打成 LEFT，
      // 导致竞标失败且凑不齐开局人数。主动返回时再离房。
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, navigate]);

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
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [loading]);

  useEffect(() => {
    if (loading) return;
    const el = streamRef.current;
    if (!el) return;
    const force = !didInitialScrollRef.current || stickToBottomRef.current;
    if (!force) return;
    const behavior: ScrollBehavior = didInitialScrollRef.current ? 'smooth' : 'auto';
    const jump = () => {
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
  }, [loading, feed.length, chat.length]);

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

  function sendChat() {
    const content = draft.trim();
    if (!content || !socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    setError('');
    socketRef.current.send(JSON.stringify({ type: 'chat', content }));
    setDraft('');
  }

  function leaveAndGoBack() {
    if (roomId) void api.leaveRoom(roomId).catch(() => undefined);
    navigate(-1);
  }

  function sendSticker(stickerId: string) {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ type: 'sticker', stickerId }));
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

  async function claim(packetId?: string) {
    const activePacketId = state?.round?.packetId;
    if (!activePacketId || (packetId && packetId !== activePacketId)) {
      setError('红包已结束');
      return;
    }
    if (!state.me.canClaim) {
      setError('仅本局庄家与已下注闲家可领取红包');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { url } = await api.claimPacket(activePacketId);
      openExternalLink(url);
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === 'NOT_ELIGIBLE_TO_CLAIM' || err.message.includes('NOT_ELIGIBLE')) {
        setError('仅本局庄家与已下注闲家可领取红包');
      } else {
        setError(err.message || '领取失败');
      }
    } finally {
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
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ type: 'dice' }));
    setDiceSent(true);
    requestAnimationFrame(() => {
      const el = streamRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  const composerHint = chatMuted
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
            <small>
              <i /> 互动中
            </small>
          </div>
          <div className="game-room-header-actions" aria-label="牌桌操作">
            <button
              className="game-room-refresh"
              type="button"
              onClick={() => void refresh()}
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
          {loading && <div className="feed-loading">正在进入互动群…</div>}
          {!loading &&
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
                        <p aria-live="polite">{item.text}</p>
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
                  <ChatAvatar url={item.avatar} name={item.mine ? '我' : item.name} />
                  <div className="feed-chat-body">
                    <div className="feed-chat-name">{item.mine ? '我' : item.name}</div>
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
                  <ChatAvatar url={item.avatar} name={item.mine ? '我' : item.name} />
                  <div className="feed-chat-body">
                    <div className="feed-chat-name">{item.mine ? '我' : item.name}</div>
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
              return (
                <div className="feed-chat theirs" key={item.id}>
                  <ChatAvatar url={item.avatar ?? ASSISTANT_AVATAR} name={senderName} />
                  <div className="feed-chat-body">
                    <div className="feed-chat-name">{senderName}</div>
                    {interactive ? (
                      <button
                        type="button"
                        className={`wx-rp wx-rp-niuniu ${dimmed ? 'opened' : ''}`}
                        disabled={busy || dimmed}
                        onClick={() => void claim(item.packetId)}
                      >
                        <div className="wx-rp-body">
                          <span className="wx-rp-icon" aria-hidden />
                          <div className="wx-rp-copy">
                            <strong>{item.title}</strong>
                            <small>
                              {item.claimable && typeof item.seconds === 'number'
                                ? `${item.subtitle} · ${item.seconds}s`
                                : item.subtitle}
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
            return (
              <article className="feed-score" key={item.id}>
                <header>
                  <strong>第 {item.seqNo} 局成绩单</strong>
                  <span>系统结算</span>
                </header>
                <ul>
                  {item.lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                {item.footer && <footer>{item.footer}</footer>}
              </article>
            );
            })}
        </div>
      </div>

      <div className="game-room-footer">
        {error && <div className="chat-error-bar">{error}</div>}

        {continuation?.mine && continuationSeconds !== null && continuationSeconds > 0 && (
          <div className="game-room-actions compact">
            <button
              className="primary-action"
              type="button"
              disabled={busy}
              onClick={() =>
                void runAction(() => api.continueBanker(roomId, continuation.previousRoundId))
              }
            >
              续庄确认（{continuationSeconds}s）
            </button>
          </div>
        )}

        <ChatComposer
          value={draft}
          onChange={setDraft}
          onSend={sendChat}
          disabled={chatMuted}
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
