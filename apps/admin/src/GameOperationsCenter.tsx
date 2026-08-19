import { useEffect, useMemo, useRef, useState } from 'react';
import { adminRoomWsUrl, del, patch, post, request, rm } from './api';
import VirtualPlayers from './VirtualPlayers';
import GameAdministratorsPanel from './GameAdministratorsPanel';
import {
  GameLeaderboardsAdmin,
  GameRewardsAdmin,
  GameRulesAndConfig,
} from './GameScopedOperations';

type Admin = {
  id: string;
  username: string;
  role: 'SUPER' | 'OPERATOR' | 'REVIEWER' | 'FINANCE';
};

type Row = Record<string, any>;

type ChatMessage = {
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
    | 'COUNTDOWN'
    | string;
  content: string;
  from: { uid: string; nickname: string; avatarUrl?: string | null } | null;
  at: string;
};

type ScoreboardPresentation = {
  title?: string;
  playerAliases?: Record<string, string>;
  playerNotes?: Record<string, string>;
  bankerAlias?: string;
  bankerNote?: string;
  footer?: string;
};

type ScoreboardRevision = {
  id: string;
  revision: number;
  presentation: ScoreboardPresentation;
  renderedChunks: string[];
  reason: string;
  adminId: string;
  createdAt: string;
};

type ScoreboardData = {
  id: string;
  roundId: string;
  roomId: string;
  seqNo: number;
  playerLines: Row[];
  bankerSummary: Row;
  presentation: ScoreboardPresentation;
  presentationRevision: number;
  presentationUpdatedBy: string | null;
  presentationSyncStatus: 'LEGACY' | 'PENDING' | 'SYNCED' | 'FAILED' | 'MESSAGE_EXPIRED';
  presentationSyncError: string | null;
  presentationSyncedAt: string | null;
  publishedChatMessageIds: string[];
  previewChunks: string[];
  createdAt: string;
  updatedAt: string;
  revisions: ScoreboardRevision[];
};

type ScoreboardDraft = {
  title: string;
  playerAliases: Record<string, string>;
  playerNotes: Record<string, string>;
  bankerAlias: string;
  bankerNote: string;
  footer: string;
};

function scoreboardDraftOf(presentation: ScoreboardPresentation): ScoreboardDraft {
  return {
    title: presentation.title ?? '',
    playerAliases: { ...(presentation.playerAliases ?? {}) },
    playerNotes: { ...(presentation.playerNotes ?? {}) },
    bankerAlias: presentation.bankerAlias ?? '',
    bankerNote: presentation.bankerNote ?? '',
    footer: presentation.footer ?? '',
  };
}

function scoreboardPresentationOfDraft(
  draft: ScoreboardDraft,
): ScoreboardPresentation {
  return {
    title: draft.title,
    playerAliases: draft.playerAliases,
    playerNotes: draft.playerNotes,
    bankerAlias: draft.bankerAlias,
    bankerNote: draft.bankerNote,
    footer: draft.footer,
  };
}

function scoreboardSyncCopy(status: ScoreboardData['presentationSyncStatus']) {
  if (status === 'SYNCED') return '已同步';
  if (status === 'PENDING') return '待同步';
  if (status === 'FAILED') return '同步失败';
  if (status === 'MESSAGE_EXPIRED') return '原消息已过期';
  return '历史成绩单';
}

function scoreboardName(line: Row, override?: string) {
  const name = override?.trim() || line.nickname?.trim() || line.tgUsername || `UID${line.uid ?? ''}`;
  return `@${String(name).replace(/^@+/, '')}`;
}

function scoreboardMoney(value: unknown) {
  return value == null ? '—' : `RM ${rm(String(value))}`;
}

function scoreboardOutcome(outcome: unknown) {
  if (outcome === 'PLAYER_WIN') return { symbol: '🟢', label: '赢' };
  if (outcome === 'BANKER_WIN') return { symbol: '🔴', label: '输' };
  return { symbol: '⚪', label: '平' };
}

const packetModeLabel: Record<string, string> = {
  RANDOM: '拼手气',
  EQUAL: '均分',
};

function parseUserPacketContent(raw: string): {
  id: string;
  greeting: string;
  mode: string;
} {
  try {
    const parsed = JSON.parse(raw) as { id?: string; greeting?: string; mode?: string };
    if (parsed?.id) {
      return {
        id: parsed.id,
        greeting: parsed.greeting || '恭喜发财，大吉大利',
        mode: parsed.mode || 'RANDOM',
      };
    }
  } catch {
    // 兼容旧格式：content 直接是 packetId
  }
  return { id: raw, greeting: '恭喜发财，大吉大利', mode: 'RANDOM' };
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
        label: parsed.label || '客服',
        message: parsed.message || '',
      };
    }
  } catch {
    // ignore
  }
  return { amountCents: '0', label: '客服', message: raw };
}

/** 避免把 JSON 结构体直接摊在气泡里 */
function readableChatText(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return content;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      if (parsed.amountCents != null) {
        const tip = parseUserTipContent(trimmed);
        return `打赏 ${tip.label} RM ${rm(tip.amountCents)}${tip.message ? ` · ${tip.message}` : ''}`;
      }
      if (typeof parsed.id === 'string' && (parsed.mode || parsed.greeting)) {
        const packet = parseUserPacketContent(trimmed);
        return `玩家红包 · ${packetModeLabel[packet.mode] ?? packet.mode} · ${packet.greeting}`;
      }
      if (typeof parsed.template === 'string' || parsed.mode === 'lock') {
        return countdownDisplay(trimmed, Date.now());
      }
    }
  } catch {
    // keep original
  }
  return content;
}

type AssistantLease = {
  roomId: string;
  adminId: string;
  adminName: string;
  takenAt: string;
  expiresAt: string;
};

type LeaseState = {
  mode: 'AUTO' | 'ASSISTED' | 'UNAVAILABLE';
  lease: AssistantLease | null;
  heldByMe: boolean;
};

const phaseLabels: Record<string, string> = {
  WAITING: '等待开局',
  BANKER_BID: '庄家竞标',
  BETTING: '闲家下注',
  SENDING_PACKET: '待发红包',
  CLAIMING: '抢包中',
  CLAIM_EXPIRED: '认额复核',
  SETTLING: '结算中',
  FINISHED: '已完成',
  CANCELLED: '已取消',
};

const scoreboardHandLabels: Record<string, string> = {
  BAOZI: '豹子',
  MANNIU: '满牛',
  FANSHUN: '反顺',
  SHUNZI: '顺子',
  DUIZI: '对子',
  JINNIU: '金牛',
  NIUNIU: '牛牛',
  NORMAL: '普通',
  MIANSI: '免死',
};

function scoreboardResultSummary(line: Row) {
  const hand = scoreboardHandLabels[String(line.handType ?? '')] ?? String(line.handType ?? '—');
  const points = Number.isFinite(Number(line.points)) ? `${Number(line.points)} 点` : '';
  return `${hand}${points ? ` · ${points}` : ''} · ${scoreboardOutcome(line.outcome).label}`;
}

const bannerLabels: Record<string, string> = {
  'bet-start': '开始下注',
  'bet-stop': '停止下注',
  'claim-start': '开始抢包',
  'claim-stop': '抢包结束',
};

const activePhases = new Set([
  'WAITING',
  'BANKER_BID',
  'BETTING',
  'SENDING_PACKET',
  'CLAIMING',
  'CLAIM_EXPIRED',
  'SETTLING',
]);

function toCents(value: string) {
  const cleaned = value.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) throw new Error('金额格式无效，请输入如 12.50');
  const [integer, decimal = ''] = cleaned.split('.');
  return String(BigInt(integer || '0') * 100n + BigInt((decimal + '00').slice(0, 2)));
}

const opsErrorMessages: Record<string, string> = {
  VALIDATION: '提交内容格式不正确，请检查 TNG 链接与发包账号',
  INVALID_PACKET_URL:
    '请粘贴完整的 TNG Money Packet 分享链接（形如 https://links.tngdigital.com.my/moneypacket/…）',
  INVALID_PACKET_HOST:
    '该链接域名不被允许。请使用 TNG App 分享的官方链接（links.tngdigital.com.my）',
  INVALID_PHASE: '当前牌局阶段已变化，请刷新后重试',
  BANKER_DICE_NOT_READY: '庄家尚未完成投骰，请稍后再登记红包链接',
  TNG_ACCOUNT_NOT_FOUND: '所选发包账号不存在，请重新选择',
  TNG_ACCOUNT_INACTIVE: '所选发包账号已停用，请更换账号',
  TNG_ACCOUNT_UNAVAILABLE: '所选发包账号不可用，请更换账号',
  TNG_ACCOUNT_LIMIT_EXCEEDED: '所选发包账号已达到月度限额，请更换账号',
};

function explainOpsError(cause: unknown): string {
  const error = cause as Error & {
    code?: string;
    details?: { hostname?: string };
  };
  const code = error.code || error.message;
  if (code === 'INVALID_PACKET_HOST' && error.details?.hostname) {
    return `该链接域名不被允许（${error.details.hostname}）。请使用 links.tngdigital.com.my 的 Money Packet 分享链接`;
  }
  return opsErrorMessages[code] ?? error.message ?? '操作失败，请稍后重试';
}

function explainScoreboardError(cause: unknown): string {
  const error = cause as Error & { code?: string };
  const messages: Record<string, string> = {
    VALIDATION: '成绩单展示格式不正确：请检查文本长度、单行展示名和必填修改原因。',
    SCOREBOARD_PLAYER_NOT_FOUND: '展示配置包含不属于本局的玩家，请刷新成绩单后重试。',
    SCOREBOARD_NOT_FINISHED: '本局尚未完成结算，暂时不能修订成绩单。',
    SCOREBOARD_REVISION_NOT_FOUND: '所选历史版本不存在或已变化，请刷新后重试。',
    SCOREBOARD_SYNC_FAILED: '互动群原成绩单同步失败，请稍后重试。',
  };
  return messages[error.code ?? ''] ?? error.message ?? '成绩单操作失败，请稍后重试';
}

function extractHttpsUrl(value: string): string {
  const match = value.match(/https:\/\/[^\s<>"']+/i);
  return (match?.[0] ?? value).replace(/[),.;，。；）\]\u3002\uFF0C]+$/g, '').trim();
}

function packetUrlError(value: string): string {
  const input = extractHttpsUrl(value);
  if (!input) return '请粘贴 TNG Money Packet 链接';
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:') return '链接必须以 https:// 开头';
    const host = url.hostname.toLowerCase();
    // 官方分享域：links.tngdigital.com.my/moneypacket/<token>
    if (host === 'links.tngdigital.com.my' || host.endsWith('.tngdigital.com.my')) {
      if (!/^\/moneypacket\/[A-Za-z0-9_-]+\/?$/i.test(url.pathname)) {
        return '请粘贴完整的 Money Packet 分享链接（路径需包含 /moneypacket/）';
      }
      return '';
    }
    if (!host.includes('.')) return '请输入完整的 TNG Money Packet 链接';
    return '';
  } catch {
    return '链接格式无效，请从 TNG eWallet 重新复制分享链接';
  }
}

function PhaseBadge({ value }: { value: string }) {
  return <span className={`ops-badge ${value.toLowerCase()}`}>{phaseLabels[value] ?? value}</span>;
}

function ErrorNotice({ error, onClose }: { error: string; onClose: () => void }) {
  if (!error) return null;
  return (
    <div className="ops-error" role="alert">
      <span>{error}</span>
      <button type="button" onClick={onClose} aria-label="关闭错误提示">×</button>
    </div>
  );
}

function OpsPlayerIdentity({
  from,
}: {
  from: ChatMessage['from'];
}) {
  const name = from?.nickname ?? from?.uid ?? '玩家';
  return (
    <>
      <span className="ops-feed-avatar" aria-hidden>
        <b>{name.slice(0, 1)}</b>
        {from?.avatarUrl ? (
          <img
            src={from.avatarUrl}
            alt=""
            loading="lazy"
            onError={(event) => {
              event.currentTarget.style.display = 'none';
            }}
          />
        ) : null}
      </span>
      <span className="ops-feed-author">{name}</span>
    </>
  );
}

function countdownDisplay(content: string, now: number): string {
  try {
    const payload = JSON.parse(content) as {
      mode?: string;
      endsAt?: string;
      template?: string;
      emoji?: string;
    };
    if (payload.mode === 'lock') return payload.emoji || '3';
    const remaining = payload.endsAt
      ? Math.max(0, Math.ceil((new Date(payload.endsAt).getTime() - now) / 1_000))
      : 0;
    const template = payload.template || '⏰ 剩余 {{remaining}} 秒';
    return template.replace(/\{\{\s*remaining\s*\}\}/g, String(remaining));
  } catch {
    return content;
  }
}

function ChatBubble({
  message,
  now,
  assistantName,
}: {
  message: ChatMessage;
  now: number;
  assistantName: string;
}) {
  if (message.type === 'BANNER') {
    return (
      <div className="ops-feed-banner">
        <small>小助手阶段横幅</small>
        <strong>{bannerLabels[message.content] ?? message.content}</strong>
      </div>
    );
  }
  if (message.type === 'DICE') {
    return (
      <div className="ops-feed-player">
        <OpsPlayerIdentity from={message.from} />
        <div className="ops-dice">{message.content}</div>
      </div>
    );
  }
  if (message.type === 'STICKER') {
    return (
      <div className="ops-feed-player">
        <OpsPlayerIdentity from={message.from} />
        <img className="ops-feed-sticker" src={message.content} alt="玩家贴纸" />
      </div>
    );
  }
  if (message.type === 'USER_PACKET') {
    const packet = parseUserPacketContent(message.content);
    return (
      <div className="ops-feed-player">
        <OpsPlayerIdentity from={message.from} />
        <div className="ops-user-packet">
          <strong>玩家红包 · {packetModeLabel[packet.mode] ?? packet.mode}</strong>
          <small>{packet.greeting}</small>
        </div>
        <time>{new Date(message.at).toLocaleTimeString('zh-MY', { hour: '2-digit', minute: '2-digit' })}</time>
      </div>
    );
  }
  if (message.type === 'USER_TIP') {
    const tip = parseUserTipContent(message.content);
    return (
      <div className="ops-feed-player">
        <OpsPlayerIdentity from={message.from} />
        <div className="ops-user-tip">
          <strong>打赏 {tip.label} · RM {rm(tip.amountCents)}</strong>
          {tip.message ? <small>{tip.message}</small> : null}
        </div>
        <time>{new Date(message.at).toLocaleTimeString('zh-MY', { hour: '2-digit', minute: '2-digit' })}</time>
      </div>
    );
  }
  if (message.type === 'COUNTDOWN') {
    const text = countdownDisplay(message.content, now);
    const lock = text.length <= 4;
    return (
      <div className="ops-feed-system">
        <span className="ops-feed-author">{assistantName}</span>
        <div className={`ops-feed-bubble${lock ? ' ops-countdown-lock' : ''}`}>{text}</div>
        <time>{new Date(message.at).toLocaleTimeString('zh-MY', { hour: '2-digit', minute: '2-digit' })}</time>
      </div>
    );
  }
  const system = message.type === 'SYSTEM' || !message.from;
  const text = readableChatText(message.content);
  return (
    <div className={system ? 'ops-feed-system' : 'ops-feed-player'}>
      {system ? (
        <span className="ops-feed-author">{assistantName}</span>
      ) : (
        <OpsPlayerIdentity from={message.from} />
      )}
      <div className="ops-feed-bubble">{text}</div>
      <time>{new Date(message.at).toLocaleTimeString('zh-MY', { hour: '2-digit', minute: '2-digit' })}</time>
    </div>
  );
}

export default function GameOperationsCenter({ admin }: { admin: Admin }) {
  const canOperate = admin.role === 'SUPER' || admin.role === 'OPERATOR';
  const canReconcile = admin.role === 'SUPER' || admin.role === 'FINANCE';
  const canViewScoreboard =
    admin.role === 'SUPER'
    || admin.role === 'OPERATOR'
    || admin.role === 'REVIEWER';
  /** catalog：游戏目录落地页；ops：进入某游戏唯一互动群后的三栏运营台 */
  const [screen, setScreen] = useState<'catalog' | 'ops'>('catalog');
  const [activeTab, setActiveTab] = useState<
    'live' | 'rules' | 'rewards' | 'leaderboards' | 'virtuals' | 'admins'
  >('live');
  const [rooms, setRooms] = useState<Row[]>([]);
  const [rounds, setRounds] = useState<Row[]>([]);
  const [roundsTotal, setRoundsTotal] = useState(0);
  const [roundPage, setRoundPage] = useState(1);
  const [roomHasActiveRound, setRoomHasActiveRound] = useState(false);
  const [detail, setDetail] = useState<Row | null>(null);
  const [accounts, setAccounts] = useState<Row[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState('');
  const [selectedRoundId, setSelectedRoundId] = useState('');
  /** 用户点选牌局后锁定预览，轮询/WS 刷新不得自动跳到别的局 */
  const [roundPinned, setRoundPinned] = useState(false);
  const ROUND_PAGE_SIZE = 20;
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [online, setOnline] = useState(0);
  const [socketState, setSocketState] = useState<'connecting' | 'online' | 'offline'>('offline');
  const [lease, setLease] = useState<LeaseState>({ mode: 'AUTO', lease: null, heldByMe: false });
  const [assistantText, setAssistantText] = useState('');
  const [pinTitle, setPinTitle] = useState('');
  const [pinBody, setPinBody] = useState('');
  const [roomMinPlayers, setRoomMinPlayers] = useState('2');
  const [bankerBidMinRm, setBankerBidMinRm] = useState('100');
  const [claimUrl, setClaimUrl] = useState('');
  const [packetUrlTouched, setPacketUrlTouched] = useState(false);
  const [packerAccount, setPackerAccount] = useState('');
  const [claimDrafts, setClaimDrafts] = useState<Record<string, { tngName: string; amount: string }>>({});
  const [cancelReason, setCancelReason] = useState('');
  const [returnAmount, setReturnAmount] = useState('');
  const [claimedAmount, setClaimedAmount] = useState('');
  const [assistantEnabled, setAssistantEnabled] = useState(true);
  const [botAutoStart, setBotAutoStart] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [scoreboard, setScoreboard] = useState<ScoreboardData | null>(null);
  const [scoreboardDraft, setScoreboardDraft] = useState<ScoreboardDraft | null>(null);
  const [scoreboardReason, setScoreboardReason] = useState('');
  const [scoreboardOpen, setScoreboardOpen] = useState(false);
  const [scoreboardLoading, setScoreboardLoading] = useState(false);
  const [scoreboardError, setScoreboardError] = useState('');
  const [scoreboardPreviewChunks, setScoreboardPreviewChunks] = useState<string[]>([]);
  const [scoreboardPreviewLoading, setScoreboardPreviewLoading] = useState(false);
  const [scoreboardPreviewError, setScoreboardPreviewError] = useState('');
  const [now, setNow] = useState(Date.now());
  const streamRef = useRef<HTMLDivElement | null>(null);
  const chatDeleteTombstonesRef = useRef(new Set<string>());
  const selectedRoomIdRef = useRef('');
  const selectedRoundIdRef = useRef('');
  const roundPinnedRef = useRef(false);
  const roundPageRef = useRef(1);
  const draftRoundIdRef = useRef('');
  const loadGenerationRef = useRef(0);
  const scoreboardRequestSeqRef = useRef(0);
  const scoreboardPreviewSeqRef = useRef(0);
  const scoreboardDirtyRef = useRef(false);
  const roundsTotalPages = Math.max(1, Math.ceil(roundsTotal / ROUND_PAGE_SIZE));
  const scoreboardDirty = !!scoreboard && !!scoreboardDraft && (
    JSON.stringify(scoreboardDraft) !== JSON.stringify(scoreboardDraftOf(scoreboard.presentation))
    || scoreboardReason.trim().length > 0
  );
  scoreboardDirtyRef.current = scoreboardDirty;

  const selectedRoom = rooms.find((room) => room.id === selectedRoomId) ?? null;
  /** 系统红包模式：至尊牛牛小助手自动发包，玩家群内直抢并即时入余额 */
  const internalPacketMode = selectedRoom?.packetChannel === 'INTERNAL';
  const roomStartMode = String(
    selectedRoom?.roundStartMode
    ?? selectedRoom?.botService?.roundStartMode
    ?? (botAutoStart ? 'AUTO' : 'MANUAL'),
  ) as 'MANUAL' | 'AUTO' | 'STOPPED';
  const roomGloballyMuted = Boolean(selectedRoom?.chatMutedAt);
  const frozenBets = detail?.bets?.filter((bet: Row) => bet.status === 'FROZEN') ?? [];
  const expectedClaims = (detail?.bankerId ? 1 : 0) + frozenBets.length;
  const claimReview = !!detail && ['CLAIMING', 'CLAIM_EXPIRED'].includes(detail.phase);
  const claimReady =
    claimReview &&
    expectedClaims > 0 &&
    (detail?.claims?.length ?? 0) === expectedClaims;
  const hasActiveRound =
    roomHasActiveRound
    || rounds.some((round) => activePhases.has(round.phase) && round.phase !== 'WAITING');
  const canStartRound = !!selectedRoom && selectedRoom.status === 'ACTIVE' && !hasActiveRound;
  const isTerminalRound = !!detail && (detail.phase === 'FINISHED' || detail.phase === 'CANCELLED');
  const isLiveControlRound = !!detail && activePhases.has(detail.phase) && detail.phase !== 'WAITING';
  const canMutateRound = canOperate && !!detail && !isTerminalRound && detail.phase !== 'WAITING';
  const bankerName =
    detail?.bids?.find((bid: Row) => bid.userId === detail.bankerId)?.user?.nickname
    ?? detail?.claims?.find((entry: Row) => entry.userId === detail.bankerId)?.user?.nickname
    ?? detail?.bankerId?.slice(-6)
    ?? '—';
  const replayAllowed = !!detail && (
    (activePhases.has(detail.phase)
      && rounds.find((round) => activePhases.has(round.phase))?.id === detail.id)
    || (detail.phase === 'FINISHED'
      && rounds.find((round) => round.phase === 'FINISHED')?.id === detail.id)
  );
  const claimUrlError = useMemo(() => packetUrlError(claimUrl), [claimUrl]);

  const remaining = useMemo(() => {
    if (!detail) return null;
    const raw =
      detail.phase === 'BANKER_BID'
        ? detail.bidEndsAt
        : detail.phase === 'BETTING'
          ? detail.betEndsAt
          : detail.phase === 'CLAIMING'
            ? detail.claimEndsAt
            : null;
    if (!raw) return null;
    return Math.max(0, Math.ceil((new Date(raw).getTime() - now) / 1_000));
  }, [detail, now]);

  function mergeClaimDrafts(next: Row) {
    const sameRound = draftRoundIdRef.current === next.id;
    draftRoundIdRef.current = next.id;
    setClaimDrafts((previous) => {
      const drafts = sameRound ? { ...previous } : {};
      const bankerBid = next.bids?.find((bid: Row) => bid.userId === next.bankerId);
      const syncRow = (userId: string, claim: Row | undefined, fallbackName: string) => {
        const existing = drafts[userId];
        if (!claim) {
          drafts[userId] = {
            tngName: existing?.tngName ?? fallbackName,
            amount: existing?.amount ?? '',
          };
          return;
        }
        const serverAmount = rm(claim.amountCents);
        const serverName = claim.tngName ?? fallbackName;
        // 正在改的草稿不要被轮询/WS 用服务端旧值盖掉，否则小数点填不进去
        drafts[userId] = {
          tngName: existing && existing.tngName !== serverName ? existing.tngName : serverName,
          amount: existing && existing.amount !== serverAmount ? existing.amount : serverAmount,
        };
      };
      if (next.bankerId) {
        syncRow(
          next.bankerId,
          next.claims?.find((entry: Row) => entry.userId === next.bankerId),
          bankerBid?.user?.nickname ?? '',
        );
      }
      for (const bet of (next.bets ?? []).filter((entry: Row) => entry.status === 'FROZEN')) {
        syncRow(
          bet.userId,
          next.claims?.find((entry: Row) => entry.userId === bet.userId),
          bet.user?.nickname ?? '',
        );
      }
      return drafts;
    });
  }

  function resetRoomScopedDrafts() {
    setAssistantText('');
    setPinTitle('');
    setPinBody('');
    setClaimUrl('');
    setPacketUrlTouched(false);
    setCancelReason('');
    setReturnAmount('');
    setClaimedAmount('');
    setClaimDrafts({});
    draftRoundIdRef.current = '';
  }

  async function loadRooms(preferredRoomId = selectedRoomId) {
    // 运营中心按「游戏目录」加载：一款游戏最多绑定一个互动群，禁止出现同游戏多牌桌。
    const response = await request<{
      items: Row[];
      botService?: {
        assistantEnabled?: boolean;
        autoStart?: boolean;
        roundStartMode?: 'MANUAL' | 'AUTO' | 'STOPPED';
      };
    }>('/api/admin/games');
    if (typeof response.botService?.assistantEnabled === 'boolean') {
      setAssistantEnabled(response.botService.assistantEnabled);
    }
    if (typeof response.botService?.autoStart === 'boolean') {
      setBotAutoStart(response.botService.autoStart);
    }
    const mapped = response.items
      .filter((game) => game.room)
      .map((game) => ({
        id: game.room.id as string,
        gameCode: game.code as string,
        title: game.title as string,
        status: game.room.status as string,
        minPlayers: game.room.minPlayers as number,
        roundStartMode:
          game.room.roundStartMode
          ?? game.botService?.roundStartMode
          ?? (game.botService?.autoStart ? 'AUTO' : 'MANUAL'),
        chatMutedAt: game.room.chatMutedAt ?? null,
        chatMuteReason: game.room.chatMuteReason ?? null,
        botService: game.botService,
        packetChannel: (game.packetChannel as string) === 'INTERNAL' ? 'INTERNAL' : 'TNG',
        bankerBidMinCents: Number(game.bankerBidMinCents ?? 10_000),
        bankerBidMaxCents: Number(game.bankerBidMaxCents ?? 100_000_000),
        game: {
          code: game.code,
          title: game.title,
          interactionGroupTitle: game.interactionGroupTitle,
          engine: game.engine,
          rulesNamespace: game.rulesNamespace,
        },
        _count: {
          members: game.room.members as number,
          rounds: game.room.rounds as number,
        },
      }));
    setRooms(mapped);
    const nextRoom =
      mapped.find((room) => room.id === preferredRoomId)
      ?? mapped.find((room) => room.status === 'ACTIVE')
      ?? mapped[0];
    if (nextRoom && nextRoom.id !== selectedRoomIdRef.current) {
      selectedRoomIdRef.current = nextRoom.id;
      setSelectedRoomId(nextRoom.id);
    }
  }

  async function loadContext(
    roomId = selectedRoomId,
    preferredRoundId?: string,
    page = roundPageRef.current,
  ) {
    if (!roomId) return;
    const generation = ++loadGenerationRef.current;
    const pageToLoad = Math.max(1, page);
    const [roundResponse, accountResponse, leaseResponse] = await Promise.all([
      request<{
        items: Row[];
        total: number;
        page: number;
        pageSize: number;
        hasActiveRound?: boolean;
      }>(
        `/api/admin/rounds?roomId=${encodeURIComponent(roomId)}&page=${pageToLoad}&pageSize=${ROUND_PAGE_SIZE}`,
      ),
      request<{ items: Row[] }>('/api/admin/tng/accounts').catch(() => ({ items: [] })),
      request<LeaseState>(`/api/admin/rooms/${roomId}/assistant/status`).catch(
        () => ({ mode: 'UNAVAILABLE' as const, lease: null, heldByMe: false }),
      ),
    ]);
    if (generation !== loadGenerationRef.current || selectedRoomIdRef.current !== roomId) return;

    setRounds(roundResponse.items);
    setRoundsTotal(roundResponse.total ?? roundResponse.items.length);
    setRoomHasActiveRound(Boolean(roundResponse.hasActiveRound));
    roundPageRef.current = roundResponse.page ?? pageToLoad;
    setRoundPage(roundPageRef.current);
    const activeAccounts = accountResponse.items.filter((item) => item.status === 'ACTIVE');
    setAccounts(activeAccounts);
    setPackerAccount((current) =>
      activeAccounts.some((item) => item.id === current) ? current : activeAccounts[0]?.id || '',
    );
    setLease(leaseResponse);

    const desiredRoundId = preferredRoundId || selectedRoundIdRef.current;
    const desiredRound = desiredRoundId
      ? roundResponse.items.find((round) => round.id === desiredRoundId)
      : undefined;
    // 用户点选锁定后只刷新该局；未锁定时跟随进行中/等待中的局。
    let nextRound = desiredRound;
    if (!roundPinnedRef.current) {
      nextRound =
        desiredRound
        ?? roundResponse.items.find((round) => activePhases.has(round.phase) && round.phase !== 'WAITING')
        ?? roundResponse.items.find((round) => round.phase === 'WAITING')
        ?? roundResponse.items[0];
    } else if (!nextRound && desiredRoundId) {
      // 锁定的局仍在列表外（极少见）时保留当前 detail，避免跳到别局。
      return;
    }
    if (!nextRound) {
      selectedRoundIdRef.current = '';
      setSelectedRoundId('');
      setDetail(null);
      scoreboardRequestSeqRef.current += 1;
      setScoreboard(null);
      setScoreboardDraft(null);
      setScoreboardReason('');
      setScoreboardOpen(false);
      return;
    }
    const changingRound = selectedRoundIdRef.current !== nextRound.id;
    selectedRoundIdRef.current = nextRound.id;
    setSelectedRoundId(nextRound.id);
    if (changingRound) {
      scoreboardRequestSeqRef.current += 1;
      setDetail(null);
      setScoreboard(null);
      setScoreboardDraft(null);
      setScoreboardReason('');
      setScoreboardError('');
      setScoreboardOpen(false);
    }
    const nextDetail = await request<Row>(`/api/admin/rounds/${nextRound.id}`);
    if (
      generation !== loadGenerationRef.current
      || selectedRoomIdRef.current !== roomId
      || selectedRoundIdRef.current !== nextRound.id
    ) {
      return;
    }
    setDetail(nextDetail);
    mergeClaimDrafts(nextDetail);
  }

  async function loadScoreboard(roundId: string, preserveDraft = false) {
    const requestSeq = ++scoreboardRequestSeqRef.current;
    if (!preserveDraft) {
      setScoreboard(null);
      setScoreboardDraft(null);
    }
    setScoreboardLoading(true);
    try {
      const response = await request<{ scoreboard: ScoreboardData }>(
        `/api/admin/rounds/${roundId}/scoreboard`,
      );
      if (
        selectedRoundIdRef.current !== roundId
        || scoreboardRequestSeqRef.current !== requestSeq
      ) {
        return;
      }
      setScoreboard(response.scoreboard);
      setScoreboardDraft((current) =>
        preserveDraft && scoreboardDirtyRef.current && current
          ? current
          : scoreboardDraftOf(response.scoreboard.presentation),
      );
      setScoreboardError('');
    } catch (cause) {
      if (
        selectedRoundIdRef.current !== roundId
        || scoreboardRequestSeqRef.current !== requestSeq
      ) {
        return;
      }
      const code = (cause as { code?: string }).code;
      if (code === 'SCOREBOARD_NOT_FOUND') {
        setScoreboard(null);
        setScoreboardDraft(null);
      } else if (code === 'FORBIDDEN') {
        setScoreboard(null);
        setScoreboardDraft(null);
        setScoreboardError('当前角色没有查看运营成绩单的权限。');
      } else {
        setScoreboardError((cause as Error).message);
      }
    } finally {
      if (
        selectedRoundIdRef.current === roundId
        && scoreboardRequestSeqRef.current === requestSeq
      ) {
        setScoreboardLoading(false);
      }
    }
  }

  useEffect(() => {
    void loadRooms().catch((cause) => setError((cause as Error).message));
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedRoomId || screen !== 'ops' || activeTab !== 'live') return;
    selectedRoomIdRef.current = selectedRoomId;
    loadGenerationRef.current += 1;
    setChat([]);
    chatDeleteTombstonesRef.current.clear();
    setOnline(0);
    setDetail(null);
    selectedRoundIdRef.current = '';
    setSelectedRoundId('');
    roundPinnedRef.current = false;
    setRoundPinned(false);
    roundPageRef.current = 1;
    setRoundPage(1);
    setRoundsTotal(0);
    resetRoomScopedDrafts();
    void loadContext(selectedRoomId, undefined, 1).catch((cause) => setError((cause as Error).message));
    const timer = window.setInterval(
      () => void loadContext(selectedRoomId, undefined, roundPageRef.current).catch(() => undefined),
      5_000,
    );
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRoomId, screen, activeTab]);

  useEffect(() => {
    if (!selectedRoom) return;
    setRoomMinPlayers(String(selectedRoom.minPlayers));
    const minCents = Number(selectedRoom.bankerBidMinCents ?? 10_000);
    setBankerBidMinRm(Number.isFinite(minCents) ? (minCents / 100).toFixed(2).replace(/\.00$/, '') : '100');
    if (typeof selectedRoom.botService?.assistantEnabled === 'boolean') {
      setAssistantEnabled(selectedRoom.botService.assistantEnabled);
    }
    if (typeof selectedRoom.botService?.autoStart === 'boolean') {
      setBotAutoStart(selectedRoom.botService.autoStart);
    }
  }, [
    selectedRoom?.id,
    selectedRoom?.minPlayers,
    selectedRoom?.bankerBidMinCents,
    selectedRoom?.botService?.assistantEnabled,
    selectedRoom?.botService?.autoStart,
  ]);

  useEffect(() => {
    scoreboardRequestSeqRef.current += 1;
    setScoreboardOpen(false);
    setScoreboardReason('');
    setScoreboardError('');
    if (detail?.phase === 'FINISHED' && detail.id && canViewScoreboard) {
      void loadScoreboard(detail.id);
      return;
    }
    setScoreboard(null);
    setScoreboardDraft(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.id, detail?.phase, canViewScoreboard]);

  useEffect(() => {
    if (
      !canViewScoreboard
      || detail?.phase !== 'FINISHED'
      || !detail.id
      || !scoreboard
      || scoreboard.roundId !== detail.id
      || !detail.scoreboard
    ) {
      return;
    }
    if (
      detail.scoreboard.presentationRevision !== scoreboard.presentationRevision
      || detail.scoreboard.presentationSyncStatus !== scoreboard.presentationSyncStatus
      || String(detail.scoreboard.updatedAt ?? '') !== String(scoreboard.updatedAt ?? '')
    ) {
      void loadScoreboard(detail.id, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    detail?.id,
    detail?.phase,
    detail?.scoreboard?.presentationRevision,
    detail?.scoreboard?.presentationSyncStatus,
    detail?.scoreboard?.updatedAt,
    canViewScoreboard,
  ]);

  useEffect(() => {
    if (
      !canViewScoreboard
      || detail?.phase !== 'FINISHED'
      || !detail.id
      || !detail.scoreboard
      || scoreboard
      || scoreboardLoading
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      void loadScoreboard(detail.id, true);
    }, 5_000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    detail?.id,
    detail?.phase,
    detail?.scoreboard?.presentationRevision,
    detail?.scoreboard?.presentationSyncStatus,
    detail?.scoreboard?.updatedAt,
    scoreboard,
    scoreboardLoading,
    canViewScoreboard,
  ]);

  useEffect(() => {
    const requestSeq = ++scoreboardPreviewSeqRef.current;
    setScoreboardPreviewError('');
    if (!scoreboard || !scoreboardDraft) {
      setScoreboardPreviewChunks([]);
      setScoreboardPreviewLoading(false);
      return;
    }
    if (!canOperate) {
      setScoreboardPreviewChunks(scoreboard.previewChunks);
      setScoreboardPreviewLoading(false);
      return;
    }
    const roundId = scoreboard.roundId;
    setScoreboardPreviewLoading(true);
    const timer = window.setTimeout(() => {
      void post<{ previewChunks: string[] }>(
        `/api/admin/rounds/${roundId}/scoreboard/preview`,
        { presentation: scoreboardPresentationOfDraft(scoreboardDraft) },
      )
        .then((response) => {
          if (
            scoreboardPreviewSeqRef.current !== requestSeq
            || selectedRoundIdRef.current !== roundId
          ) {
            return;
          }
          setScoreboardPreviewChunks(response.previewChunks);
          setScoreboardPreviewError('');
        })
        .catch((cause) => {
          if (
            scoreboardPreviewSeqRef.current !== requestSeq
            || selectedRoundIdRef.current !== roundId
          ) {
            return;
          }
          setScoreboardPreviewError(explainScoreboardError(cause));
        })
        .finally(() => {
          if (
            scoreboardPreviewSeqRef.current === requestSeq
            && selectedRoundIdRef.current === roundId
          ) {
            setScoreboardPreviewLoading(false);
          }
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [scoreboard, scoreboardDraft, canOperate]);

  useEffect(() => {
    if (!selectedRoomId || screen !== 'ops' || activeTab !== 'live') return;
    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let pingTimer: number | null = null;
    const roomId = selectedRoomId;

    const connect = async () => {
      if (stopped) return;
      setSocketState('connecting');
      try {
        const url = await adminRoomWsUrl(roomId);
        if (stopped || selectedRoomIdRef.current !== roomId) return;
        socket = new WebSocket(url);
      } catch {
        setSocketState('offline');
        if (!stopped) reconnectTimer = window.setTimeout(() => void connect(), 2_000);
        return;
      }
      socket.onopen = () => {
        setSocketState('online');
        pingTimer = window.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
        }, 20_000);
      };
      socket.onmessage = (event) => {
        if (selectedRoomIdRef.current !== roomId) return;
        try {
          const payload = JSON.parse(String(event.data)) as {
            type?: string;
            messages?: ChatMessage[];
            message?: ChatMessage;
            messageId?: string;
            online?: number;
            mode?: 'AUTO' | 'ASSISTED' | 'UNAVAILABLE';
            lease?: AssistantLease | null;
            heldByMe?: boolean;
            autoStart?: boolean;
            assistantEnabled?: boolean;
            roundStartMode?: 'MANUAL' | 'AUTO' | 'STOPPED';
            muted?: boolean;
            mutedAt?: string | null;
            reason?: string | null;
          };
          if (payload.type === 'chat_history' && payload.messages) {
            const tombstones = chatDeleteTombstonesRef.current;
            setChat(payload.messages.filter((message) => !tombstones.has(message.id)));
          } else if (payload.type === 'chat' && payload.message) {
            chatDeleteTombstonesRef.current.delete(payload.message.id);
            setChat((previous) => {
              if (previous.some((item) => item.id === payload.message?.id)) return previous;
              return [...previous.slice(-99), payload.message!];
            });
          } else if (payload.type === 'chat_update' && payload.message) {
            const updated = payload.message;
            if (chatDeleteTombstonesRef.current.has(updated.id)) return;
            setChat((previous) =>
              previous.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)),
            );
          } else if (payload.type === 'chat_delete' && payload.messageId) {
            chatDeleteTombstonesRef.current.add(payload.messageId);
            setChat((previous) =>
              previous.filter((message) => message.id !== payload.messageId),
            );
          } else if (payload.type === 'presence' && typeof payload.online === 'number') {
            setOnline(payload.online);
          } else if (payload.type === 'assistant_lease') {
            setLease({
              mode: payload.mode ?? (payload.lease ? 'ASSISTED' : 'AUTO'),
              lease: payload.lease ?? null,
              heldByMe: payload.heldByMe ?? payload.lease?.adminId === admin.id,
            });
          } else if (payload.type === 'bot_service') {
            if (typeof payload.assistantEnabled === 'boolean') {
              setAssistantEnabled(payload.assistantEnabled);
            }
            if (typeof payload.autoStart === 'boolean') {
              setBotAutoStart(payload.autoStart);
            }
            if (payload.roundStartMode) {
              setRooms((current) =>
                current.map((room) =>
                  room.id === roomId
                    ? { ...room, roundStartMode: payload.roundStartMode }
                    : room,
                ),
              );
            }
          } else if (payload.type === 'room_moderation' && typeof payload.muted === 'boolean') {
            setRooms((current) =>
              current.map((room) =>
                room.id === roomId
                  ? {
                      ...room,
                      chatMutedAt: payload.muted
                        ? payload.mutedAt ?? new Date().toISOString()
                        : null,
                      chatMuteReason: payload.muted ? payload.reason ?? null : null,
                    }
                  : room,
              ),
            );
          } else if (['round', 'claim', 'activity', 'reward'].includes(payload.type ?? '')) {
            void loadContext(roomId).catch(() => undefined);
          }
        } catch {
          // 忽略非协议消息。
        }
      };
      socket.onerror = () => setSocketState('offline');
      socket.onclose = () => {
        setSocketState('offline');
        if (pingTimer) window.clearInterval(pingTimer);
        if (!stopped) reconnectTimer = window.setTimeout(() => void connect(), 2_000);
      };
    };

    void connect();
    return () => {
      stopped = true;
      if (pingTimer) window.clearInterval(pingTimer);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRoomId, admin.id, screen, activeTab]);

  useEffect(() => {
    if (!lease.heldByMe || !selectedRoomId) return;
    const roomId = selectedRoomId;
    const timer = window.setInterval(() => {
      void post<LeaseState>(`/api/admin/rooms/${roomId}/assistant/heartbeat`, {})
        .then((next) => {
          if (selectedRoomIdRef.current === roomId) setLease(next);
        })
        .catch(() => {
          if (selectedRoomIdRef.current === roomId) {
            setLease({ mode: 'UNAVAILABLE', lease: null, heldByMe: false });
          }
        });
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [lease.heldByMe, selectedRoomId]);

  useEffect(() => {
    const element = streamRef.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  }, [chat.length]);

  async function run(name: string, task: () => Promise<void>) {
    setBusy(name);
    setError('');
    try {
      await task();
      try {
        await Promise.all([
          loadRooms(selectedRoomIdRef.current),
          loadContext(selectedRoomIdRef.current, selectedRoundIdRef.current),
        ]);
      } catch {
        // 主操作已成功时，刷新失败不伪装成操作失败，避免重复提交。
      }
    } catch (cause) {
      setError(explainOpsError(cause));
    } finally {
      setBusy('');
    }
  }

  function acceptScoreboard(next: ScoreboardData, preserveDraft = false) {
    if (selectedRoundIdRef.current !== next.roundId) return;
    setScoreboard(next);
    setScoreboardDraft((current) =>
      preserveDraft && scoreboardDirtyRef.current && current
        ? current
        : scoreboardDraftOf(next.presentation),
    );
    setRounds((current) =>
      current.map((round) =>
        round.id === next.roundId
          ? {
              ...round,
              scoreboard: {
                ...(round.scoreboard ?? {}),
                id: next.id,
                presentationRevision: next.presentationRevision,
                presentationSyncStatus: next.presentationSyncStatus,
                presentationSyncError: next.presentationSyncError,
              },
            }
          : round,
      ),
    );
  }

  async function saveScoreboard() {
    if (!scoreboard || !scoreboardDraft || scoreboardReason.trim().length < 4) return;
    const roundId = scoreboard.roundId;
    scoreboardRequestSeqRef.current += 1;
    setBusy('scoreboard-save');
    setScoreboardError('');
    try {
      const response = await patch<{ ok: true; scoreboard: ScoreboardData }>(
        `/api/admin/rounds/${roundId}/scoreboard`,
        {
          expectedRevision: scoreboard.presentationRevision,
          reason: scoreboardReason.trim(),
          presentation: scoreboardPresentationOfDraft(scoreboardDraft),
        },
      );
      if (selectedRoundIdRef.current !== roundId) return;
      acceptScoreboard(response.scoreboard);
      setScoreboardReason('');
    } catch (cause) {
      if (selectedRoundIdRef.current !== roundId) return;
      const code = (cause as { code?: string }).code;
      if (code === 'SCOREBOARD_REVISION_CONFLICT') {
        await loadScoreboard(roundId, true);
        if (selectedRoundIdRef.current !== roundId) return;
        setScoreboardError('该成绩单已被其他管理员修改。已为你刷新最新版本，请核对后重新保存。');
      } else if (code === 'SCOREBOARD_SYNC_FAILED') {
        await loadScoreboard(roundId, true);
        if (selectedRoundIdRef.current !== roundId) return;
        setScoreboardError('展示版本已经保存，但互动群原消息同步失败。请检查状态后点击“重试同步”。');
      } else {
        setScoreboardError(explainScoreboardError(cause));
      }
    } finally {
      setBusy('');
    }
  }

  async function retryScoreboardSync() {
    if (!scoreboard) return;
    const roundId = scoreboard.roundId;
    scoreboardRequestSeqRef.current += 1;
    setBusy('scoreboard-sync');
    setScoreboardError('');
    try {
      const response = await post<{ ok: true; scoreboard: ScoreboardData }>(
        `/api/admin/rounds/${roundId}/scoreboard/sync`,
        {},
      );
      if (selectedRoundIdRef.current !== roundId) return;
      acceptScoreboard(response.scoreboard, true);
    } catch (cause) {
      if (selectedRoundIdRef.current !== roundId) return;
      const message = explainScoreboardError(cause);
      await loadScoreboard(roundId, true);
      if (selectedRoundIdRef.current !== roundId) return;
      setScoreboardError(message);
    } finally {
      setBusy('');
    }
  }

  async function restoreScoreboardRevision(revision: number) {
    if (
      !scoreboard
      || scoreboardReason.trim().length < 4
      || !window.confirm(`恢复到展示版本 v${revision}？系统会创建一个新版本并同步小助手原消息。`)
    ) {
      return;
    }
    const roundId = scoreboard.roundId;
    scoreboardRequestSeqRef.current += 1;
    setBusy(`scoreboard-restore-${revision}`);
    setScoreboardError('');
    try {
      const response = await post<{ ok: true; scoreboard: ScoreboardData }>(
        `/api/admin/rounds/${roundId}/scoreboard/revisions/${revision}/restore`,
        {
          expectedRevision: scoreboard.presentationRevision,
          reason: scoreboardReason.trim(),
        },
      );
      if (selectedRoundIdRef.current !== roundId) return;
      acceptScoreboard(response.scoreboard);
      setScoreboardReason('');
    } catch (cause) {
      if (selectedRoundIdRef.current !== roundId) return;
      const code = (cause as { code?: string }).code;
      if (code === 'SCOREBOARD_REVISION_CONFLICT') {
        await loadScoreboard(roundId, true);
        if (selectedRoundIdRef.current !== roundId) return;
        setScoreboardError('恢复失败：成绩单已有新版本，已刷新最新数据。');
      } else if (code === 'SCOREBOARD_SYNC_FAILED') {
        await loadScoreboard(roundId, true);
        if (selectedRoundIdRef.current !== roundId) return;
        setScoreboardError('旧版本已恢复为新的展示版本，但互动群同步失败，请重试同步。');
      } else {
        setScoreboardError(explainScoreboardError(cause));
      }
    } finally {
      setBusy('');
    }
  }

  function enterGame(roomId: string) {
    selectedRoomIdRef.current = roomId;
    setSelectedRoomId(roomId);
    setScreen('ops');
    setActiveTab('live');
    setError('');
  }

  function backToCatalog() {
    setScreen('catalog');
    setError('');
    setChat([]);
    setDetail(null);
    setSocketState('offline');
    setActiveTab('live');
  }

  /** 只切换右侧牌局数据预览，不离开运营台、不改路由。 */
  async function chooseRound(id: string) {
    const roomId = selectedRoomIdRef.current;
    selectedRoundIdRef.current = id;
    setSelectedRoundId(id);
    scoreboardRequestSeqRef.current += 1;
    setDetail(null);
    setScoreboard(null);
    setScoreboardDraft(null);
    setScoreboardReason('');
    setScoreboardError('');
    setScoreboardOpen(false);
    roundPinnedRef.current = true;
    setRoundPinned(true);
    setError('');
    const generation = ++loadGenerationRef.current;
    try {
      const next = await request<Row>(`/api/admin/rounds/${id}`);
      if (
        generation !== loadGenerationRef.current
        || selectedRoomIdRef.current !== roomId
        || selectedRoundIdRef.current !== id
      ) {
        return;
      }
      setDetail(next);
      mergeClaimDrafts(next);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  async function initializeSupremeNiuNiu() {
    setBusy('initialize-game');
    setError('');
    try {
      // 正常情况下服务启动会自动建群；这里仅作人工兜底，且后端禁止重复建同游戏群。
      const result = await post<{ id: string }>('/api/admin/rooms', {
        gameCode: 'SUPREME_NIUNIU',
        minPlayers: 2,
      });
      await loadRooms(result.id);
      enterGame(result.id);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      if (code === 'GAME_ALREADY_HAS_INTERACTION_GROUP') {
        await loadRooms();
        return;
      }
      setError((cause as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function takeOverAssistant() {
    await run('takeover', async () => {
      const next = await post<LeaseState>(`/api/admin/rooms/${selectedRoomId}/assistant/takeover`, {});
      setLease(next);
    });
  }

  async function releaseAssistant(force = false) {
    await run('release', async () => {
      const next = await post<LeaseState>(`/api/admin/rooms/${selectedRoomId}/assistant/release`, { force });
      setLease(next);
    });
  }

  async function forceTakeOverAssistant() {
    await run('force-takeover', async () => {
      const next = await post<LeaseState>(
        `/api/admin/rooms/${selectedRoomId}/assistant/force-takeover`,
        {},
      );
      setLease(next);
    });
  }

  async function sendAssistantText() {
    const content = assistantText.trim();
    if (!content) return;
    await run('assistant-message', async () => {
      await post(`/api/admin/rooms/${selectedRoomId}/assistant/messages`, { kind: 'TEXT', content });
      setAssistantText('');
    });
  }

  async function sendBanner(key: string) {
    await run(`banner-${key}`, async () => {
      await post(`/api/admin/rooms/${selectedRoomId}/assistant/messages`, { kind: 'BANNER', key });
    });
  }

  async function replayPhase() {
    if (!detail) return;
    await run('replay', async () => {
      await post(`/api/admin/rooms/${selectedRoomId}/assistant/replay`, { roundId: detail.id });
    });
  }

  async function publishPin() {
    if (!pinTitle.trim() || !pinBody.trim()) return;
    await run('pin', async () => {
      await post(`/api/admin/rooms/${selectedRoomId}/assistant/pin`, {
        title: pinTitle.trim(),
        body: pinBody.trim(),
      });
      setPinTitle('');
      setPinBody('');
    });
  }

  async function removePin() {
    await run('unpin', async () => {
      await del(`/api/admin/rooms/${selectedRoomId}/assistant/pin`);
    });
  }

  async function roundAction(action: string, extra: Row = {}) {
    if (!detail || !canOperate) return;
    const confirmations: Record<string, string> = {
      close_bidding: '确认提前结束竞标？尚未出价的玩家将失去本局竞标机会。',
      close_betting: '确认提前封盘？尚未下注的玩家将无法参与本局。',
      settle: '已复核全部 TNG 姓名与金额，确认结算并公布成绩单？',
      cancel: '确认取消本局并退回全部冻结金额？若 TNG 已发出，仍需财务核销。',
    };
    if (confirmations[action] && !window.confirm(confirmations[action])) return;
    await run(`round-${action}`, async () => {
      const response = await post<{ warnings?: string[] }>(
        `/api/admin/rounds/${detail.id}/action`,
        { action, ...extra },
      );
      if (response.warnings?.length) {
        setError(`主操作已完成，但后续任务异常：${response.warnings.join('、')}。系统将自动补偿，请值班人员复核。`);
      }
      if (action === 'cancel') setCancelReason('');
    });
  }

  async function submitPacket() {
    setPacketUrlTouched(true);
    if (!detail || !packerAccount || !canOperate) return;
    const normalizedUrl = extractHttpsUrl(claimUrl);
    if (normalizedUrl !== claimUrl.trim()) setClaimUrl(normalizedUrl);
    const urlError = packetUrlError(normalizedUrl);
    if (urlError) {
      setError(urlError);
      return;
    }
    await run('packet', async () => {
      await post(`/api/admin/rounds/${detail.id}/packet`, {
        claimUrl: normalizedUrl,
        packerAccount,
      });
      setClaimUrl('');
      setPacketUrlTouched(false);
    });
  }

  function setDraft(userId: string, values: Partial<{ tngName: string; amount: string }>) {
    setClaimDrafts((previous) => ({
      ...previous,
      [userId]: {
        tngName: previous[userId]?.tngName ?? '',
        amount: previous[userId]?.amount ?? '',
        ...values,
      },
    }));
  }

  async function submitClaim(userId: string) {
    if (!detail || !canOperate) return;
    const draft = claimDrafts[userId];
    if (!draft?.tngName.trim() || !draft.amount.trim()) {
      setError('请填写 TNG 显示姓名与领取金额');
      return;
    }
    await run(`claim-${userId}`, async () => {
      try {
        await post(`/api/admin/rounds/${detail.id}/claims`, {
          userId,
          tngName: draft.tngName.trim(),
          amountCents: toCents(draft.amount),
          forceMatch: false,
        });
      } catch (cause) {
        if ((cause as { code?: string }).code !== 'TNG_NAME_MISMATCH') throw cause;
        const reason = window.prompt('姓名与实名不一致。确认归属后填写强制匹配原因（至少 4 字）') ?? '';
        if (reason.trim().length < 4) throw cause;
        await post(`/api/admin/rounds/${detail.id}/claims`, {
          userId,
          tngName: draft.tngName.trim(),
          amountCents: toCents(draft.amount),
          forceMatch: true,
          matchOverrideReason: reason.trim(),
        });
      }
    });
  }

  async function correctClaim(entry: Row) {
    if (!detail || !canOperate) return;
    const draft = claimDrafts[entry.userId] ?? {
      tngName: entry.tngName ?? '',
      amount: rm(entry.amountCents),
    };
    const reason = window.prompt('更正原因（必填，至少 4 字）') ?? '';
    if (reason.trim().length < 4) return;
    await run(`correct-${entry.id}`, async () => {
      try {
        await post(`/api/admin/claims/${entry.id}/correct`, {
          tngName: draft.tngName.trim(),
          amountCents: toCents(draft.amount),
          reason: reason.trim(),
          forceMatch: false,
        });
      } catch (cause) {
        if ((cause as { code?: string }).code !== 'TNG_NAME_MISMATCH') throw cause;
        if (!window.confirm('姓名与实名不一致，确认已核实归属并强制更正？')) return;
        await post(`/api/admin/claims/${entry.id}/correct`, {
          tngName: draft.tngName.trim(),
          amountCents: toCents(draft.amount),
          reason: reason.trim(),
          forceMatch: true,
        });
      }
    });
  }

  async function forfeit(userId: string) {
    if (!detail || !canOperate) return;
    if (!window.confirm('确认该闲家未领取并退注离席？下注冻结将原路退回。')) return;
    await run(`forfeit-${userId}`, async () => {
      await post(`/api/admin/rounds/${detail.id}/forfeit`, { userId });
    });
  }

  async function reconcileReturn() {
    if (!detail?.packet || !returnAmount.trim() || !canReconcile) return;
    if (!window.confirm('确认 TNG 实际退回金额无误？此操作会更新红包在途账。')) return;
    await run('reconcile', async () => {
      await post(`/api/admin/packets/${detail.packet.id}/reconcile-return`, {
        returnedCents: toCents(returnAmount),
      });
      setReturnAmount('');
    });
  }

  async function reconcileCancelled() {
    if (!detail?.packet || !returnAmount.trim() || !claimedAmount.trim() || !canReconcile) return;
    if (!window.confirm('确认已按 TNG 明细核对「已领 + 退回」金额？此操作会更新取消局红包在途账。')) return;
    await run('reconcile-cancelled', async () => {
      await post(`/api/admin/packets/${detail.packet.id}/reconcile-cancelled`, {
        claimedCents: toCents(claimedAmount),
        returnedCents: toCents(returnAmount),
      });
      setClaimedAmount('');
      setReturnAmount('');
    });
  }

  if (screen === 'catalog') {
    return (
      <div className="ops-center">
        <header className="ops-command-bar">
          <div>
            <small>游戏运营中心</small>
            <h2>游戏目录</h2>
          </div>
          <div className="ops-command-status">
            <span>一款游戏 = 一个互动群</span>
            <button type="button" onClick={() => void loadRooms().catch((cause) => setError((cause as Error).message))}>
              刷新
            </button>
          </div>
        </header>
        <ErrorNotice error={error} onClose={() => setError('')} />
        <div className="ops-catalog">
          <p className="ops-catalog-lead">
            先选择游戏进入其唯一互动群运营台。新增互动群不能在后台“建群”，必须先接入新游戏引擎后再出现在本目录。
          </p>
          <div className="ops-catalog-grid">
            {rooms.map((room) => (
              <button
                type="button"
                key={room.id}
                className="ops-catalog-card"
                onClick={() => enterGame(room.id)}
              >
                <small>{room.gameCode ?? 'SUPREME_NIUNIU'}</small>
                <strong>{room.title}</strong>
                <span>{room.game?.interactionGroupTitle ?? '至尊牛牛互动群'}</span>
                <footer>
                  <em className={room.status.toLowerCase()}>{room.status === 'ACTIVE' ? '入口开启' : '入口暂停'}</em>
                  <i>{room._count?.members ?? 0} 名成员 · {room._count?.rounds ?? 0} 局</i>
                </footer>
              </button>
            ))}
          </div>
          {!rooms.length && (
            <div className="ops-game-bootstrap catalog">
              <strong>尚未初始化至尊牛牛</strong>
              <p>
                当前目录只有「至尊牛牛」。初始化后会创建它唯一的互动群；不能再建同游戏的 1 号桌 / 2 号桌。
              </p>
              {canOperate && (
                <button type="button" disabled={!!busy} onClick={() => void initializeSupremeNiuNiu()}>
                  初始化至尊牛牛
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="ops-center">
      <header className="ops-command-bar">
        <div className="ops-command-title">
          <button type="button" className="ops-back" onClick={backToCatalog}>← 游戏目录</button>
          <div>
            <small>
              {selectedRoom?.game?.interactionGroupTitle ?? '至尊牛牛互动群'}
              {' · '}
              {selectedRoom?.gameCode ?? 'SUPREME_NIUNIU'}
            </small>
            <h2>{selectedRoom?.game?.title ?? selectedRoom?.title ?? '至尊牛牛'}</h2>
          </div>
        </div>
        <div className="ops-command-status">
          <span className={`ops-live ${socketState}`}><i />{socketState === 'online' ? '实时连接' : socketState === 'connecting' ? '连接中' : '已断开'}</span>
          <span>玩家在线 <b>{online}</b></span>
          {detail && <PhaseBadge value={detail.phase} />}
          {remaining !== null && isLiveControlRound && <strong className="ops-countdown">{remaining}s</strong>}
        </div>
      </header>

      <ErrorNotice error={error} onClose={() => setError('')} />

      <nav className="ops-module-tabs" aria-label="游戏运营模块">
        {[
          ['live', '实时运营', '小助手、牌局与 TNG'],
          ['rules', '规则与配置', '数值、流程与玩家说明'],
          ['rewards', '每日奖励', '任务、配额与发放记录'],
          ['leaderboards', '排行榜', '榜型、快照与奖金'],
          ['virtuals', '虚拟玩家', '本游戏互动群假人'],
          ['admins', '群管理员', 'TG 授权、预算与禁言'],
        ].map(([value, label, hint]) => (
          <button
            type="button"
            key={value}
            className={activeTab === value ? 'active' : ''}
            onClick={() => setActiveTab(value as typeof activeTab)}
          >
            <strong>{label}</strong>
            <span>{hint}</span>
          </button>
        ))}
      </nav>

      {activeTab === 'live' ? (
      <div className="ops-workspace">
        <aside className="ops-room-rail">
          <div className="ops-section-head">
            <div><small>本游戏互动群</small><strong>{selectedRoom?.title ?? '—'}</strong></div>
            <button type="button" onClick={() => void loadRooms(selectedRoomId)} aria-label="刷新">刷新</button>
          </div>
          {selectedRoom && canOperate && (
            <div className="ops-room-controls">
              <p className="ops-control-layer">① 游戏入口（玩家能否进群）</p>
              <button
                type="button"
                disabled={!!busy}
                onClick={() => void run('room-status', async () => {
                  await patch(`/api/admin/rooms/${selectedRoom.id}`, {
                    status: selectedRoom.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE',
                  });
                })}
              >
                {selectedRoom.status === 'ACTIVE' ? '关闭游戏入口' : '打开游戏入口'}
              </button>

              <p className="ops-control-layer">② 游戏运行</p>
              <div className={`ops-mode-status ${roomStartMode.toLowerCase()}`}>
                <i />
                <span>
                  <strong>
                    {roomStartMode === 'AUTO'
                      ? '自动连续运行'
                      : roomStartMode === 'STOPPED'
                        ? hasActiveRound
                          ? '本局结束后停局'
                          : '游戏已结束'
                        : hasActiveRound
                          ? '手动单局进行中'
                          : '等待正常开局'}
                  </strong>
                  <small>
                    {roomStartMode === 'AUTO'
                      ? '每局结束后自动进入下一局'
                      : roomStartMode === 'STOPPED'
                        ? hasActiveRound
                          ? '当前局照常完成，下一局不会启动'
                          : '需正常开局或打开自动开局'
                        : '本局结束后停在等待区'}
                  </small>
                </span>
              </div>
              <div className="ops-lifecycle-actions">
                <button
                  type="button"
                  className="primary-action"
                  disabled={!!busy || !canStartRound || roomGloballyMuted}
                  title={
                    roomGloballyMuted
                      ? '请先解除全群禁言'
                      : !canStartRound
                        ? '需打开入口且当前无进行中牌局'
                        : '只开当前一局；结束后需再次手动开局'
                  }
                  onClick={() => void run('start', async () => {
                    const next = await post<{
                      botService: {
                        autoStart: boolean;
                        assistantEnabled: boolean;
                        roundStartMode: 'MANUAL';
                      };
                    }>(`/api/admin/rooms/${selectedRoom.id}/start`, { force: false });
                    setAssistantEnabled(next.botService.assistantEnabled);
                    setBotAutoStart(next.botService.autoStart);
                  })}
                >
                  正常开局
                  <small>仅当前一局</small>
                </button>
                <button
                  type="button"
                  disabled={
                    !!busy
                    || selectedRoom.status !== 'ACTIVE'
                    || roomStartMode === 'AUTO'
                    || roomGloballyMuted
                  }
                  title={
                    roomGloballyMuted
                      ? '请先解除全群禁言'
                      : roomStartMode === 'AUTO'
                        ? '当前已在自动连续运行'
                        : '开启后每局结束会自动进入下一局'
                  }
                  onClick={() => {
                    if (!window.confirm('打开自动开局后，牌局会连续运行，直到点击“结束游戏”。确认打开？')) return;
                    void run('auto-start', async () => {
                      const next = await post<{
                        botService: {
                          autoStart: boolean;
                          assistantEnabled: boolean;
                          roundStartMode: 'AUTO';
                        };
                      }>(`/api/admin/rooms/${selectedRoom.id}/auto-start`, { enabled: true });
                      setAssistantEnabled(next.botService.assistantEnabled);
                      setBotAutoStart(next.botService.autoStart);
                    });
                  }}
                >
                  {roomStartMode === 'AUTO' ? '自动开局中' : '打开自动开局'}
                  <small>连续运行</small>
                </button>
                <button
                  type="button"
                  className="danger-action ops-end-game"
                  disabled={!!busy || roomStartMode === 'STOPPED'}
                  onClick={() => {
                    const message = hasActiveRound
                      ? '确认结束游戏？当前局会照常完成并结算，但下一局不会启动。'
                      : '确认结束游戏？系统将保持待机，直到正常开局或打开自动开局。';
                    if (!window.confirm(message)) return;
                    void run('end-game', async () => {
                      const next = await post<{
                        botService: {
                          autoStart: boolean;
                          assistantEnabled: boolean;
                          roundStartMode: 'STOPPED';
                        };
                      }>(`/api/admin/rooms/${selectedRoom.id}/end`, {
                        reason: '运营结束游戏',
                      });
                      setAssistantEnabled(next.botService.assistantEnabled);
                      setBotAutoStart(next.botService.autoStart);
                    });
                  }}
                >
                  结束游戏
                  <small>{hasActiveRound ? '本局完成后停止' : '停止后续开局'}</small>
                </button>
              </div>

              <p className="ops-control-layer">③ 互动群禁言</p>
              <button
                type="button"
                className={roomGloballyMuted ? 'primary-action ops-mute-toggle' : 'danger-action ops-mute-toggle'}
                disabled={!!busy}
                onClick={() => {
                  if (
                    !roomGloballyMuted
                    && !window.confirm('确认全群禁言？玩家的聊天、竞标、下注、投骰等全部输入都会立即关闭。')
                  ) {
                    return;
                  }
                  void run('room-chat-mute', async () => {
                    await post(`/api/admin/rooms/${selectedRoom.id}/chat-mute`, {
                      muted: !roomGloballyMuted,
                      ...(!roomGloballyMuted ? { reason: '运营全群禁言' } : {}),
                    });
                  });
                }}
              >
                {roomGloballyMuted ? '解除全群禁言' : '开启全群禁言'}
              </button>
              <p className="ops-control-note">
                {roomGloballyMuted
                  ? `所有玩家输入已关闭${selectedRoom.chatMuteReason ? ` · ${selectedRoom.chatMuteReason}` : ''}`
                  : '开启后，玩家端仅显示“互动群已禁言”'}
              </p>
              <p className="ops-control-layer">④ 发包方式（切换后下一局生效）</p>
              <div className="ops-packet-channel-switch">
                <button
                  type="button"
                  className={!internalPacketMode ? 'primary-action' : ''}
                  disabled={!!busy || !internalPacketMode}
                  onClick={() => {
                    void run('packet-channel', async () => {
                      await post(`/api/admin/rooms/${selectedRoom.id}/packet-channel`, {
                        channel: 'TNG',
                      });
                    });
                  }}
                >
                  {!internalPacketMode ? '✓ TNG 链接发包' : '切换为 TNG 链接发包'}
                </button>
                <button
                  type="button"
                  className={internalPacketMode ? 'primary-action' : ''}
                  disabled={!!busy || internalPacketMode}
                  onClick={() => {
                    if (
                      window.confirm(
                        '切换为「系统红包」后，庄家投骰完成即由至尊牛牛小助手自动发包，玩家群内直抢、金额即时入余额，无需 TNG 链接与认额录入。下一局生效，确认切换？',
                      )
                    ) {
                      void run('packet-channel', async () => {
                        await post(`/api/admin/rooms/${selectedRoom.id}/packet-channel`, {
                          channel: 'INTERNAL',
                        });
                      });
                    }
                  }}
                >
                  {internalPacketMode ? '✓ 系统红包' : '切换为系统红包'}
                </button>
              </div>
              <p className="ops-bot-hint">
                入口 {selectedRoom.status === 'ACTIVE' ? '开' : '关'}
                {' · '}
                运行 {roomStartMode === 'AUTO' ? '自动连续' : roomStartMode === 'STOPPED' ? '已结束' : '手动单局'}
                {' · '}
                群聊 {roomGloballyMuted ? '全群禁言' : '正常'}
                {' · '}
                发包 {internalPacketMode ? '系统红包' : 'TNG 链接'}
              </p>
              <details className="ops-room-editor">
                <summary>运行设置</summary>
                <label>最低开局人数<input type="number" min="2" max="100" value={roomMinPlayers} onChange={(event) => setRoomMinPlayers(event.target.value)} /></label>
                <label>
                  上庄起拍价（RM）
                  <input
                    inputMode="decimal"
                    value={bankerBidMinRm}
                    onChange={(event) => setBankerBidMinRm(event.target.value)}
                    placeholder="例如 100"
                  />
                </label>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => void run('room-settings', async () => {
                    const minPlayers = Number(roomMinPlayers);
                    if (!Number.isInteger(minPlayers) || minPlayers < 2 || minPlayers > 100) {
                      throw new Error('最低开局人数必须为 2–100 的整数');
                    }
                    const cleaned = bankerBidMinRm.trim().replace(/,/g, '');
                    if (!/^\d+(\.\d{1,2})?$/.test(cleaned) || Number(cleaned) <= 0) {
                      throw new Error('上庄起拍价必须是大于 0 的金额，最多两位小数');
                    }
                    const [integer, decimal = ''] = cleaned.split('.');
                    const bankerBidMinCents = Number(
                      BigInt(integer || '0') * 100n + BigInt((decimal + '00').slice(0, 2)),
                    );
                    await patch(`/api/admin/rooms/${selectedRoom.id}`, {
                      minPlayers,
                    });
                    await post(`/api/admin/rooms/${selectedRoom.id}/banker-bid-min`, {
                      bankerBidMinCents,
                    });
                  })}
                >
                  保存运行设置
                </button>
                <button
                  type="button"
                  className="danger-text"
                  disabled={
                    !!busy
                    || selectedRoom.status !== 'ACTIVE'
                    || hasActiveRound
                    || roomGloballyMuted
                  }
                  title={hasActiveRound ? '当前已有进行中的牌局' : '跳过最低人数，仅开当前一局'}
                  onClick={() => {
                    if (window.confirm('强制开局将跳过最低人数校验，且只运行当前一局。确认继续？')) {
                      void run('force-start', async () => {
                        await post(`/api/admin/rooms/${selectedRoom.id}/start`, { force: true });
                        setAssistantEnabled(true);
                        setBotAutoStart(false);
                      });
                    }
                  }}
                >
                  强制开一局（跳过人数）
                </button>
              </details>
            </div>
          )}
          <div className="ops-round-list">
            <div className="ops-section-head compact">
              <div>
                <small>全部牌局</small>
                <strong>
                  {roundsTotal} 局 · 第 {roundPage}/{roundsTotalPages} 页
                </strong>
              </div>
              {roundPinned && (
                <button
                  type="button"
                  className="ops-follow-live"
                  onClick={() => {
                    roundPinnedRef.current = false;
                    setRoundPinned(false);
                    roundPageRef.current = 1;
                    setRoundPage(1);
                    void loadContext(selectedRoomIdRef.current, undefined, 1);
                  }}
                >
                  跟随进行中
                </button>
              )}
            </div>
            {rounds.map((round) => (
              <button
                type="button"
                key={round.id}
                className={selectedRoundId === round.id ? 'active' : ''}
                onClick={() => void chooseRound(round.id)}
              >
                <span className="ops-round-list-main">
                  <strong>第 {round.seqNo} 局</strong>
                  <small>
                    {round.banker?.nickname
                      ? `庄家 ${round.banker.nickname}`
                      : '无庄家'}
                    {' · '}
                    认额 {round._count?.claims ?? 0}
                    {typeof round._count?.bets === 'number' ? ` / 下注 ${round._count.bets}` : ''}
                  </small>
                </span>
                <span className="ops-round-statuses">
                  {round.phase === 'FINISHED' && canViewScoreboard && (
                    <span
                      className={`ops-scoreboard-mini-status ${
                        String(round.scoreboard?.presentationSyncStatus ?? 'missing').toLowerCase()
                      }`}
                    >
                      {round.scoreboard
                        ? (
                          <>
                            成绩单 {round.scoreboard.presentationRevision > 0
                              ? `v${round.scoreboard.presentationRevision}`
                              : '原始 v0'}
                            {' · '}
                            {scoreboardSyncCopy(round.scoreboard.presentationSyncStatus)}
                          </>
                        )
                        : '成绩单待生成'}
                    </span>
                  )}
                  <PhaseBadge value={round.phase} />
                </span>
              </button>
            ))}
            {!rounds.length && (
              <p className="ops-muted ops-round-empty">当前页暂无牌局</p>
            )}
            <div className="ops-round-pager">
              <button
                type="button"
                disabled={roundPage <= 1}
                onClick={() => {
                  const next = Math.max(1, roundPage - 1);
                  roundPageRef.current = next;
                  setRoundPage(next);
                  void loadContext(selectedRoomIdRef.current, undefined, next);
                }}
              >
                上一页
              </button>
              <span>
                {roundPage} / {roundsTotalPages}
              </span>
              <button
                type="button"
                disabled={roundPage >= roundsTotalPages}
                onClick={() => {
                  const next = Math.min(roundsTotalPages, roundPage + 1);
                  roundPageRef.current = next;
                  setRoundPage(next);
                  void loadContext(selectedRoomIdRef.current, undefined, next);
                }}
              >
                下一页
              </button>
            </div>
          </div>
        </aside>

        <main className="ops-live-room">
          <div className="ops-live-head">
            <div>
              <small>玩家端同步画面</small>
              <strong>互动群实时消息</strong>
            </div>
            <div className="ops-assist-state">
              <span className={lease.mode.toLowerCase()}>
                {lease.mode === 'UNAVAILABLE'
                  ? '接管服务不可用'
                  : lease.lease
                    ? `接管中：${lease.lease.adminName}`
                    : '系统托管'}
              </span>
              {canOperate && !lease.lease && lease.mode !== 'UNAVAILABLE' && (
                <button type="button" disabled={!!busy} onClick={() => void takeOverAssistant()}>
                  接管小助手
                </button>
              )}
              {canOperate && lease.heldByMe && (
                <button type="button" disabled={!!busy} onClick={() => void releaseAssistant()}>
                  交还系统
                </button>
              )}
              {admin.role === 'SUPER' && lease.lease && !lease.heldByMe && (
                <button type="button" className="danger-text" disabled={!!busy} onClick={() => void forceTakeOverAssistant()}>
                  强制接管
                </button>
              )}
            </div>
          </div>

          <div className="ops-feed" ref={streamRef}>
            {chat.length ? chat.map((message) => (
              <ChatBubble
                key={message.id}
                message={message}
                now={now}
                assistantName={`${selectedRoom?.title ?? '游戏'}小助手`}
              />
            )) : (
              <div className="ops-feed-empty">
                <strong>
                  {socketState !== 'online'
                    ? '实时通道未连通'
                    : online === 0
                      ? '互动群暂无在线玩家'
                      : '此刻还没有新消息'}
                </strong>
                <span>
                  这里镜像的是 Mini App 互动群消息，不是 Telegram 真群。
                  玩家进入网页互动群发言或阶段播报出现后会即时显示；
                  历史暂存在当前后端进程内存，服务重启后会清空。
                </span>
              </div>
            )}
          </div>

          <section className={`ops-assistant-console ${lease.heldByMe ? 'enabled' : ''}`}>
            <div className="ops-console-title">
              <div>
                <small>小助手人工协同</small>
                <strong>{lease.heldByMe ? '你正在使用小助手身份' : '接管后才可人工发言'}</strong>
              </div>
              <span>自动阶段和资金播报始终开启</span>
            </div>
            <textarea
              value={assistantText}
              onChange={(event) => setAssistantText(event.target.value)}
              disabled={!lease.heldByMe || !!busy}
              maxLength={1_000}
              placeholder="输入补充通知；玩家端会显示「运营接管」标记"
            />
            <div className="ops-console-actions">
              <button type="button" disabled={!lease.heldByMe || !replayAllowed || !!busy} onClick={() => void replayPhase()}>
                重播当前阶段
              </button>
              {Object.entries(bannerLabels).map(([key, label]) => (
                <button type="button" key={key} disabled={!lease.heldByMe || !!busy} onClick={() => void sendBanner(key)}>
                  {label}
                </button>
              ))}
              <button
                type="button"
                className="primary-action"
                disabled={!lease.heldByMe || !assistantText.trim() || !!busy}
                onClick={() => void sendAssistantText()}
              >
                {busy === 'assistant-message' ? '发送中…' : '发送为小助手'}
              </button>
            </div>
            <details className="ops-pin-editor">
              <summary>编辑本互动群置顶</summary>
              <label>置顶标题<input value={pinTitle} onChange={(event) => setPinTitle(event.target.value)} disabled={!lease.heldByMe} /></label>
              <label>置顶内容<textarea value={pinBody} onChange={(event) => setPinBody(event.target.value)} disabled={!lease.heldByMe} /></label>
              <div>
                <button type="button" disabled={!lease.heldByMe || !pinTitle.trim() || !pinBody.trim() || !!busy} onClick={() => void publishPin()}>
                  发布置顶
                </button>
                <button type="button" className="danger-text" disabled={!lease.heldByMe || !!busy} onClick={() => void removePin()}>
                  撤下置顶
                </button>
              </div>
            </details>
          </section>
        </main>

        <aside className="ops-round-panel">
          {!detail ? (
            <div className="ops-panel-empty">点选左侧牌局后，在此查看数据</div>
          ) : (
            <>
              <div className="ops-round-head">
                <div>
                  <small>{isTerminalRound || detail.phase === 'WAITING' ? '牌局数据预览' : '进行中牌局'}</small>
                  <h3>第 {detail.seqNo} 局</h3>
                </div>
                <div className="ops-round-head-meta">
                  <PhaseBadge value={detail.phase} />
                  {(isTerminalRound || roundPinned) && <span className="ops-readonly-tag">只看数据</span>}
                </div>
              </div>
              <dl className="ops-round-metrics">
                <div><dt>庄家</dt><dd>{detail.bankerId ? bankerName : '—'}</dd></div>
                <div><dt>庄池</dt><dd>RM {rm(detail.potCents)}</dd></div>
                <div><dt>下注</dt><dd>{(detail.bets?.length ?? frozenBets.length)} 人</dd></div>
                <div><dt>认额</dt><dd>{detail.claims?.length ?? 0}/{(detail.packet?.participantCount ?? expectedClaims) || '—'}</dd></div>
              </dl>

              {detail.phase === 'CANCELLED' && (
                <div className="ops-cancel-note" role="status">
                  本局已取消
                  {detail.cancelReason ? `：${detail.cancelReason}` : '，无庄家与领取记录。'}
                </div>
              )}

              {detail.phase === 'FINISHED' && canViewScoreboard && (
                <section className="ops-scoreboard-card">
                  <header>
                    <div>
                      <small>不可变结算 · 可修订展示</small>
                      <strong>本局成绩单</strong>
                    </div>
                    {scoreboard ? (
                      <span
                        className={`ops-scoreboard-sync ${scoreboard.presentationSyncStatus.toLowerCase()}`}
                      >
                        {scoreboard.presentationRevision > 0
                          ? `已修改 v${scoreboard.presentationRevision} · `
                          : ''}
                        {scoreboardSyncCopy(scoreboard.presentationSyncStatus)}
                      </span>
                    ) : null}
                  </header>
                  {scoreboardLoading ? (
                    <p className="ops-scoreboard-empty">正在读取成绩单…</p>
                  ) : scoreboard ? (
                    <>
                      <div className="ops-scoreboard-finance-note">
                        抢包、下注、净输赢和余额均来自结算快照，后台展示编辑无法改动。
                      </div>
                      <div className="ops-scoreboard-table-wrap">
                        <table className="ops-scoreboard-table">
                          <thead>
                            <tr>
                              <th>玩家</th>
                              <th>抢</th>
                              <th>下注</th>
                              <th>牌型 / 结果</th>
                              <th>应赔 / 实赔</th>
                              <th>免赔</th>
                              <th>抽水</th>
                              <th>净输赢</th>
                              <th>余额前 → 后</th>
                            </tr>
                          </thead>
                          <tbody>
                            {scoreboard.playerLines.map((line) => (
                              <tr key={line.userId}>
                                <td>
                                  {scoreboardName(line)}
                                  {scoreboard.presentation.playerAliases?.[line.userId] && (
                                    <small>
                                      展示 {scoreboardName(
                                        line,
                                        scoreboard.presentation.playerAliases[line.userId],
                                      )}
                                    </small>
                                  )}
                                </td>
                                <td>RM {rm(line.claimCents ?? 0)}</td>
                                <td>RM {rm(line.betCents ?? 0)}</td>
                                <td>{scoreboardResultSummary(line)}</td>
                                <td>
                                  {scoreboardMoney(line.payableCents)}
                                  {' / '}
                                  {scoreboardMoney(line.paidCents)}
                                </td>
                                <td>{scoreboardMoney(line.shortfallCents)}</td>
                                <td>{scoreboardMoney(line.rakeCents)}</td>
                                <td className={BigInt(String(line.netCents ?? 0)) >= 0n ? 'positive' : 'negative'}>
                                  {BigInt(String(line.netCents ?? 0)) > 0n ? '+' : ''}RM {rm(line.netCents ?? 0)}
                                </td>
                                <td>RM {rm(line.balanceBeforeCents ?? 0)} → {rm(line.balanceAfterCents ?? 0)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="ops-scoreboard-banker">
                        <span>
                          庄家 {scoreboardName(scoreboard.bankerSummary)}
                          {scoreboard.presentation.bankerAlias && (
                            <small>
                              展示 {scoreboardName(
                                scoreboard.bankerSummary,
                                scoreboard.presentation.bankerAlias,
                              )}
                            </small>
                          )}
                        </span>
                        <strong className={BigInt(String(scoreboard.bankerSummary.netCents ?? 0)) >= 0n ? 'positive' : 'negative'}>
                          净输赢 {BigInt(String(scoreboard.bankerSummary.netCents ?? 0)) > 0n ? '+' : ''}RM {rm(scoreboard.bankerSummary.netCents ?? 0)}
                        </strong>
                        <small>
                          {scoreboardHandLabels[String(scoreboard.bankerSummary.handType ?? '')]
                            ?? scoreboard.bankerSummary.handType
                            ?? '牌型 —'}
                          {scoreboard.bankerSummary.points != null
                            ? ` · ${scoreboard.bankerSummary.points} 点`
                            : ''}
                          {' · '}
                          抢 RM {rm(scoreboard.bankerSummary.claimCents ?? 0)} ·
                          余额 RM {rm(scoreboard.bankerSummary.balanceBeforeCents ?? 0)}
                          {' → '}
                          {rm(scoreboard.bankerSummary.balanceAfterCents ?? 0)}
                          {' · '}
                          毛输赢 {scoreboardMoney(scoreboard.bankerSummary.grossCents)}
                          {' · '}
                          上庄费 {scoreboardMoney(scoreboard.bankerSummary.fees?.seatFeeCents)}
                          {' · '}
                          服务费 {scoreboardMoney(scoreboard.bankerSummary.fees?.serviceFeeCents)}
                          {' · '}
                          红包费 {scoreboardMoney(scoreboard.bankerSummary.fees?.packetFeeCents)}
                        </small>
                      </div>
                      {scoreboard.presentationSyncError && (
                        <p className="ops-scoreboard-inline-error">
                          {scoreboard.presentationSyncError}
                        </p>
                      )}
                      <div className="ops-scoreboard-card-actions">
                        <button type="button" onClick={() => setScoreboardOpen(true)}>
                          {canOperate ? '查看与编辑成绩单' : '查看成绩单与历史'}
                        </button>
                        {canOperate && ['FAILED', 'PENDING'].includes(scoreboard.presentationSyncStatus) && (
                          <button
                            type="button"
                            disabled={!!busy}
                            onClick={() => void retryScoreboardSync()}
                          >
                            {busy === 'scoreboard-sync' ? '同步中…' : '重试同步'}
                          </button>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="ops-scoreboard-empty">
                      <p>{scoreboardError || '本局尚未生成结构化成绩单。'}</p>
                      {scoreboardError && (
                        <button
                          type="button"
                          onClick={() => void loadScoreboard(detail.id, true)}
                        >
                          重新加载
                        </button>
                      )}
                    </div>
                  )}
                </section>
              )}

              {canMutateRound && (
                <div className="ops-phase-actions">
                  {detail.phase === 'BANKER_BID' && <button type="button" disabled={!!busy} onClick={() => void roundAction('close_bidding')}>提前结束竞标</button>}
                  {detail.phase === 'BETTING' && <button type="button" disabled={!!busy} onClick={() => void roundAction('close_betting')}>提前封盘</button>}
                  {claimReady && <button type="button" className="success-action" disabled={!!busy} onClick={() => void roundAction('settle')}>复核并结算</button>}
                </div>
              )}

              {detail.phase === 'SENDING_PACKET' && canMutateRound && internalPacketMode && (
                <section className="ops-action-block highlight">
                  <header>
                    <small>系统红包模式</small>
                    <strong>至尊牛牛小助手自动发包</strong>
                  </header>
                  <div className="ops-packet-brief">
                    <div><span>红包总额</span><strong>RM {rm(detail.packet?.totalCents ?? 0)}</strong></div>
                    <div><span>领取人数</span><strong>{detail.packet?.participantCount ?? '—'} 个</strong></div>
                  </div>
                  <p className="ops-packet-guide">
                    当前为「系统红包」发包方式：庄家投骰完成后，至尊牛牛小助手会自动发出红包，玩家在互动群内直接抢，金额即时入余额并作为牌型依据。全员抢完或超时补录后自动结算，无需登记 TNG 链接与认额。
                  </p>
                </section>
              )}

              {detail.phase === 'SENDING_PACKET' && canMutateRound && !internalPacketMode && (
                <section className="ops-action-block highlight">
                  <header>
                    <small>步骤 1 · 待外部发包</small>
                    <strong>创建并发布 TNG Money Packet</strong>
                  </header>
                  <div className="ops-packet-brief">
                    <div><span>红包总额</span><strong>RM {rm(detail.packet?.totalCents ?? 0)}</strong></div>
                    <div><span>领取人数</span><strong>{detail.packet?.participantCount ?? '—'} 个</strong></div>
                  </div>
                  <div className="ops-packet-flow" aria-label="自动化流程">
                    <span className="done">金额与人数已生成</span>
                    <span className="active">粘贴 TNG 链接</span>
                    <span>自动推送并开始倒计时</span>
                  </div>
                  <p className="ops-packet-guide">
                    请按上方金额与人数在 TNG eWallet 创建 Money Packet，然后粘贴分享链接。系统会自动校验、推送到互动群并进入抢包阶段。
                  </p>
                  <label className={packetUrlTouched && claimUrlError ? 'invalid' : ''}>
                    <span className="ops-field-label">TNG Money Packet 分享链接 <em>HTTPS</em></span>
                    <input
                      value={claimUrl}
                      onChange={(event) => setClaimUrl(event.target.value)}
                      onBlur={() => setPacketUrlTouched(true)}
                      onPaste={(event) => {
                        const pasted = event.clipboardData.getData('text');
                        const extracted = extractHttpsUrl(pasted);
                        if (extracted.startsWith('https://')) {
                          event.preventDefault();
                          setClaimUrl(extracted);
                          setPacketUrlTouched(true);
                        }
                      }}
                      placeholder="https://links.tngdigital.com.my/moneypacket/…"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      aria-invalid={packetUrlTouched && !!claimUrlError}
                    />
                  </label>
                  {packetUrlTouched && claimUrlError && (
                    <p className="ops-field-error" role="alert">{claimUrlError}</p>
                  )}
                  <label>
                    <span className="ops-field-label">发包账号 <em>系统已自动选择可用账号</em></span>
                    <select value={packerAccount} onChange={(event) => setPackerAccount(event.target.value)}>
                      {!accounts.length && <option value="">暂无可用账号</option>}
                      {accounts.map((account) => <option key={account.id} value={account.id}>{account.label} · {account.maskedId ?? account.accountName}</option>)}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="primary-action"
                    disabled={!!busy || !!claimUrlError || !packerAccount}
                    onClick={() => void submitPacket()}
                  >
                    {busy === 'packet' ? '正在校验并推送…' : '校验链接并推送到互动群'}
                  </button>
                  <p className="ops-packet-auto-note">成功后系统自动：切换抢包阶段 → 群内发卡 → 启动领取倒计时</p>
                  <div className="ops-packet-or" aria-hidden="true">或</div>
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          '本局使用系统红包？红包将由至尊牛牛小助手发出，无需 TNG 链接；玩家在群内直接抢，金额随机拆分并即时入余额，抢完自动结算。仅影响本局。',
                        )
                      ) {
                        void run('packet-internal', async () => {
                          await post(`/api/admin/rounds/${detail.id}/packet/internal`, {});
                        });
                      }
                    }}
                  >
                    {busy === 'packet-internal' ? '至尊牛牛小助手正在发包…' : '本局使用系统红包（免 TNG 链接）'}
                  </button>
                </section>
              )}

              <section className="ops-action-block">
                <header>
                  <small>{isTerminalRound || detail.phase === 'WAITING' ? '本局明细' : '步骤 2'}</small>
                  <strong>
                    {isTerminalRound || detail.phase === 'WAITING'
                      ? '庄家与红包领取'
                      : internalPacketMode
                        ? '参与者与抢包明细'
                        : '参与者与 TNG 认额'}
                  </strong>
                </header>
                {internalPacketMode && claimReview && (
                  <p className="ops-muted">
                    内部红包由系统实时记账，抢包金额自动作为认额，无需人工录入；全员齐备后自动结算。
                  </p>
                )}
                {detail.bankerId && (
                  <ClaimRow
                    role="庄"
                    userId={detail.bankerId}
                    name={bankerName}
                    subtitle={
                      isTerminalRound
                        ? (detail.claims?.some((entry: Row) => entry.userId === detail.bankerId)
                          ? '庄家 · 已领取红包'
                          : '庄家 · 未领取')
                        : '庄家 · 必须领取'
                    }
                    claim={detail.claims?.find((entry: Row) => entry.userId === detail.bankerId)}
                    draft={claimDrafts[detail.bankerId]}
                    editable={claimReview && canMutateRound && !internalPacketMode}
                    busy={!!busy}
                    onDraft={setDraft}
                    onSubmit={submitClaim}
                    onCorrect={correctClaim}
                  />
                )}
                {(isTerminalRound
                  ? (detail.bets ?? []).filter((bet: Row) => bet.status !== 'CANCELLED')
                  : frozenBets
                ).map((bet: Row) => (
                  <ClaimRow
                    key={bet.id}
                    role="闲"
                    userId={bet.userId}
                    name={bet.user?.nickname ?? bet.userId.slice(-6)}
                    subtitle={`${bet.isAllIn ? '梭哈' : '下注'} RM ${rm(bet.amountCents)}${
                      isTerminalRound
                        ? (detail.claims?.some((entry: Row) => entry.userId === bet.userId)
                          ? ' · 已领取'
                          : ' · 未领取')
                        : ''
                    }`}
                    claim={detail.claims?.find((entry: Row) => entry.userId === bet.userId)}
                    draft={claimDrafts[bet.userId]}
                    editable={claimReview && canMutateRound && !internalPacketMode}
                    busy={!!busy}
                    onDraft={setDraft}
                    onSubmit={submitClaim}
                    onCorrect={correctClaim}
                    onForfeit={canMutateRound ? () => void forfeit(bet.userId) : undefined}
                  />
                ))}
                {!detail.bankerId && !(detail.bets?.length) && (
                  <p className="ops-muted">
                    {detail.phase === 'CANCELLED'
                      ? '本局无参与者（已取消）。'
                      : detail.phase === 'WAITING'
                        ? '本局尚未开局。'
                        : '本局尚无参与者。'}
                  </p>
                )}
              </section>

              {canReconcile && detail.phase === 'FINISHED' && detail.packet
                && BigInt(String(detail.packet.reconciledCents ?? 0)) + BigInt(String(detail.packet.returnedCents ?? 0))
                  < BigInt(String(detail.packet.totalCents ?? 0)) && (
                <section className="ops-action-block">
                  <header><small>财务</small><strong>登记 TNG 实际退回</strong></header>
                  <input value={returnAmount} onChange={(event) => setReturnAmount(event.target.value)} placeholder="退回金额 RM" />
                  <button type="button" disabled={!!busy || !returnAmount.trim()} onClick={() => void reconcileReturn()}>确认退回金额</button>
                </section>
              )}

              {canReconcile && detail.phase === 'CANCELLED' && detail.packet && (
                <section className="ops-action-block">
                  <header><small>财务</small><strong>取消局红包核销</strong></header>
                  <p className="ops-muted">按 TNG 明细分别登记「已领取」与「实际退回」金额。</p>
                  <input value={claimedAmount} onChange={(event) => setClaimedAmount(event.target.value)} placeholder="已领取金额 RM" />
                  <input value={returnAmount} onChange={(event) => setReturnAmount(event.target.value)} placeholder="退回金额 RM" />
                  <button
                    type="button"
                    disabled={!!busy || !claimedAmount.trim() || !returnAmount.trim()}
                    onClick={() => void reconcileCancelled()}
                  >
                    确认取消局核销
                  </button>
                </section>
              )}

              {canMutateRound && detail.phase !== 'SETTLING' && (
                <section className="ops-action-block danger-zone">
                  <header><small>异常处理</small><strong>取消本局并退款</strong></header>
                  <input value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} placeholder="必须填写具体原因（至少 2 字）" />
                  <button type="button" disabled={!!busy || cancelReason.trim().length < 2} onClick={() => void roundAction('cancel', { reason: cancelReason.trim() })}>
                    取消本局并退款
                  </button>
                </section>
              )}
            </>
          )}
        </aside>
      </div>
      ) : selectedRoom ? (
        <div className="ops-module-content">
          {activeTab === 'rules' && (
            <GameRulesAndConfig gameCode={selectedRoom.gameCode} />
          )}
          {activeTab === 'rewards' && (
            <GameRewardsAdmin
              gameCode={selectedRoom.gameCode}
              canManageMoney={admin.role === 'SUPER' || admin.role === 'FINANCE'}
            />
          )}
          {activeTab === 'leaderboards' && (
            <GameLeaderboardsAdmin
              gameCode={selectedRoom.gameCode}
              canManageMoney={admin.role === 'SUPER' || admin.role === 'FINANCE'}
            />
          )}
          {activeTab === 'virtuals' && (
            <VirtualPlayers
              roomId={selectedRoom.id}
              embedded
              canManageFunds={admin.role === 'SUPER' || admin.role === 'FINANCE'}
              canOperate={admin.role === 'SUPER' || admin.role === 'OPERATOR'}
            />
          )}
          {activeTab === 'admins' && (
            <GameAdministratorsPanel
              gameCode={selectedRoom.gameCode}
              role={admin.role}
            />
          )}
        </div>
      ) : null}
      {scoreboardOpen && scoreboard && scoreboardDraft && (
        <ScoreboardEditorModal
          scoreboard={scoreboard}
          draft={scoreboardDraft}
          reason={scoreboardReason}
          previewChunks={scoreboardPreviewChunks}
          previewLoading={scoreboardPreviewLoading}
          previewError={scoreboardPreviewError}
          canOperate={canOperate}
          busy={busy}
          error={scoreboardError}
          onDraft={setScoreboardDraft}
          onReason={setScoreboardReason}
          onClose={() => {
            if (!busy) setScoreboardOpen(false);
          }}
          onSave={() => void saveScoreboard()}
          onRetry={() => void retryScoreboardSync()}
          onRestore={(revision) => void restoreScoreboardRevision(revision)}
        />
      )}
    </div>
  );
}

function ScoreboardEditorModal({
  scoreboard,
  draft,
  reason,
  previewChunks,
  previewLoading,
  previewError,
  canOperate,
  busy,
  error,
  onDraft,
  onReason,
  onClose,
  onSave,
  onRetry,
  onRestore,
}: {
  scoreboard: ScoreboardData;
  draft: ScoreboardDraft;
  reason: string;
  previewChunks: string[];
  previewLoading: boolean;
  previewError: string;
  canOperate: boolean;
  busy: string;
  error: string;
  onDraft: (draft: ScoreboardDraft) => void;
  onReason: (reason: string) => void;
  onClose: () => void;
  onSave: () => void;
  onRetry: () => void;
  onRestore: (revision: number) => void;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  onCloseRef.current = onClose;
  busyRef.current = busy;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), details > summary, [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleDialogKeys);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleDialogKeys);
      previousFocus?.focus();
    };
  }, []);

  function setPlayerField(
    field: 'playerAliases' | 'playerNotes',
    userId: string,
    value: string,
  ) {
    onDraft({
      ...draft,
      [field]: {
        ...draft[field],
        [userId]: value,
      },
    });
  }

  return (
    <div className="ops-scoreboard-overlay" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="ops-scoreboard-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="scoreboard-editor-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="ops-scoreboard-modal-head">
          <div>
            <small>第 {scoreboard.seqNo} 局 · 展示修订 v{scoreboard.presentationRevision}</small>
            <h2 id="scoreboard-editor-title">
              {canOperate ? '成绩单编辑与小助手同步' : '成绩单与修订历史'}
            </h2>
            <p>仅标题、展示名、备注和页脚可修改；结算与钱包数据永久只读。</p>
          </div>
          <div className="ops-scoreboard-modal-state">
            <span className={`ops-scoreboard-sync ${scoreboard.presentationSyncStatus.toLowerCase()}`}>
              {scoreboardSyncCopy(scoreboard.presentationSyncStatus)}
            </span>
            <button
              ref={closeButtonRef}
              type="button"
              aria-label="关闭成绩单编辑器"
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </header>

        {error && <div className="ops-scoreboard-modal-error" role="alert">{error}</div>}
        {scoreboard.presentationSyncStatus === 'MESSAGE_EXPIRED' && (
          <div className="ops-scoreboard-expired-note">
            原成绩单已超过 7 天聊天保留期。展示版本会继续保存在后台，但不会把旧成绩单重新插入当前互动群。
          </div>
        )}

        <div className="ops-scoreboard-modal-body">
          <div className="ops-scoreboard-editor">
            <section>
              <header>
                <span>01</span>
                <div><strong>标题与玩家展示</strong><small>只影响小助手成绩单文字</small></div>
              </header>
              <label>
                成绩单标题
                <input
                  value={draft.title}
                  maxLength={120}
                  disabled={!canOperate || !!busy}
                  onChange={(event) => onDraft({ ...draft, title: event.target.value })}
                  placeholder={`至尊牛牛 · 第 ${scoreboard.seqNo} 局成绩单`}
                />
              </label>
              <div className="ops-scoreboard-player-edit-list">
                {scoreboard.playerLines.map((line) => (
                  <article key={line.userId}>
                    <div>
                      <strong>{scoreboardName(line)}</strong>
                      <small>
                        抢 RM {rm(line.claimCents ?? 0)} ·
                        {line.isAllIn ? '梭哈' : '下注'} RM {rm(line.betCents ?? 0)}
                      </small>
                    </div>
                    <label>
                      展示名
                      <input
                        value={draft.playerAliases[line.userId] ?? ''}
                        maxLength={80}
                        disabled={!canOperate || !!busy}
                        onChange={(event) =>
                          setPlayerField('playerAliases', line.userId, event.target.value)
                        }
                        placeholder="留空沿用玩家昵称"
                      />
                    </label>
                    <label>
                      行备注
                      <input
                        value={draft.playerNotes[line.userId] ?? ''}
                        maxLength={160}
                        disabled={!canOperate || !!busy}
                        onChange={(event) =>
                          setPlayerField('playerNotes', line.userId, event.target.value)
                        }
                        placeholder="可选，仅作展示说明"
                      />
                    </label>
                  </article>
                ))}
              </div>
            </section>

            <section>
              <header>
                <span>02</span>
                <div><strong>庄家与页脚</strong><small>补充运营说明，不改变庄家输赢</small></div>
              </header>
              <div className="ops-scoreboard-two-fields">
                <label>
                  庄家展示名
                  <input
                    value={draft.bankerAlias}
                    maxLength={80}
                    disabled={!canOperate || !!busy}
                    onChange={(event) => onDraft({ ...draft, bankerAlias: event.target.value })}
                    placeholder={scoreboardName(scoreboard.bankerSummary)}
                  />
                </label>
                <label>
                  庄家备注
                  <input
                    value={draft.bankerNote}
                    maxLength={160}
                    disabled={!canOperate || !!busy}
                    onChange={(event) => onDraft({ ...draft, bankerNote: event.target.value })}
                    placeholder="可选"
                  />
                </label>
              </div>
              <label>
                页脚说明
                <textarea
                  value={draft.footer}
                  maxLength={500}
                  disabled={!canOperate || !!busy}
                  onChange={(event) => onDraft({ ...draft, footer: event.target.value })}
                  placeholder="例如：本次仅更正展示名称，不影响结算与流水。"
                />
              </label>
            </section>

            {canOperate && (
              <section className="ops-scoreboard-save-section">
                <header>
                  <span>03</span>
                  <div><strong>保存依据</strong><small>原因会进入审计日志和修订历史</small></div>
                </header>
                <label>
                  修改原因 <em>{reason.trim().length}/500</em>
                  <textarea
                    value={reason}
                    maxLength={500}
                    disabled={!!busy}
                    onChange={(event) => onReason(event.target.value)}
                    placeholder="至少 4 个字符，例如：应玩家本人要求更正展示昵称"
                  />
                </label>
                <div className="ops-scoreboard-save-actions">
                  {['FAILED', 'PENDING'].includes(scoreboard.presentationSyncStatus) && (
                    <button type="button" disabled={!!busy} onClick={onRetry}>
                      {busy === 'scoreboard-sync' ? '正在重试…' : '重试当前版本同步'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="primary-action"
                    disabled={!!busy || reason.trim().length < 4}
                    onClick={onSave}
                  >
                    {busy === 'scoreboard-save' ? '保存并同步中…' : '保存并同步小助手'}
                  </button>
                </div>
              </section>
            )}
          </div>

          <aside className="ops-scoreboard-preview-column">
            <section className="ops-scoreboard-preview">
              <header>
                <div><strong>互动群实时预览</strong><small>金融数字始终来自不可变结算快照</small></div>
                <span>{previewLoading ? '格式化中…' : `${previewChunks.length} 条消息`}</span>
              </header>
              {previewError && (
                <p className="ops-scoreboard-preview-error">{previewError}</p>
              )}
              {previewChunks.map((chunk, index) => (
                <div className="ops-scoreboard-preview-chunk" key={`preview-${index}`}>
                  <small>消息 {index + 1}/{previewChunks.length}</small>
                  <pre>{chunk}</pre>
                </div>
              ))}
              {!previewChunks.length && !previewLoading && !previewError && (
                <p className="ops-scoreboard-preview-empty">暂无可预览内容</p>
              )}
            </section>

            <section className="ops-scoreboard-revisions">
              <header>
                <div><strong>展示修订历史</strong><small>恢复旧版会创建新的修订版本</small></div>
                <span>{scoreboard.revisions.length} 个版本</span>
              </header>
              {scoreboard.revisions.length ? (
                <ol>
                  {scoreboard.revisions.map((revision) => (
                    <li key={revision.id}>
                      <span className="ops-scoreboard-revision-dot" />
                      <div>
                        <strong>v{revision.revision}</strong>
                        <p>{revision.reason}</p>
                        <small>
                          {new Date(revision.createdAt).toLocaleString('zh-MY')}
                          {' · '}
                          管理员 {revision.adminId.slice(-8)}
                        </small>
                        <details className="ops-scoreboard-revision-preview">
                          <summary>查看 v{revision.revision} 消息预览</summary>
                          <pre>{revision.renderedChunks.join('\n\n')}</pre>
                        </details>
                      </div>
                      {canOperate && revision.revision !== scoreboard.presentationRevision && (
                        <button
                          type="button"
                          disabled={!!busy || reason.trim().length < 4}
                          onClick={() => onRestore(revision.revision)}
                          title={reason.trim().length < 4 ? '请先填写本次恢复原因' : ''}
                        >
                          {busy === `scoreboard-restore-${revision.revision}` ? '恢复中…' : '恢复'}
                        </button>
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="ops-scoreboard-empty">
                  当前仍是系统原始展示，尚无人工修订。
                </p>
              )}
            </section>
          </aside>
        </div>
      </section>
    </div>
  );
}

function ClaimRow({
  role,
  userId,
  name,
  subtitle,
  claim,
  draft,
  editable,
  busy,
  onDraft,
  onSubmit,
  onCorrect,
  onForfeit,
}: {
  role: '庄' | '闲';
  userId: string;
  name: string;
  subtitle: string;
  claim?: Row;
  draft?: { tngName: string; amount: string };
  editable: boolean;
  busy: boolean;
  onDraft: (userId: string, values: Partial<{ tngName: string; amount: string }>) => void;
  onSubmit: (userId: string) => Promise<void>;
  onCorrect: (claim: Row) => Promise<void>;
  onForfeit?: () => void;
}) {
  return (
    <div className="ops-claim-row">
      <span className={`ops-role ${role === '庄' ? 'banker' : ''}`}>{role}</span>
      <div className="ops-claim-user"><strong>{name}</strong><small>{subtitle}</small></div>
      {claim && editable ? (
        <div className="ops-claim-inputs">
          <input
            aria-label={`${name} TNG 姓名`}
            value={draft?.tngName ?? claim.tngName ?? ''}
            onChange={(event) => onDraft(userId, { tngName: event.target.value })}
            placeholder="TNG 姓名"
          />
          <input
            aria-label={`${name} 领取金额`}
            inputMode="decimal"
            value={draft?.amount ?? rm(claim.amountCents)}
            onChange={(event) => onDraft(userId, { amount: event.target.value })}
            placeholder="RM"
          />
          <button type="button" disabled={busy} onClick={() => void onCorrect(claim)}>更正</button>
        </div>
      ) : claim ? (
        <div className="ops-claim-done">
          <span>领取 RM {rm(claim.amountCents)}</span>
          {claim.user?.nickname || claim.tngName ? (
            <small>{claim.tngName ? `TNG ${claim.tngName}` : ''}</small>
          ) : null}
        </div>
      ) : editable ? (
        <div className="ops-claim-inputs">
          <input aria-label={`${name} TNG 姓名`} value={draft?.tngName ?? ''} onChange={(event) => onDraft(userId, { tngName: event.target.value })} placeholder="TNG 姓名" />
          <input aria-label={`${name} 领取金额`} value={draft?.amount ?? ''} onChange={(event) => onDraft(userId, { amount: event.target.value })} placeholder="RM" />
          <button type="button" className="primary-action" disabled={busy} onClick={() => void onSubmit(userId)}>录入</button>
          {onForfeit && <button type="button" className="danger-text" disabled={busy} onClick={onForfeit}>退注离席</button>}
        </div>
      ) : (
        <span className="ops-missing">未领取</span>
      )}
    </div>
  );
}
