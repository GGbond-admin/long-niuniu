import { AccountType, Prisma, type ProfitPoolBatchStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { serializable } from '../lib/transaction.js';
import { malaysiaDay } from './rebates.js';
import { pushService } from './push.js';
import { ProfitPoolError } from './profitPool.js';
import {
  computeProfitPoolRange,
  serializeRangeBreakdown,
  type ProfitPoolRangeComputation,
} from './profitPoolRange.js';
import { transfer } from './wallet.js';

export interface ProfitPoolBatchInput {
  roomId: string;
  startSeqNo: number;
  endSeqNo: number;
  expenseBps: number;
}

export interface GenerateProfitPoolBatchInput extends ProfitPoolBatchInput {
  calculationHash: string;
  actorId: string;
  auditIp?: string;
}

const PROFIT_POOL_TRANSACTION_OPTIONS = {
  maxWaitMs: 10_000,
  timeoutMs: 120_000,
};

function isRoundLockConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  const metaText = JSON.stringify(
    (error as { meta?: unknown } | null)?.meta ?? {},
  ).toLowerCase();
  // PostgreSQL exclusion constraints are not represented by Prisma schema and Prisma 6
  // currently surfaces 23P01 as PrismaClientUnknownRequestError. Match our named
  // constraint explicitly; never translate unrelated unknown database failures.
  if (
    message.includes('profit_pool_batches_room_seq_range_excl') ||
    metaText.includes('profit_pool_batches_room_seq_range_excl')
  ) {
    return true;
  }
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }
  if (
    (error.code === 'P2004' || error.code === 'P2010') &&
    metaText.includes('23p01')
  ) {
    return true;
  }
  if (error.code !== 'P2002') return false;
  const target = Array.isArray(error.meta?.target)
    ? error.meta.target.join(',')
    : String(error.meta?.target ?? '');
  return (
    target.includes('round_id') ||
    target.includes('room_id') ||
    target.includes('seq_no') ||
    target.includes('profit_pool_round_locks')
  );
}

function nextPoolCode(day: string, value: number): string {
  return `TB${day.replaceAll('-', '')}${String(value).padStart(4, '0')}`;
}

export async function previewProfitPoolBatch(
  input: ProfitPoolBatchInput,
): Promise<ProfitPoolRangeComputation> {
  return computeProfitPoolRange(input);
}

/**
 * 正式生成：同一 Serializable 事务内重新计算、校验预览指纹、编号、永久锁局并保存快照。
 * 此步骤不转账；DOCX 的「确认生成」完成后，局锁不会再释放。
 */
export async function generateProfitPoolBatch(input: GenerateProfitPoolBatchInput) {
  try {
    return await serializable(async (tx) => {
      const legacyPendingCount = await tx.profitPoolDaily.count({
        where: { status: 'PENDING' },
      });
      if (legacyPendingCount > 0) {
        throw new ProfitPoolError('LEGACY_PENDING_EXISTS', { count: legacyPendingCount });
      }

      const computation = await computeProfitPoolRange(input, tx);
      if (computation.calculationHash !== input.calculationHash) {
        throw new ProfitPoolError('PREVIEW_STALE', {
          expectedHash: input.calculationHash,
          actualHash: computation.calculationHash,
        });
      }

      const day = malaysiaDay();
      const sequence = await tx.profitPoolSequence.upsert({
        where: { key: `PROFIT_POOL:${day.replaceAll('-', '')}` },
        create: { key: `PROFIT_POOL:${day.replaceAll('-', '')}`, value: 1 },
        update: { value: { increment: 1 } },
      });
      const poolCode = nextPoolCode(day, sequence.value);
      const status: ProfitPoolBatchStatus =
        computation.netPoolCents > 0n ? 'PENDING' : 'NO_DISTRIBUTION';
      const batch = await tx.profitPoolBatch.create({
        data: {
          poolCode,
          roomId: computation.room.id,
          startSeqNo: computation.startSeqNo,
          endSeqNo: computation.endSeqNo,
          roundCount: computation.roundCount,
          finishedRoundCount: computation.finishedRoundCount,
          cancelledRoundCount: computation.cancelledRoundCount,
          turnoverPlayerCents: computation.financials.turnoverPlayerCents,
          turnoverBankerCents: computation.financials.turnoverBankerCents,
          turnoverCents: computation.financials.turnoverCents,
          rakePlayerCents: computation.financials.rakePlayerCents,
          rakeBankerCents: computation.financials.rakeBankerCents,
          rakeTotalCents: computation.financials.rakeTotalCents,
          expenseBps: computation.expenseBps,
          expenseCents: computation.expenseCents,
          netPoolCents: computation.netPoolCents,
          distributedCents: computation.distributedCents,
          residualCents: computation.residualCents,
          bucketBaseSnapshot: computation.bucketBase,
          calculationHash: computation.calculationHash,
          status,
          generatedBy: input.actorId,
        },
      });

      await tx.profitPoolRoundLock.createMany({
        data: computation.rounds.map((round) => ({
          poolId: batch.id,
          roundId: round.id,
          roomId: computation.room.id,
          seqNo: round.seqNo,
          phaseSnapshot: round.phase,
          finishedAtSnapshot: round.finishedAt,
        })),
      });
      if (computation.agents.length) {
        await tx.profitPoolAgentSnapshot.createMany({
          data: computation.agents.map((agent) => ({
            poolId: batch.id,
            sourceAgentId: agent.agentId,
            userId: agent.userId,
            parentSourceAgentId: agent.parentAgentId,
            label: agent.label,
            uid: agent.uid,
            nickname: agent.nickname,
            avatarUrl: agent.avatarUrl,
            level: agent.level,
            statusSnapshot: agent.status,
            sharePointsSnapshot: agent.sharePoints,
            bucketBaseSnapshot: computation.bucketBase,
            directAgentCount: agent.directAgentCount,
            teamAgentCount: agent.teamAgentCount,
            directPlayerCount: agent.directPlayerCount,
            teamPlayerCount: agent.teamPlayerCount,
            selfTurnoverCents: agent.selfTurnoverCents,
            teamTurnoverCents: agent.teamTurnoverCents,
            contributionBp: agent.contributionBp,
            selfAmountCents: agent.selfAmountCents,
            overrideAmountCents: agent.overrideAmountCents,
            amountCents: agent.amountCents,
            breakdown: serializeRangeBreakdown(agent.breakdown) as Prisma.InputJsonValue,
            ledgerRef:
              agent.amountCents > 0n
                ? `profit-share:${poolCode}:${agent.agentId}`
                : null,
          })),
        });
      }
      if (computation.players.length) {
        await tx.profitPoolPlayerSnapshot.createMany({
          data: computation.players.map((player) => ({
            poolId: batch.id,
            sourceAgentId: player.agentId,
            userId: player.userId,
            uid: player.uid,
            nickname: player.nickname,
            avatarUrl: player.avatarUrl,
            bindingSource: player.bindingSource,
            isAgentSelf: player.isAgentSelf,
            turnoverCents: player.turnoverCents,
            profitCents: player.profitCents,
          })),
        });
      }
      await tx.auditLog.create({
        data: {
          adminId: input.actorId,
          action: 'PROFIT_POOL_BATCH_GENERATED',
          target: batch.id,
          after: {
            poolCode,
            roomId: computation.room.id,
            startSeqNo: computation.startSeqNo,
            endSeqNo: computation.endSeqNo,
            expenseBps: computation.expenseBps,
            netPoolCents: String(computation.netPoolCents),
            distributedCents: String(computation.distributedCents),
            status,
          },
          ip: input.auditIp,
        },
      });

      return tx.profitPoolBatch.findUniqueOrThrow({
        where: { id: batch.id },
        include: {
          room: { select: { id: true, title: true, gameCode: true } },
          agentSnapshots: { orderBy: [{ level: 'asc' }, { label: 'asc' }] },
        },
      });
    }, 3, PROFIT_POOL_TRANSACTION_OPTIONS);
  } catch (error) {
    if (isRoundLockConflict(error)) throw new ProfitPoolError('RANGE_OVERLAP');
    throw error;
  }
}

/**
 * 待分配 → 已分配。状态 CAS 与钱包账本幂等键共同保证重复点击不会重复入账。
 */
export async function distributeProfitPoolBatch(
  poolId: string,
  adminId: string,
  auditIp?: string,
) {
  const result = await serializable(async (tx) => {
    const batch = await tx.profitPoolBatch.findUnique({
      where: { id: poolId },
      include: {
        agentSnapshots: {
          orderBy: { amountCents: 'desc' },
        },
      },
    });
    if (!batch) throw new ProfitPoolError('POOL_NOT_GENERATED');
    if (batch.status === 'DISTRIBUTED') return null;
    if (batch.status !== 'PENDING') throw new ProfitPoolError('POOL_NOT_CONFIRMABLE');
    const snapshotTotal = batch.agentSnapshots.reduce(
      (total, share) => total + share.amountCents,
      0n,
    );
    const distributableCents = batch.netPoolCents > 0n ? batch.netPoolCents : 0n;
    if (
      snapshotTotal !== batch.distributedCents
      || snapshotTotal > distributableCents
      || batch.agentSnapshots.some((share) => share.amountCents < 0n)
    ) {
      throw new ProfitPoolError('DISTRIBUTION_SNAPSHOT_MISMATCH', {
        distributableCents: String(distributableCents),
        recordedDistributedCents: String(batch.distributedCents),
        snapshotTotalCents: String(snapshotTotal),
      });
    }

    const distributedAt = new Date();
    const updated = await tx.profitPoolBatch.updateMany({
      where: { id: batch.id, status: 'PENDING' },
      data: {
        status: 'DISTRIBUTED',
        distributedBy: adminId,
        distributedAt,
      },
    });
    if (updated.count !== 1) return null;

    for (const share of batch.agentSnapshots) {
      if (share.amountCents <= 0n) continue;
      await transfer(tx, {
        amountCents: share.amountCents,
        from: { accountType: AccountType.PLATFORM_PROFIT_POOL },
        to: { userId: share.userId, accountType: AccountType.USER_AVAILABLE },
        refType: 'profit_share',
        refId: share.sourceAgentId,
        idempotencyKey:
          share.ledgerRef ?? `profit-share:${batch.poolCode}:${share.sourceAgentId}`,
        operatorId: adminId,
      });
    }
    await tx.auditLog.create({
      data: {
        adminId,
        action: 'PROFIT_POOL_BATCH_DISTRIBUTED',
        target: batch.id,
        after: {
          poolCode: batch.poolCode,
          distributedCents: String(batch.distributedCents),
        },
        ip: auditIp,
      },
    });
    const { agentSnapshots, ...batchFields } = batch;
    return {
      batch: {
        ...batchFields,
        status: 'DISTRIBUTED' as const,
        distributedBy: adminId,
        distributedAt,
      },
      shares: agentSnapshots,
    };
  }, 3, PROFIT_POOL_TRANSACTION_OPTIONS);

  if (!result) return null;
  for (const share of result.shares) {
    if (share.amountCents <= 0n) continue;
    const amount = `${share.amountCents / 100n}.${(share.amountCents % 100n)
      .toString()
      .padStart(2, '0')}`;
    void pushService
      .sendCustom(
        share.userId,
        `💼 ${result.batch.poolCode} 称桶分成已发放\n结算局数 ${result.batch.startSeqNo}–${result.batch.endSeqNo}，占成 ${share.sharePointsSnapshot}/${share.bucketBaseSnapshot}，RM${amount} 已进入可用余额。`,
      )
      .catch(() => undefined);
  }
  return result.batch;
}

export async function listProfitPoolRooms() {
  const rooms = await prisma.room.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      title: true,
      gameCode: true,
      status: true,
      profitPoolCutover: { select: { maxSeqNo: true, source: true, createdAt: true } },
      rounds: {
        where: { phase: { in: ['FINISHED', 'CANCELLED'] } },
        orderBy: { seqNo: 'desc' },
        take: 1,
        select: { seqNo: true, phase: true },
      },
      profitPoolBatches: {
        orderBy: { endSeqNo: 'desc' },
        take: 1,
        select: { id: true, poolCode: true, startSeqNo: true, endSeqNo: true, status: true },
      },
    },
  });
  return rooms.map((room) => ({
    id: room.id,
    title: room.title,
    gameCode: room.gameCode,
    status: room.status,
    maxTerminalSeqNo: room.rounds[0]?.seqNo ?? 0,
    cutoverSeqNo: room.profitPoolCutover?.maxSeqNo ?? 0,
    nextAvailableSeqNo: Math.max(
      room.profitPoolCutover?.maxSeqNo ?? 0,
      room.profitPoolBatches[0]?.endSeqNo ?? 0,
    ) + 1,
    latestBatch: room.profitPoolBatches[0] ?? null,
  }));
}

export async function listProfitPoolBatches(params: {
  q?: string;
  status?: ProfitPoolBatchStatus;
  roomId?: string;
  limit?: number;
  cursor?: string;
}) {
  const limit = Math.max(1, Math.min(params.limit ?? 30, 100));
  const items = await prisma.profitPoolBatch.findMany({
    where: {
      ...(params.q
        ? { poolCode: { contains: params.q.trim(), mode: 'insensitive' as const } }
        : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.roomId ? { roomId: params.roomId } : {}),
    },
    include: {
      room: { select: { id: true, title: true, gameCode: true } },
      _count: { select: { agentSnapshots: true } },
    },
    orderBy: [{ generatedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  });
  const hasMore = items.length > limit;
  if (hasMore) items.pop();
  return {
    items,
    nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
  };
}

export async function getProfitPoolBatch(id: string) {
  const batch = await prisma.profitPoolBatch.findUnique({
    where: { id },
    include: {
      room: { select: { id: true, title: true, gameCode: true } },
      agentSnapshots: { orderBy: [{ level: 'asc' }, { label: 'asc' }] },
      roundLocks: { orderBy: { seqNo: 'asc' } },
    },
  });
  if (!batch) throw new ProfitPoolError('POOL_NOT_GENERATED');
  return batch;
}

export async function getProfitPoolOverview() {
  const [latest, statusCounts, totals, legacyPendingCount] = await Promise.all([
    prisma.profitPoolBatch.findFirst({
      orderBy: { generatedAt: 'desc' },
      include: { room: { select: { id: true, title: true, gameCode: true } } },
    }),
    prisma.profitPoolBatch.groupBy({
      by: ['status'],
      _count: { _all: true },
    }),
    prisma.profitPoolBatch.aggregate({
      where: { status: 'DISTRIBUTED' },
      _sum: {
        netPoolCents: true,
        distributedCents: true,
        residualCents: true,
        turnoverCents: true,
      },
    }),
    prisma.profitPoolDaily.count({ where: { status: 'PENDING' } }),
  ]);
  return {
    latest,
    statusCounts: Object.fromEntries(statusCounts.map((row) => [row.status, row._count._all])),
    totals: totals._sum,
    legacyPendingCount,
  };
}

export function serializeProfitPoolComputation(computation: ProfitPoolRangeComputation) {
  return {
    room: computation.room,
    startSeqNo: computation.startSeqNo,
    endSeqNo: computation.endSeqNo,
    roundCount: computation.roundCount,
    finishedRoundCount: computation.finishedRoundCount,
    cancelledRoundCount: computation.cancelledRoundCount,
    expenseBps: computation.expenseBps,
    expenseCents: String(computation.expenseCents),
    netPoolCents: String(computation.netPoolCents),
    bucketBase: computation.bucketBase,
    distributedCents: String(computation.distributedCents),
    residualCents: String(computation.residualCents),
    companyRemainingPointsHundredths: computation.companyRemainingPointsHundredths,
    calculationHash: computation.calculationHash,
    financials: {
      turnoverPlayerCents: String(computation.financials.turnoverPlayerCents),
      turnoverBankerCents: String(computation.financials.turnoverBankerCents),
      turnoverCents: String(computation.financials.turnoverCents),
      rakePlayerCents: String(computation.financials.rakePlayerCents),
      rakeBankerCents: String(computation.financials.rakeBankerCents),
      rakeTotalCents: String(computation.financials.rakeTotalCents),
    },
    agents: computation.agents.map((agent) => ({
      ...agent,
      selfTurnoverCents: String(agent.selfTurnoverCents),
      teamTurnoverCents: String(agent.teamTurnoverCents),
      selfAmountCents: String(agent.selfAmountCents),
      overrideAmountCents: String(agent.overrideAmountCents),
      amountCents: String(agent.amountCents),
      breakdown: serializeRangeBreakdown(agent.breakdown),
    })),
  };
}

export function serializeProfitPoolBatch<
  T extends {
    turnoverPlayerCents: bigint;
    turnoverBankerCents: bigint;
    turnoverCents: bigint;
    rakePlayerCents: bigint;
    rakeBankerCents: bigint;
    rakeTotalCents: bigint;
    expenseCents: bigint;
    netPoolCents: bigint;
    distributedCents: bigint;
    residualCents: bigint;
  },
>(batch: T) {
  return {
    ...batch,
    turnoverPlayerCents: String(batch.turnoverPlayerCents),
    turnoverBankerCents: String(batch.turnoverBankerCents),
    turnoverCents: String(batch.turnoverCents),
    rakePlayerCents: String(batch.rakePlayerCents),
    rakeBankerCents: String(batch.rakeBankerCents),
    rakeTotalCents: String(batch.rakeTotalCents),
    expenseCents: String(batch.expenseCents),
    netPoolCents: String(batch.netPoolCents),
    distributedCents: String(batch.distributedCents),
    residualCents: String(batch.residualCents),
  };
}
