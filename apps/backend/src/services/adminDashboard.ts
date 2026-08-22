import {
  MembershipStatus,
  PacketChannel,
  ProfitPoolBatchStatus,
  RoomStartMode,
  RoomStatus,
  RoundPhase,
  UserKind,
} from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { SUPREME_NIUNIU_GAME_CODE } from './gameCatalog.js';
import { getGameSettings } from './gameSettings.js';
import { malaysiaDayWindow, previousDay } from './profitPool.js';
import { malaysiaDay } from './rebates.js';

const ACTIVE_PHASES: RoundPhase[] = [
  RoundPhase.BANKER_BID,
  RoundPhase.BETTING,
  RoundPhase.SENDING_PACKET,
  RoundPhase.CLAIMING,
  RoundPhase.CLAIM_EXPIRED,
  RoundPhase.SETTLING,
];

const ONLINE_HEARTBEAT_MS = 90_000;
export const SENDING_PACKET_STUCK_SECONDS = 120;
const CANCELLED_ALERT_MIN = 3;

const PHASE_LABELS: Record<RoundPhase, string> = {
  WAITING: '等待开局',
  BANKER_BID: '竞标中',
  BETTING: '下注中',
  SENDING_PACKET: '待发包',
  CLAIMING: '抢包中',
  CLAIM_EXPIRED: '认额复核',
  SETTLING: '结算中',
  FINISHED: '已结算',
  CANCELLED: '已取消',
};

const START_MODE_LABELS: Record<RoomStartMode, string> = {
  MANUAL: '手动单局',
  AUTO: '自动连续',
  STOPPED: '结束待机',
};

const ROOM_STATUS_LABELS: Record<RoomStatus, string> = {
  ACTIVE: '入口开放',
  PAUSED: '入口关闭',
};

const PROFIT_POOL_STATUS_LABELS: Record<ProfitPoolBatchStatus, string> = {
  PENDING: '已生成 · 待分配',
  DISTRIBUTED: '已发放',
  NO_DISTRIBUTION: '无需分配',
  VOIDED: '已作废',
};

export type MetricCompare = {
  direction: 'up' | 'down' | 'flat' | 'new';
  percent: number | null;
  label: string;
};

export type ProfitPoolHint = {
  ready: boolean;
  label: string;
  detail: string;
  status: ProfitPoolBatchStatus | null;
  poolCode: string | null;
  pendingBatchCount: number;
};

export type RebateDayStatus = {
  date: string;
  status: 'empty' | 'settled' | 'pending';
  label: string;
  turnoverUsers: number;
  paidUsers: number;
};

export type RoundLiveStats = {
  headline: string | null;
  detail: string | null;
};

export function malaysiaHour(date: Date): number {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kuala_Lumpur',
    hour: '2-digit',
    hour12: false,
  }).format(date);
  return Number(hour);
}

export function compareMetric(today: number | bigint, yesterday: number | bigint): MetricCompare {
  const current = Number(today);
  const prior = Number(yesterday);
  if (current === prior) return { direction: 'flat', percent: 0, label: '与昨日持平' };
  if (prior === 0) {
    return current > 0
      ? { direction: 'new', percent: null, label: '较昨日新增' }
      : { direction: 'flat', percent: 0, label: '与昨日持平' };
  }
  const percent = Math.round(((current - prior) / prior) * 100);
  if (percent === 0) return { direction: 'flat', percent: 0, label: '与昨日持平' };
  const sign = percent > 0 ? '+' : '';
  return {
    direction: percent > 0 ? 'up' : 'down',
    percent,
    label: `较昨日 ${sign}${percent}%`,
  };
}

export function formatWaitLabel(seconds: number | null | undefined): string | null {
  if (seconds == null) return null;
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 60) return `${safe}秒`;
  if (safe < 3600) return `${Math.floor(safe / 60)}分钟`;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  return minutes > 0 ? `${hours}小时${minutes}分` : `${hours}小时`;
}

export function formatRm(cents: bigint | number): string {
  const value = typeof cents === 'bigint' ? cents : BigInt(cents);
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}

export function profitPoolHint(
  now: Date,
  todayBatch: { poolCode: string; status: ProfitPoolBatchStatus } | null,
  pendingBatchCount = 0,
  legacyPendingCount = 0,
): ProfitPoolHint {
  const pendingTotal = pendingBatchCount + legacyPendingCount;
  const pendingSuffix =
    pendingTotal > 0 ? ` · ${pendingTotal} 个批次待发放` : '';

  if (todayBatch) {
    return {
      ready: true,
      label: todayBatch.poolCode,
      detail: `${PROFIT_POOL_STATUS_LABELS[todayBatch.status]}${pendingSuffix}`,
      status: todayBatch.status,
      poolCode: todayBatch.poolCode,
      pendingBatchCount: pendingTotal,
    };
  }
  if (malaysiaHour(now) < 14) {
    return {
      ready: false,
      label: '报表准备中',
      detail: `请在下午2点后查看${pendingSuffix}`,
      status: null,
      poolCode: null,
      pendingBatchCount: pendingTotal,
    };
  }
  return {
    ready: false,
    label: '今日批次尚未生成',
    detail: `下午2点后可生成利润池报表${pendingSuffix}`,
    status: null,
    poolCode: null,
    pendingBatchCount: pendingTotal,
  };
}

export function resolveRebateDayStatus(
  date: string,
  turnoverUsers: number,
  paidUsers: number,
): RebateDayStatus {
  if (turnoverUsers === 0) {
    return { date, status: 'empty', label: '无有效流水', turnoverUsers, paidUsers };
  }
  if (paidUsers >= turnoverUsers) {
    return { date, status: 'settled', label: '已入账', turnoverUsers, paidUsers };
  }
  return {
    date,
    status: 'pending',
    label: `待结算 · 差 ${turnoverUsers - paidUsers} 人`,
    turnoverUsers,
    paidUsers,
  };
}

export function shouldAlertCancelled(today: number, compare?: MetricCompare): boolean {
  if (today >= CANCELLED_ALERT_MIN) return true;
  if (!compare || compare.direction !== 'up') return false;
  return (compare.percent ?? 0) >= 50 && today > 0;
}

export function startModeLabel(mode: RoomStartMode): string {
  return START_MODE_LABELS[mode];
}

export function phaseLabel(phase: RoundPhase | null): string {
  return phase ? PHASE_LABELS[phase] : '等待开局';
}

export function packetChannelLabel(channel: PacketChannel | null | undefined): string {
  return channel === PacketChannel.INTERNAL ? '内部红包' : 'TNG 外链';
}

export function remainingSeconds(endsAt: Date | null | undefined, now: Date): number | null {
  if (!endsAt) return null;
  return Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / 1000));
}

export function phaseCountdownSeconds(
  phase: RoundPhase | null,
  ends: { bidEndsAt?: Date | null; betEndsAt?: Date | null; claimEndsAt?: Date | null },
  now: Date,
): number | null {
  if (phase === RoundPhase.BANKER_BID) return remainingSeconds(ends.bidEndsAt, now);
  if (phase === RoundPhase.BETTING) return remainingSeconds(ends.betEndsAt, now);
  if (phase === RoundPhase.CLAIMING) return remainingSeconds(ends.claimEndsAt, now);
  return null;
}

export function phaseWaitingSeconds(
  phase: RoundPhase | null,
  refs: { betEndsAt?: Date | null; claimEndsAt?: Date | null },
  now: Date,
): number | null {
  if (phase === RoundPhase.SENDING_PACKET && refs.betEndsAt) {
    return Math.max(0, Math.floor((now.getTime() - refs.betEndsAt.getTime()) / 1000));
  }
  if (phase === RoundPhase.CLAIM_EXPIRED && refs.claimEndsAt) {
    return Math.max(0, Math.floor((now.getTime() - refs.claimEndsAt.getTime()) / 1000));
  }
  return null;
}

export function isSendingPacketStuck(
  phase: RoundPhase | null,
  waitingSeconds: number | null,
): boolean {
  return (
    phase === RoundPhase.SENDING_PACKET
    && waitingSeconds != null
    && waitingSeconds >= SENDING_PACKET_STUCK_SECONDS
  );
}

export function buildRoundLiveStats(input: {
  phase: RoundPhase | null;
  potCents: bigint;
  topBidCents: bigint | null;
  betCount: number;
  claimCount: number;
  participantCount: number | null;
}): RoundLiveStats {
  switch (input.phase) {
    case RoundPhase.BANKER_BID:
      return {
        headline:
          input.topBidCents != null
            ? `最高庄钱 RM ${formatRm(input.topBidCents)}`
            : '尚无出价',
        detail: null,
      };
    case RoundPhase.BETTING:
      return {
        headline: input.potCents > 0n ? `庄钱 RM ${formatRm(input.potCents)}` : '庄位已定',
        detail: `${input.betCount} 闲家已下注`,
      };
    case RoundPhase.SENDING_PACKET:
      return {
        headline: `${input.betCount + 1} 人待发包`,
        detail: null,
      };
    case RoundPhase.CLAIMING:
    case RoundPhase.CLAIM_EXPIRED: {
      const total = input.participantCount ?? input.betCount + 1;
      const missing = Math.max(0, total - input.claimCount);
      return {
        headline: `${input.claimCount}/${total} 已认额`,
        detail: missing > 0 ? `还差 ${missing} 人` : null,
      };
    }
    default:
      return { headline: null, detail: null };
  }
}

function cents(value: bigint | number | null | undefined): string {
  return String(value ?? 0n);
}

function ageSeconds(from: Date | null | undefined, now: Date): number | null {
  if (!from) return null;
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1000));
}

export async function buildAdminDashboard(now = new Date()) {
  const todayKey = malaysiaDay(now);
  const yesterdayKey = previousDay(todayKey);
  const today = malaysiaDayWindow(todayKey);
  const yesterday = malaysiaDayWindow(yesterdayKey);

  const room = await prisma.room.findUnique({
    where: { gameCode: SUPREME_NIUNIU_GAME_CODE },
    select: {
      id: true,
      title: true,
      status: true,
      roundStartMode: true,
      chatMutedAt: true,
      chatMuteReason: true,
    },
  });

  const [
    pendingKyc,
    pendingDeposits,
    pendingWithdrawals,
    pendingWithdrawAccounts,
    packetTransit,
    todaySettlements,
    yesterdaySettlements,
    todaySettleSum,
    yesterdaySettleSum,
    todayCancelled,
    yesterdayCancelled,
    todayPushFailures,
    reconcileAnomalies,
    claimReviewRounds,
    unreadSupport,
    todayNewUsers,
    liveRound,
    onlineMembers,
    latestProfitPool,
    pendingProfitPoolBatches,
    legacyProfitPoolPending,
    pendingClaimInbox,
    oldestPendingDeposit,
    oldestPendingWithdraw,
    oldestPendingKyc,
    oldestPendingWithdrawAccount,
    oldestUnreadSupport,
    yesterdayTurnoverUsers,
    yesterdayRebatePaid,
    gameSettings,
  ] = await Promise.all([
    prisma.kyc.count({ where: { status: 'PENDING' } }),
    prisma.depositOrder.aggregate({
      where: { status: 'PENDING' },
      _count: { _all: true },
      _sum: { amountCents: true },
    }),
    prisma.withdrawOrder.aggregate({
      where: { status: 'PENDING' },
      _count: { _all: true },
      _sum: { amountCents: true },
    }),
    prisma.withdrawAccount.count({ where: { status: 'PENDING' } }),
    prisma.platformAccount.findUnique({ where: { accountType: 'TNG_TRANSIT' } }),
    prisma.round.count({
      where: { phase: RoundPhase.FINISHED, settledAt: { gte: today.gte, lt: today.lt } },
    }),
    prisma.round.count({
      where: { phase: RoundPhase.FINISHED, settledAt: { gte: yesterday.gte, lt: yesterday.lt } },
    }),
    prisma.settlement.aggregate({
      where: { createdAt: { gte: today.gte, lt: today.lt } },
      _sum: { betCents: true, rakeCents: true },
    }),
    prisma.settlement.aggregate({
      where: { createdAt: { gte: yesterday.gte, lt: yesterday.lt } },
      _sum: { betCents: true, rakeCents: true },
    }),
    prisma.round.count({
      where: { phase: RoundPhase.CANCELLED, finishedAt: { gte: today.gte, lt: today.lt } },
    }),
    prisma.round.count({
      where: { phase: RoundPhase.CANCELLED, finishedAt: { gte: yesterday.gte, lt: yesterday.lt } },
    }),
    prisma.pushLog.count({ where: { success: false, sentAt: { gte: today.gte, lt: today.lt } } }),
    prisma.packet.count({
      where: { status: 'EXPIRED', round: { phase: { in: [RoundPhase.FINISHED, RoundPhase.CANCELLED] } } },
    }),
    prisma.round.count({ where: { phase: RoundPhase.CLAIM_EXPIRED } }),
    prisma.chatMessage.count({ where: { senderType: 'USER', readAt: null } }),
    prisma.user.count({
      where: { kind: UserKind.HUMAN, createdAt: { gte: today.gte, lt: today.lt } },
    }),
    room
      ? prisma.round.findFirst({
          where: {
            roomId: room.id,
            phase: { in: [...ACTIVE_PHASES, RoundPhase.WAITING] },
          },
          orderBy: { seqNo: 'desc' },
          select: {
            id: true,
            seqNo: true,
            phase: true,
            potCents: true,
            bidEndsAt: true,
            betEndsAt: true,
            claimEndsAt: true,
            packet: {
              select: {
                channel: true,
                participantCount: true,
                schedulerLastError: true,
                sentAt: true,
              },
            },
            bids: {
              orderBy: { amountCents: 'desc' },
              take: 1,
              select: { amountCents: true },
            },
            _count: { select: { bets: true, claims: true } },
          },
        })
      : Promise.resolve(null),
    room
      ? prisma.roomMember.count({
          where: {
            roomId: room.id,
            status: MembershipStatus.ACTIVE,
            lastSeenAt: { gte: new Date(now.getTime() - ONLINE_HEARTBEAT_MS) },
          },
        })
      : Promise.resolve(0),
    room
      ? prisma.profitPoolBatch.findFirst({
          where: { roomId: room.id },
          orderBy: { generatedAt: 'desc' },
          select: {
            poolCode: true,
            status: true,
            generatedAt: true,
          },
        })
      : Promise.resolve(null),
    prisma.profitPoolBatch.count({ where: { status: ProfitPoolBatchStatus.PENDING } }),
    prisma.profitPoolDaily.count({ where: { status: 'PENDING' } }),
    prisma.tngClaimInbox.count({ where: { status: 'PENDING' } }),
    prisma.depositOrder.findFirst({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
    prisma.withdrawOrder.findFirst({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
    prisma.kyc.findFirst({
      where: { status: 'PENDING' },
      orderBy: { submittedAt: 'asc' },
      select: { submittedAt: true },
    }),
    prisma.withdrawAccount.findFirst({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
    prisma.chatMessage.findFirst({
      where: { senderType: 'USER', readAt: null },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
    prisma.turnoverDaily.count({
      where: { date: yesterdayKey, gameCode: SUPREME_NIUNIU_GAME_CODE },
    }),
    prisma.rebateSettlement.count({
      where: {
        date: yesterdayKey,
        gameCode: SUPREME_NIUNIU_GAME_CODE,
        status: 'PAID',
      },
    }),
    getGameSettings(SUPREME_NIUNIU_GAME_CODE),
  ]);

  const todayBets = todaySettleSum._sum.betCents ?? 0n;
  const todayRake = todaySettleSum._sum.rakeCents ?? 0n;
  const yesterdayBets = yesterdaySettleSum._sum.betCents ?? 0n;
  const yesterdayRake = yesterdaySettleSum._sum.rakeCents ?? 0n;
  const todayBatch =
    latestProfitPool && malaysiaDay(latestProfitPool.generatedAt) === todayKey
      ? latestProfitPool
      : null;

  const compare = {
    settlements: compareMetric(todaySettlements, yesterdaySettlements),
    bets: compareMetric(todayBets, yesterdayBets),
    rake: compareMetric(todayRake, yesterdayRake),
    cancelled: compareMetric(todayCancelled, yesterdayCancelled),
  };

  const activePhase = liveRound && ACTIVE_PHASES.includes(liveRound.phase) ? liveRound.phase : null;
  const packetChannel =
    liveRound?.packet?.channel
    ?? (gameSettings.round.packetChannel === 'INTERNAL' ? PacketChannel.INTERNAL : PacketChannel.TNG);
  const phaseWaiting = phaseWaitingSeconds(activePhase, liveRound ?? {}, now);
  const roundStats = buildRoundLiveStats({
    phase: activePhase,
    potCents: liveRound?.potCents ?? 0n,
    topBidCents: liveRound?.bids[0]?.amountCents ?? null,
    betCount: liveRound?._count.bets ?? 0,
    claimCount: liveRound?._count.claims ?? 0,
    participantCount: liveRound?.packet?.participantCount ?? null,
  });

  return {
    asOf: now.toISOString(),
    malaysiaDay: todayKey,
    pendingKyc,
    pendingDeposits: pendingDeposits._count._all,
    pendingDepositCents: cents(pendingDeposits._sum.amountCents),
    pendingWithdrawals: pendingWithdrawals._count._all,
    pendingWithdrawCents: cents(pendingWithdrawals._sum.amountCents),
    pendingWithdrawAccounts,
    unreadSupport,
    activeRounds: activePhase ? 1 : 0,
    packetTransitCents: cents(packetTransit?.balanceCents),
    todaySettlements,
    todayBetsCents: cents(todayBets),
    todayRakeCents: cents(todayRake),
    todayCancelled,
    todayNewUsers,
    todayPushFailures,
    reconcileAnomalies,
    claimReviewRounds,
    pendingClaimInbox,
    pendingProfitPoolBatches,
    legacyProfitPoolPending,
    todoAging: {
      depositsSeconds: ageSeconds(oldestPendingDeposit?.createdAt, now),
      withdrawalsSeconds: ageSeconds(oldestPendingWithdraw?.createdAt, now),
      kycSeconds: ageSeconds(oldestPendingKyc?.submittedAt, now),
      withdrawAccountsSeconds: ageSeconds(oldestPendingWithdrawAccount?.createdAt, now),
      supportSeconds: ageSeconds(oldestUnreadSupport?.createdAt, now),
    },
    yesterday: {
      settlements: yesterdaySettlements,
      betsCents: cents(yesterdayBets),
      rakeCents: cents(yesterdayRake),
      cancelled: yesterdayCancelled,
    },
    compare,
    cancelledAlert: shouldAlertCancelled(todayCancelled, compare.cancelled),
    rebateYesterday: resolveRebateDayStatus(
      yesterdayKey,
      yesterdayTurnoverUsers,
      yesterdayRebatePaid,
    ),
    roomLive: room
      ? {
          roomId: room.id,
          title: room.title,
          status: room.status,
          statusLabel: ROOM_STATUS_LABELS[room.status],
          startMode: room.roundStartMode,
          startModeLabel: startModeLabel(room.roundStartMode),
          chatMuted: Boolean(room.chatMutedAt),
          chatMuteReason: room.chatMuteReason,
          chatMuteLabel: room.chatMutedAt ? '运营全群禁言' : '运营未封群',
          onlineCount: onlineMembers,
          packetChannel,
          packetChannelLabel: packetChannelLabel(packetChannel),
          phase: activePhase ?? liveRound?.phase ?? null,
          phaseLabel: phaseLabel(activePhase ?? liveRound?.phase ?? null),
          seqNo: liveRound?.seqNo ?? null,
          countdownSeconds: activePhase
            ? phaseCountdownSeconds(activePhase, liveRound ?? {}, now)
            : null,
          phaseWaitingSeconds: phaseWaiting,
          phaseWaitingLabel: formatWaitLabel(phaseWaiting),
          sendingPacketStuck: isSendingPacketStuck(activePhase, phaseWaiting),
          schedulerLastError: liveRound?.packet?.schedulerLastError ?? null,
          roundStats,
        }
      : null,
    profitPool: profitPoolHint(
      now,
      todayBatch,
      pendingProfitPoolBatches,
      legacyProfitPoolPending,
    ),
  };
}
