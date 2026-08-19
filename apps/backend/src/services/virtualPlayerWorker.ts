/**
 * 虚拟玩家自动行动：监听阶段切换，按能力与策略延迟竞标/下注/掷骰/偶发聊天。
 * 下注/竞标会像真人一样先在群里发出金额消息。
 */
import { RoundPhase } from '@prisma/client';
import { continuationDeadline } from '../engine/bankerContinuation.js';
import { bettingRange, fromCents } from '../engine/betting.js';
import { prisma } from '../lib/prisma.js';
import { withRedisLock } from '../lib/redis.js';
import { announceBidPlaced } from './bidAuction.js';
import { runBankerDiceCeremony } from './chatCommands.js';
import {
  BANKER_BID_INCREMENT_CENTS,
  bankerContinuationFunding,
  currentRoundForRoom,
  GameError,
  placeBankerBid,
  placeBet,
} from './game.js';
import { continueBankerWithFallback } from './bankerContinuationFlow.js';
import {
  gameBus,
  type RoundAnnouncementEvent,
  type RoundTransitionEvent,
} from './gameBus.js';
import { getGameSettings, parseSettingsSnapshot } from './gameSettings.js';
import { claimGroupPacket } from './groupPacket.js';
import { appendChat } from './roomHub.js';
import {
  getRoomChatPolicy,
  ROOM_ANNOUNCED_FINISHED,
} from './roomChatPolicy.js';
import { getRoomMuteState } from './roomModeration.js';
import {
  listEnabledVirtualsForRoom,
  topUpVirtualIfNeeded,
} from './virtualPlayers.js';

const pending = new Map<string, ReturnType<typeof setTimeout>>();
const activeDiceRounds = new Set<string>();
const RECOVERY_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000] as const;
let wired = false;

const DEFAULT_CHAT_PHRASES = [
  'lets go',
  'nice',
  'come on',
  'ok',
  'good luck',
  'one more',
  'steady',
  'haha',
];

const PACKET_THANKS_PHRASES = [
  '谢谢老板',
  '发财发财',
  'thanks boss',
  '大吉大利',
  '老板大气',
  '好运来咯',
  '接住了哈哈',
];

function delayKey(roundId: string, userId: string, action: string) {
  return `${roundId}:${userId}:${action}`;
}

function clearRoundTimers(roundId: string) {
  for (const [key, timer] of pending) {
    if (key.startsWith(`${roundId}:`)) {
      clearTimeout(timer);
      pending.delete(key);
    }
  }
}

function schedule(
  key: string,
  ms: number,
  task: () => Promise<void>,
  lockAttempt = 0,
) {
  const existing = pending.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pending.delete(key);
    void withRedisLock(
      `niuniu:virtual-player:${key}`,
      30_000,
      async () => {
        await task();
        return true;
      },
    ).then((ran) => {
      // 多实例同刻触发时，落后者稍后重查数据库状态；最多重试三次。
      if (ran === null && lockAttempt < 3) {
        schedule(key, 250 + Math.floor(Math.random() * 250), task, lockAttempt + 1);
      }
    }).catch((error) => {
      if (error instanceof GameError) {
        console.warn('[virtual-player]', key, error.code, error.details ?? '');
        return;
      }
      console.error('[virtual-player]', key, error);
    });
  }, ms);
  timer.unref?.();
  pending.set(key, timer);
}

function randBetween(min: number, max: number) {
  if (max <= min) return min;
  return min + Math.random() * (max - min);
}

function pickPhrase(phrases: unknown): string | null {
  const list = Array.isArray(phrases) && phrases.length
    ? phrases.map((item) => String(item).trim()).filter(Boolean)
    : DEFAULT_CHAT_PHRASES;
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)] ?? null;
}

function formatPlayAmount(cents: bigint): string {
  const raw = fromCents(cents);
  return raw.endsWith('.00') ? raw.slice(0, -3) : raw;
}

function snapBetAmount(cents: number, min: number, max: number): number {
  let value = Math.max(min, Math.min(max, Math.floor(cents)));
  const span = max - min;
  if (span >= 500) {
    value = Math.floor(value / 100) * 100;
  } else if (span >= 50) {
    value = Math.floor(value / 10) * 10;
  }
  if (value < min) value = min;
  if (value > max) value = max;
  return value;
}

/** 在合法下注区间内取样，避免所有人挤在同一最低额 */
function pickBetAmountCents(range: {
  betMinCents: number;
  betMaxCents: number;
}): bigint {
  const min = range.betMinCents;
  const max = Math.max(min, range.betMaxCents);
  if (max <= min) return BigInt(min);

  const roll = Math.random();
  let lo: number;
  let hi: number;
  if (roll < 0.35) {
    lo = min;
    hi = min + (max - min) * 0.4;
  } else if (roll < 0.8) {
    lo = min + (max - min) * 0.25;
    hi = min + (max - min) * 0.75;
  } else {
    lo = min + (max - min) * 0.55;
    hi = max;
  }
  return BigInt(snapBetAmount(randBetween(lo, hi), min, max));
}

function echoPlayerAmount(
  roomId: string,
  user: { uid: string; nickname: string | null; avatarUrl: string | null },
  amountCents: bigint,
  isAllIn = false,
) {
  const text = isAllIn ? `sh${formatPlayAmount(amountCents)}` : formatPlayAmount(amountCents);
  appendChat(roomId, {
    type: 'TEXT',
    content: text,
    from: {
      uid: user.uid,
      nickname: user.nickname ?? user.uid,
      avatarUrl: user.avatarUrl,
    },
  });
}

async function maybeChat(
  roomId: string,
  user: { id: string; uid: string; nickname: string | null; avatarUrl: string | null },
  phrases: unknown,
  canChat: boolean,
) {
  if (!canChat || Math.random() > 0.28) return;
  const text = pickPhrase(phrases);
  if (!text) return;
  if ((await getRoomChatPolicy(roomId)).muted) return;
  if ((await getRoomMuteState(roomId))?.muted) return;
  appendChat(roomId, {
    type: 'TEXT',
    content: text,
    from: {
      uid: user.uid,
      nickname: user.nickname ?? user.uid,
      avatarUrl: user.avatarUrl,
    },
  });
}

async function currentSettingsForRoom(roomId: string) {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { gameCode: true },
  });
  if (!room) throw new GameError('ROOM_NOT_FOUND');
  return getGameSettings(room.gameCode);
}

async function actOnBidPhase(roomId: string, roundId: string) {
  const [settings, round, virtuals] = await Promise.all([
    currentSettingsForRoom(roomId),
    prisma.round.findUnique({ where: { id: roundId } }),
    listEnabledVirtualsForRoom(roomId),
  ]);
  if (!round || round.phase !== RoundPhase.BANKER_BID) return;
  if (settings.round.assistantEnabled === false) return;

  // 真人竞标仅接受整元；虚拟玩家也统一到 RM 1 的整数倍。
  const configuredMinBid = BigInt(settings.round.bankerBidMinCents);
  const configuredMaxBid = BigInt(settings.round.bankerBidMaxCents);
  const minBid = ((configuredMinBid + 99n) / 100n) * 100n;
  const maxBid = (configuredMaxBid / 100n) * 100n;
  if (minBid > maxBid) return;
  const bidders = virtuals.filter(
    (profile) => profile.canBid && profile.canBanker && profile.user.roomMemberships.length,
  );

  for (const profile of bidders) {
    if (Math.random() > profile.bidWeight) continue;

    const delayMs = Math.floor(randBetween(600, 8_000));
    schedule(delayKey(roundId, profile.userId, 'bid'), delayMs, async () => {
      if ((await getRoomMuteState(roomId))?.muted) return;
      const current = await prisma.round.findUnique({ where: { id: roundId } });
      if (!current || current.phase !== RoundPhase.BANKER_BID) return;
      const ownBid = await prisma.bankerBid.findUnique({
        where: { roundId_userId: { roundId, userId: profile.userId } },
        select: { id: true },
      });
      if (ownBid) return;
      await topUpVirtualIfNeeded(profile.userId);
      const high = await prisma.bankerBid.findFirst({
        where: { roundId },
        orderBy: { amountCents: 'desc' },
        select: { amountCents: true },
      });
      let amount = high
        ? high.amountCents + BANKER_BID_INCREMENT_CENTS
        : minBid;
      if (!high) {
        amount += BigInt(
          Math.floor(randBetween(0, Number(minBid / 100n) + 1)),
        ) * 100n;
      }
      if (amount < minBid) amount = minBid;
      if (amount > maxBid) amount = maxBid;

      const bid = await placeBankerBid(roundId, profile.userId, amount);
      echoPlayerAmount(roomId, profile.user, bid.amountCents);
      await announceBidPlaced({
        roomId,
        roundId,
        userId: profile.userId,
        amountCents: bid.amountCents,
        extendedEndsAt: bid?.extendedEndsAt ?? null,
      });
      await maybeChat(roomId, profile.user, profile.chatPhrases, profile.canChat);
    });
  }
}

async function actOnBetPhase(roomId: string, roundId: string) {
  const [settings, round, virtuals] = await Promise.all([
    currentSettingsForRoom(roomId),
    prisma.round.findUnique({
      where: { id: roundId },
      include: { room: true },
    }),
    listEnabledVirtualsForRoom(roomId),
  ]);
  if (!round || round.phase !== RoundPhase.BETTING) return;
  if (settings.round.assistantEnabled === false) return;

  const snap = parseSettingsSnapshot(round.configSnapshot);
  const members = await prisma.roomMember.count({
    where: {
      roomId,
      status: 'ACTIVE',
      user: { status: 'ACTIVE', kyc: { status: 'APPROVED' } },
    },
  });
  const range = bettingRange(
    Number(round.potCents),
    Math.max(1, members),
    snap.betting,
  );

  // 错开出手，避免同一秒全员下注
  let index = 0;
  const bettors = virtuals.filter(
    (profile) =>
      profile.canBet
      && profile.user.roomMemberships.length
      && round.bankerId !== profile.userId,
  );

  for (const profile of bettors) {
    // 约 12% 本局旁观，更像真人
    if (Math.random() < 0.12) continue;

    const slot = index;
    index += 1;
    const delayMs = Math.floor(800 + slot * randBetween(350, 900) + randBetween(0, 1_200));
    schedule(delayKey(roundId, profile.userId, 'bet'), delayMs, async () => {
      if ((await getRoomMuteState(roomId))?.muted) return;
      const current = await prisma.round.findUnique({ where: { id: roundId } });
      if (!current || current.phase !== RoundPhase.BETTING) return;
      if (current.bankerId === profile.userId) return;
      if (!current.betEndsAt || current.betEndsAt <= new Date()) return;
      const ownBet = await prisma.bet.findUnique({
        where: { roundId_userId: { roundId, userId: profile.userId } },
        select: { id: true },
      });
      if (ownBet) return;
      await topUpVirtualIfNeeded(profile.userId);

      const liveRange = bettingRange(
        Number(current.potCents),
        Math.max(1, members),
        snap.betting,
      );

      const availableCents = profile.user.wallet?.availableCents ?? 0n;
      const useAllIn =
        profile.canAllIn
        && availableCents >= BigInt(liveRange.shMinCents)
        && Math.random() < 0.08;

      let amountCents: bigint;
      let isAllIn = false;
      if (useAllIn) {
        isAllIn = true;
        const minCents = BigInt(liveRange.shMinCents);
        const span = availableCents - minCents;
        amountCents =
          minCents +
          BigInt(Math.floor(Math.random() * (Number(span > 1_000_000n ? 1_000_000n : span) + 1)));
      } else {
        amountCents = pickBetAmountCents(liveRange);
      }

      const acceptance = await placeBet(roundId, profile.userId, amountCents, isAllIn);
      echoPlayerAmount(roomId, profile.user, acceptance.acceptedCents, isAllIn);
      await maybeChat(roomId, profile.user, profile.chatPhrases, profile.canChat);
    });
  }
}

/**
 * 群红包发出后调度虚拟玩家抢包：错开延迟、偶尔跳过，更像真人；
 * 领取前复查红包仍可抢、玩家仍启用且具备能力。
 */
export function scheduleVirtualGroupPacketClaims(params: {
  roomId: string;
  packetId: string;
  senderId: string;
}) {
  void planGroupPacketClaims(params).catch((error) => {
    console.error('[virtual-player] group packet planning failed', params.packetId, error);
  });
}

async function planGroupPacketClaims(params: {
  roomId: string;
  packetId: string;
  senderId: string;
}) {
  const { roomId, packetId, senderId } = params;
  const virtuals = await listEnabledVirtualsForRoom(roomId);
  const grabbers = virtuals.filter(
    (profile) =>
      profile.canClaimGroupPacket
      && profile.user.roomMemberships.length
      && profile.userId !== senderId,
  );
  if (!grabbers.length) return;

  // 打乱顺序，避免每次都是同一批人先抢
  for (let i = grabbers.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [grabbers[i], grabbers[j]] = [grabbers[j]!, grabbers[i]!];
  }

  let slot = 0;
  for (const profile of grabbers) {
    // 约 15% 本次不抢，更像真人
    if (Math.random() < 0.15) continue;
    const delayMs = Math.floor(
      1_200 + slot * randBetween(600, 1_600) + randBetween(0, 2_500),
    );
    slot += 1;
    schedule(delayKey(packetId, profile.userId, 'grab'), delayMs, async () => {
      const [packet, current] = await Promise.all([
        prisma.groupPacket.findUnique({
          where: { id: packetId },
          select: { status: true, remainingCount: true, expiresAt: true },
        }),
        prisma.virtualPlayer.findUnique({
          where: { userId: profile.userId },
          select: { enabled: true, canClaimGroupPacket: true, canChat: true },
        }),
      ]);
      if (!packet || packet.status !== 'ACTIVE' || packet.remainingCount <= 0) return;
      if (packet.expiresAt <= new Date()) return;
      if (!current?.enabled || !current.canClaimGroupPacket) return;

      await claimGroupPacket({ packetId, userId: profile.userId });

      if (
        current.canChat
        && Math.random() < 0.3
        && !(await getRoomChatPolicy(roomId)).muted
        && !(await getRoomMuteState(roomId))?.muted
      ) {
        const text =
          PACKET_THANKS_PHRASES[Math.floor(Math.random() * PACKET_THANKS_PHRASES.length)]!;
        appendChat(roomId, {
          type: 'TEXT',
          content: text,
          from: {
            uid: profile.user.uid,
            nickname: profile.user.nickname ?? profile.user.uid,
            avatarUrl: profile.user.avatarUrl,
          },
        });
      }
    });
  }
}

export async function scheduleVirtualDiceForRound(roomId: string, roundId: string) {
  const round = await prisma.round.findUnique({ where: { id: roundId } });
  if (!round || round.phase !== RoundPhase.SENDING_PACKET || !round.bankerId) return;
  const profile = await prisma.virtualPlayer.findFirst({
    where: {
      userId: round.bankerId,
      roomId,
      enabled: true,
      canThrowDice: true,
    },
    include: {
      user: {
        select: { id: true, uid: true, nickname: true, avatarUrl: true },
      },
    },
  });
  if (!profile) return;

  const key = delayKey(roundId, profile.userId, 'dice');
  if (pending.has(key) || activeDiceRounds.has(roundId)) return;
  schedule(key, Math.floor(randBetween(1_500, 4_000)), async () => {
    if ((await getRoomMuteState(roomId))?.muted) return;
    activeDiceRounds.add(roundId);
    try {
      const retryDelays = [0, 1_000, 2_000, 4_000, 8_000] as const;
      for (const delay of retryDelays) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        const result = await runBankerDiceCeremony({ roomId, userId: profile.userId });
        if (result.kind === 'ok') return;
        const current = await currentRoundForRoom(roomId);
        if (
          !current ||
          current.id !== roundId ||
          current.phase !== RoundPhase.SENDING_PACKET ||
          current.bankerId !== profile.userId
        ) {
          return;
        }
      }
    } finally {
      activeDiceRounds.delete(roundId);
    }
  });
}

async function executeVirtualContinuation(
  params: {
    roomId: string;
    roundId: string;
    userId: string;
    deadline: number;
    requiredCents: bigint;
  },
  attempt = 0,
) {
  try {
    if ((await getRoomMuteState(params.roomId))?.muted) return;
    await topUpVirtualIfNeeded(params.userId, 'SYSTEM', params.requiredCents);
    await continueBankerWithFallback(params.roundId, params.userId);
  } catch (error) {
    const remainingMs = params.deadline - Date.now();
    // GameError 均为资格/余额/阶段等确定性拒绝；只重试数据库、网络等瞬时异常。
    if (error instanceof GameError || remainingMs <= 750) throw error;

    const retryDelayMs = Math.min(1_000, 250 * 2 ** attempt, remainingMs - 750);
    console.warn(
      '[virtual-player] continuation retry',
      params.roundId,
      `in ${retryDelayMs}ms`,
      error,
    );
    schedule(
      delayKey(params.roundId, params.userId, 'continue'),
      retryDelayMs,
      () => executeVirtualContinuation(params, attempt + 1),
    );
  }
}

async function actOnContinuationPhase(roomId: string, roundId: string) {
  const round = await prisma.round.findUnique({
    where: { id: roundId },
    include: {
      events: {
        where: { type: ROOM_ANNOUNCED_FINISHED },
        orderBy: { createdAt: 'asc' },
        take: 1,
      },
    },
  });
  if (
    !round
    || round.roomId !== roomId
    || round.phase !== RoundPhase.FINISHED
    || !round.bankerId
    || round.isContinued
    || round.continuationUsed
  ) {
    return;
  }
  if (!round.configSnapshot) return;

  const settings = parseSettingsSnapshot(round.configSnapshot);
  const deadline = continuationDeadline(
    round.events[0]?.createdAt ?? null,
    settings.round.continuationWindowSeconds,
  );
  if (deadline === null || deadline <= Date.now()) return;

  const profile = await prisma.virtualPlayer.findFirst({
    where: {
      userId: round.bankerId,
      roomId,
      enabled: true,
      canContinue: true,
    },
    select: { userId: true },
  });
  if (!profile) return;
  const continuationKey = delayKey(roundId, profile.userId, 'continue');
  if (pending.has(continuationKey)) return;
  const funding = await bankerContinuationFunding(round.id);

  // 至少预留两秒给自动补款与续庄事务；恢复较晚时立即执行。
  const latestStartMs = Math.max(0, deadline - Date.now() - 2_000);
  const delayMs = Math.min(Math.floor(randBetween(700, 1_800)), latestStartMs);
  schedule(
    continuationKey,
    delayMs,
    () =>
      executeVirtualContinuation({
        roomId,
        roundId,
        userId: profile.userId,
        deadline,
        requiredCents: funding.requiredCents,
      }),
  );
}

export async function scheduleVirtualContinuationForRound(
  roomId: string,
  roundId: string,
) {
  await actOnContinuationPhase(roomId, roundId);
}

async function handleTransition(event: RoundTransitionEvent) {
  clearRoundTimers(event.roundId);
  if (event.to === RoundPhase.BANKER_BID) {
    await actOnBidPhase(event.roomId, event.roundId);
  } else if (event.to === RoundPhase.BETTING) {
    await actOnBetPhase(event.roomId, event.roundId);
  } else if (event.to === RoundPhase.SENDING_PACKET) {
    await scheduleVirtualDiceForRound(event.roomId, event.roundId);
  }
}

async function handleAnnouncement(event: RoundAnnouncementEvent) {
  if (event.to !== RoundPhase.FINISHED) return;
  await actOnContinuationPhase(event.roomId, event.roundId);
}

async function handleTransitionWithRetry(event: RoundTransitionEvent) {
  await handleTransition(event);
}

async function handleAnnouncementWithRetry(
  event: RoundAnnouncementEvent,
  attempt = 0,
) {
  try {
    await handleAnnouncement(event);
  } catch (error) {
    const delayMs = RECOVERY_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined) throw error;
    console.warn(
      '[virtual-player] continuation preparation retry',
      event.roundId,
      `in ${delayMs}ms`,
      error,
    );
    schedule(
      delayKey(event.roundId, 'SYSTEM', 'continue-prepare'),
      delayMs,
      () => handleAnnouncementWithRetry(event, attempt + 1),
    );
  }
}

/** 进程启动时接线；并对已在进行中的局补一次调度（防重启丢行动）。 */
export function initVirtualPlayerWorker() {
  if (wired) return;
  wired = true;
  gameBus.on('round:transition', (event: RoundTransitionEvent) => {
    void handleTransitionWithRetry(event).catch((error) => {
      console.error('[virtual-player] transition failed', error);
    });
  });
  gameBus.on('round:announcement', (event: RoundAnnouncementEvent) => {
    void handleAnnouncementWithRetry(event).catch((error) => {
      console.error('[virtual-player] announcement failed', error);
    });
  });
  recoverVirtualActions();
}

function recoverVirtualActions(attempt = 0) {
  void recoverInPlayRounds().catch((error) => {
    console.error('[virtual-player] recovery failed', error);
    const delayMs = RECOVERY_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined) return;
    const timer = setTimeout(() => recoverVirtualActions(attempt + 1), delayMs);
    timer.unref?.();
  });
}

async function recoverInPlayRounds() {
  // 重启后补抢仍在进行中的群红包
  const activePackets = await prisma.groupPacket.findMany({
    where: {
      status: 'ACTIVE',
      remainingCount: { gt: 0 },
      expiresAt: { gt: new Date() },
    },
    select: { id: true, roomId: true, senderId: true },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  for (const packet of activePackets) {
    scheduleVirtualGroupPacketClaims({
      roomId: packet.roomId,
      packetId: packet.id,
      senderId: packet.senderId,
    });
  }

  const [rounds, recentContinuationCandidates] = await Promise.all([
    prisma.round.findMany({
      where: {
        phase: {
          in: [RoundPhase.BANKER_BID, RoundPhase.BETTING, RoundPhase.SENDING_PACKET],
        },
      },
      select: { id: true, roomId: true, phase: true },
      take: 50,
    }),
    prisma.round.findMany({
      where: {
        phase: RoundPhase.FINISHED,
        bankerId: { not: null },
        isContinued: false,
        continuationUsed: false,
        events: { some: { type: ROOM_ANNOUNCED_FINISHED } },
      },
      orderBy: { finishedAt: 'desc' },
      select: { id: true, roomId: true },
      take: 100,
    }),
  ]);
  let firstError: unknown;
  for (const round of rounds) {
    try {
      await handleTransition({
        roundId: round.id,
        roomId: round.roomId,
        from: RoundPhase.WAITING,
        to: round.phase,
      });
    } catch (error) {
      firstError ??= error;
      console.error('[virtual-player] round recovery failed', round.id, error);
    }
  }
  for (const round of recentContinuationCandidates) {
    try {
      await actOnContinuationPhase(round.roomId, round.id);
    } catch (error) {
      firstError ??= error;
      console.error('[virtual-player] continuation recovery failed', round.id, error);
    }
  }
  if (firstError !== undefined) throw firstError;
}

/** 管理后台手动代操作 */
export async function actAsVirtualPlayer(params: {
  virtualPlayerId: string;
  action: 'bid' | 'bet' | 'dice' | 'chat';
  amountCents?: bigint;
  isAllIn?: boolean;
  text?: string;
}) {
  const profile = await prisma.virtualPlayer.findUnique({
    where: { id: params.virtualPlayerId },
    include: {
      user: {
        select: { id: true, uid: true, nickname: true, avatarUrl: true, status: true },
      },
    },
  });
  if (!profile || !profile.enabled) throw new GameError('VIRTUAL_DISABLED');
  const round = await currentRoundForRoom(profile.roomId);
  if (!round && params.action !== 'chat') throw new GameError('ROUND_NOT_FOUND');
  const roomMute = await getRoomMuteState(profile.roomId);
  if (roomMute?.muted) {
    throw new GameError('ROOM_GLOBAL_MUTED', {
      mutedAt: roomMute.mutedAt,
      reason: roomMute.reason,
    });
  }

  await topUpVirtualIfNeeded(profile.userId);

  if (params.action === 'chat') {
    if (!profile.canChat) throw new GameError('VIRTUAL_CAPABILITY_DENIED', { capability: 'chat' });
    const chatPolicy = await getRoomChatPolicy(profile.roomId);
    if (chatPolicy.muted) {
      throw new GameError('ROOM_CHAT_PHASE_MUTED', { stage: chatPolicy.stage });
    }
    const content = (params.text ?? pickPhrase(profile.chatPhrases) ?? 'hi').trim();
    appendChat(profile.roomId, {
      type: 'TEXT',
      content: content.slice(0, 200),
      from: {
        uid: profile.user.uid,
        nickname: profile.user.nickname ?? profile.user.uid,
        avatarUrl: profile.user.avatarUrl,
      },
    });
    return { ok: true };
  }

  if (!round) throw new GameError('ROUND_NOT_FOUND');

  if (params.action === 'bid') {
    if (!params.amountCents) throw new GameError('INVALID_AMOUNT');
    const bid = await placeBankerBid(round.id, profile.userId, params.amountCents);
    echoPlayerAmount(profile.roomId, profile.user, bid.amountCents);
    await announceBidPlaced({
      roomId: profile.roomId,
      roundId: round.id,
      userId: profile.userId,
      amountCents: bid.amountCents,
      extendedEndsAt: bid?.extendedEndsAt ?? null,
    });
    return { ok: true };
  }

  if (params.action === 'bet') {
    if (!params.amountCents) throw new GameError('INVALID_AMOUNT');
    const acceptance = await placeBet(
      round.id,
      profile.userId,
      params.amountCents,
      Boolean(params.isAllIn),
    );
    echoPlayerAmount(
      profile.roomId,
      profile.user,
      acceptance.acceptedCents,
      Boolean(params.isAllIn),
    );
    return { ok: true };
  }

  if (params.action === 'dice') {
    const result = await runBankerDiceCeremony({
      roomId: profile.roomId,
      userId: profile.userId,
    });
    if (result.kind !== 'ok') throw new GameError('INVALID_PHASE', { message: result.message });
    return { ok: true, dice: result.dice };
  }

  throw new GameError('INVALID_ACTION');
}
