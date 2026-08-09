/**
 * 虚拟玩家自动行动：监听阶段切换，按能力与策略延迟竞标/下注/掷骰/偶发聊天。
 * 下注/竞标会像真人一样先在群里发出金额消息。
 */
import { RoundPhase } from '@prisma/client';
import { continuationDeadline } from '../engine/bankerContinuation.js';
import { bettingRange, fromCents } from '../engine/betting.js';
import { prisma } from '../lib/prisma.js';
import { announceBidPlaced } from './bidAuction.js';
import { runBankerDiceCeremony } from './chatCommands.js';
import {
  currentRoundForRoom,
  continueBanker,
  GameError,
  placeBankerBid,
  placeBet,
} from './game.js';
import { gameBus, type RoundTransitionEvent } from './gameBus.js';
import { getGameSettings, parseSettingsSnapshot } from './gameSettings.js';
import { appendChat } from './roomHub.js';
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
) {
  const existing = pending.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pending.delete(key);
    void task().catch((error) => {
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

  const minBid = BigInt(settings.round.bankerBidMinCents);
  const maxBid = BigInt(settings.round.bankerBidMaxCents);
  const bidders = virtuals.filter(
    (profile) => profile.canBid && profile.canBanker && profile.user.roomMemberships.length,
  );

  for (const profile of bidders) {
    if (Math.random() > profile.bidWeight) continue;

    const delayMs = Math.floor(randBetween(600, 8_000));
    schedule(delayKey(roundId, profile.userId, 'bid'), delayMs, async () => {
      const current = await prisma.round.findUnique({ where: { id: roundId } });
      if (!current || current.phase !== RoundPhase.BANKER_BID) return;
      await topUpVirtualIfNeeded(profile.userId);
      const high = await prisma.bankerBid.findFirst({
        where: { roundId },
        orderBy: { amountCents: 'desc' },
        select: { amountCents: true },
      });
      let amount = high ? high.amountCents + BigInt(Math.floor(randBetween(100, 2_500))) : minBid;
      if (!high) {
        amount += BigInt(Math.floor(randBetween(0, Number(minBid))));
      }
      if (amount < minBid) amount = minBid;
      if (amount > maxBid) amount = maxBid;

      echoPlayerAmount(roomId, profile.user, amount);
      await placeBankerBid(roundId, profile.userId, amount);
      await announceBidPlaced({
        roomId,
        roundId,
        userId: profile.userId,
        amountCents: amount,
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
      const current = await prisma.round.findUnique({ where: { id: roundId } });
      if (!current || current.phase !== RoundPhase.BETTING) return;
      if (current.bankerId === profile.userId) return;
      if (!current.betEndsAt || current.betEndsAt <= new Date()) return;
      await topUpVirtualIfNeeded(profile.userId);

      const liveRange = bettingRange(
        Number(current.potCents),
        Math.max(1, members),
        snap.betting,
      );

      const useAllIn =
        profile.canAllIn
        && liveRange.shMaxCents >= liveRange.shMinCents
        && Math.random() < 0.08;

      let amountCents: bigint;
      let isAllIn = false;
      if (useAllIn) {
        isAllIn = true;
        const span = Math.max(0, liveRange.shMaxCents - liveRange.shMinCents);
        amountCents = BigInt(
          liveRange.shMinCents + Math.floor(Math.random() * (span + 1)),
        );
      } else {
        amountCents = pickBetAmountCents(liveRange);
      }

      echoPlayerAmount(roomId, profile.user, amountCents, isAllIn);
      await placeBet(roundId, profile.userId, amountCents, isAllIn);
      await maybeChat(roomId, profile.user, profile.chatPhrases, profile.canChat);
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
  params: { roomId: string; roundId: string; userId: string; deadline: number },
  attempt = 0,
) {
  try {
    await topUpVirtualIfNeeded(params.userId);
    const continued = await continueBanker(params.roundId, params.userId);
    gameBus.transition({
      roundId: continued.id,
      roomId: continued.roomId,
      from: RoundPhase.WAITING,
      to: RoundPhase.BETTING,
    });
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
  const [currentSettings, round] = await Promise.all([
    currentSettingsForRoom(roomId),
    prisma.round.findUnique({ where: { id: roundId } }),
  ]);
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
  if (currentSettings.round.assistantEnabled === false) return;
  if (!round.configSnapshot) return;

  const settings = parseSettingsSnapshot(round.configSnapshot);
  const deadline = continuationDeadline(
    round.finishedAt,
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

  // 至少预留两秒给自动补款与续庄事务；恢复较晚时立即执行。
  const latestStartMs = Math.max(0, deadline - Date.now() - 2_000);
  const delayMs = Math.min(Math.floor(randBetween(700, 1_800)), latestStartMs);
  schedule(
    delayKey(roundId, profile.userId, 'continue'),
    delayMs,
    () =>
      executeVirtualContinuation({
        roomId,
        roundId,
        userId: profile.userId,
        deadline,
      }),
  );
}

async function handleTransition(event: RoundTransitionEvent) {
  clearRoundTimers(event.roundId);
  if (event.to === RoundPhase.BANKER_BID) {
    await actOnBidPhase(event.roomId, event.roundId);
  } else if (event.to === RoundPhase.BETTING) {
    await actOnBetPhase(event.roomId, event.roundId);
  } else if (event.to === RoundPhase.SENDING_PACKET) {
    await scheduleVirtualDiceForRound(event.roomId, event.roundId);
  } else if (event.to === RoundPhase.FINISHED) {
    await actOnContinuationPhase(event.roomId, event.roundId);
  }
}

async function handleTransitionWithRetry(event: RoundTransitionEvent, attempt = 0) {
  try {
    await handleTransition(event);
  } catch (error) {
    const delayMs =
      event.to === RoundPhase.FINISHED ? RECOVERY_RETRY_DELAYS_MS[attempt] : undefined;
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
      () => handleTransitionWithRetry(event, attempt + 1),
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
        finishedAt: { not: null },
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

  await topUpVirtualIfNeeded(profile.userId);

  if (params.action === 'chat') {
    if (!profile.canChat) throw new GameError('VIRTUAL_CAPABILITY_DENIED', { capability: 'chat' });
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
    echoPlayerAmount(profile.roomId, profile.user, params.amountCents);
    await placeBankerBid(round.id, profile.userId, params.amountCents);
    await announceBidPlaced({
      roomId: profile.roomId,
      roundId: round.id,
      userId: profile.userId,
      amountCents: params.amountCents,
    });
    return { ok: true };
  }

  if (params.action === 'bet') {
    if (!params.amountCents) throw new GameError('INVALID_AMOUNT');
    echoPlayerAmount(
      profile.roomId,
      profile.user,
      params.amountCents,
      Boolean(params.isAllIn),
    );
    await placeBet(round.id, profile.userId, params.amountCents, Boolean(params.isAllIn));
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
