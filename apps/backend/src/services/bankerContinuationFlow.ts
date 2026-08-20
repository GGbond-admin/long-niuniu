import { RoundPhase } from '@prisma/client';
import { fromCents } from '../engine/betting.js';
import { prisma } from '../lib/prisma.js';
import { withRedisLock } from '../lib/redis.js';
import {
  bankerContinuationFunding,
  continueBanker,
  ensureWaitingRound,
  GameError,
  startRound,
} from './game.js';
import { gameBus } from './gameBus.js';
import { appendSystemChatOnce, rebroadcastRoomState } from './roomHub.js';
import {
  CONTINUATION_REJECTED_INSUFFICIENT,
  ROOM_ANNOUNCED_FINISHED,
} from './roomChatPolicy.js';

function mention(user: {
  uid: string;
  nickname?: string | null;
  tgUsername?: string | null;
}): string {
  const nickname = user.nickname?.trim();
  if (nickname) return `@${nickname}`;
  if (user.tgUsername) return `@${user.tgUsername}`;
  return `@UID${user.uid}`;
}

function centsDetail(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  return null;
}

const CONTINUATION_DECISION_LOCK_MS = 30_000;
const CONTINUATION_REBROADCAST_INTERVAL_MS = 30_000;
const lastContinuationRebroadcastAt = new Map<string, number>();

function continuationDecisionLockKey(roundId: string): string {
  return `niuniu:round:${roundId}:continuation:decision`;
}

/**
 * 余额不足提示与公开竞标切换共用同一跨实例锁。提示使用稳定消息 ID，
 * 因此按钮重试、scheduler 补偿与多实例并发都不会重复发言。
 */
async function rejectInsufficientContinuationLocked(params: {
  previousRoundId: string;
  requiredCents?: bigint;
  availableCents?: bigint;
  /** 按钮事务已在该瞬间确认余额不足；后续即时入账也不撤销本次降级。 */
  confirmedAtAttempt?: boolean;
}): Promise<void> {
  const previous = await prisma.round.findUnique({
    where: { id: params.previousRoundId },
    select: {
      id: true,
      roomId: true,
      phase: true,
      bankerId: true,
      continuationUsed: true,
      isContinued: true,
      events: {
        where: {
          type: {
            in: [
              ROOM_ANNOUNCED_FINISHED,
              CONTINUATION_REJECTED_INSUFFICIENT,
            ],
          },
        },
        select: { id: true, type: true, payload: true },
      },
    },
  });
  if (!previous) throw new GameError('ROUND_NOT_FOUND');
  const announced = previous.events.some(
    (event) => event.type === ROOM_ANNOUNCED_FINISHED,
  );
  const rejected = previous.events.find(
    (event) => event.type === CONTINUATION_REJECTED_INSUFFICIENT,
  );
  if (
    previous.phase !== RoundPhase.FINISHED
    || !previous.bankerId
    || !announced
  ) {
    throw new GameError('CONTINUATION_NOT_STARTED');
  }
  if ((previous.continuationUsed || previous.isContinued) && !rejected) return;

  const funding = await bankerContinuationFunding(previous.id);
  if (!rejected && !params.confirmedAtAttempt && funding.sufficient) return;
  const rejectedPayload =
    rejected?.payload
    && typeof rejected.payload === 'object'
    && !Array.isArray(rejected.payload)
      ? rejected.payload as Record<string, unknown>
      : {};
  const requiredCents =
    centsDetail(rejectedPayload.requiredCents)
    ?? params.requiredCents
    ?? funding.requiredCents;
  const availableCents =
    centsDetail(rejectedPayload.availableCents)
    ?? params.availableCents
    ?? funding.availableCents;

  // 先持久化不可逆决策；若进程随后退出，scheduler 会补发同一条提示并继续开局。
  await prisma.roundEvent.upsert({
    where: {
      id: `round:${previous.id}:continuation:rejected-insufficient`,
    },
    create: {
      id: `round:${previous.id}:continuation:rejected-insufficient`,
      roundId: previous.id,
      type: CONTINUATION_REJECTED_INSUFFICIENT,
      payload: {
        requiredCents: String(requiredCents),
        availableCents: String(availableCents),
      },
    },
    update: {},
  });
  await appendSystemChatOnce(
    previous.roomId,
    `round:${previous.id}:continuation:insufficient`,
    [
      '【续庄余额不足】',
      `庄家 ${mention(funding)} 续庄需冻结 ${fromCents(requiredCents)}，`
        + `当前可用 ${fromCents(availableCents)}，下一局立即转入公开竞标。`,
    ].join('\n'),
    { force: true },
  );

  const waiting = await ensureWaitingRound(previous.roomId);
  if (waiting.phase !== RoundPhase.WAITING) {
    lastContinuationRebroadcastAt.delete(previous.id);
    return;
  }
  try {
    const started = await startRound(waiting.id, false, undefined, 'AUTO');
    gameBus.transition({
      roundId: started.id,
      roomId: started.roomId,
      from: RoundPhase.WAITING,
      to: started.phase,
    });
    lastContinuationRebroadcastAt.delete(previous.id);
  } catch (error) {
    if (error instanceof GameError && error.code === 'NOT_ENOUGH_PLAYERS') {
      const lastBroadcastAt = lastContinuationRebroadcastAt.get(previous.id) ?? 0;
      if (Date.now() - lastBroadcastAt >= CONTINUATION_REBROADCAST_INTERVAL_MS) {
        await rebroadcastRoomState({
          roomId: previous.roomId,
          roundId: waiting.id,
          phase: RoundPhase.WAITING,
        });
        lastContinuationRebroadcastAt.set(previous.id, Date.now());
      }
      return;
    }
    // 另一实例已经推进成功时无需把竞态暴露给玩家。
    if (
      error instanceof GameError
      && ['INVALID_PHASE', 'ROUND_START_DISABLED'].includes(error.code)
    ) {
      return;
    }
    throw error;
  }
}

export async function rejectInsufficientContinuation(params: {
  previousRoundId: string;
  requiredCents?: bigint;
  availableCents?: bigint;
  confirmedAtAttempt?: boolean;
}): Promise<void> {
  await withRedisLock(
    continuationDecisionLockKey(params.previousRoundId),
    CONTINUATION_DECISION_LOCK_MS,
    async () => rejectInsufficientContinuationLocked(params),
  );
}

export async function continueBankerWithFallback(
  previousRoundId: string,
  userId: string,
): Promise<'CONTINUED' | 'BANKER_BID'> {
  const result = await withRedisLock(
    continuationDecisionLockKey(previousRoundId),
    CONTINUATION_DECISION_LOCK_MS,
    async () => {
      try {
        const continued = await continueBanker(previousRoundId, userId);
        gameBus.transition({
          roundId: continued.id,
          roomId: continued.roomId,
          from: RoundPhase.WAITING,
          to: RoundPhase.BETTING,
        });
        return 'CONTINUED' as const;
      } catch (error) {
        if (!(error instanceof GameError) || error.code !== 'INSUFFICIENT_BALANCE') {
          throw error;
        }
        await rejectInsufficientContinuationLocked({
          previousRoundId,
          requiredCents: centsDetail(error.details?.requiredCents) ?? undefined,
          availableCents: centsDetail(error.details?.availableCents) ?? undefined,
          confirmedAtAttempt: true,
        });
        return 'BANKER_BID' as const;
      }
    },
  );
  if (result === null) throw new GameError('CONTINUATION_IN_PROGRESS');
  return result;
}
