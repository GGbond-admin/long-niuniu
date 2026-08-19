import {
  AccountType,
  LedgerDirection,
  type Prisma,
} from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { serializable } from '../lib/transaction.js';

type Tx = Prisma.TransactionClient;
const MAX_DB_BIGINT = 9_223_372_036_854_775_807n;

export class GameBudgetError extends Error {
  constructor(
    public code: string,
    public details?: Record<string, unknown>,
  ) {
    super(code);
  }
}

type BudgetPostingInput = {
  budgetAccountId: string;
  direction: LedgerDirection;
  amountCents: bigint;
  refType: string;
  refId?: string;
  idempotencyKey: string;
  platformAdminId?: string;
  gameAdminAssignmentId?: string;
  memo?: string;
};

function assertPositiveAmount(amountCents: bigint) {
  if (amountCents <= 0n) throw new GameBudgetError('INVALID_BUDGET_AMOUNT');
}

function sameBudgetPosting(
  existing: {
    budgetAccountId: string;
    direction: LedgerDirection;
    amountCents: bigint;
    refType: string;
    refId: string | null;
    platformAdminId: string | null;
    gameAdminAssignmentId: string | null;
    memo: string | null;
  },
  input: BudgetPostingInput,
) {
  return (
    existing.budgetAccountId === input.budgetAccountId
    && existing.direction === input.direction
    && existing.amountCents === input.amountCents
    && existing.refType === input.refType
    && (existing.refId ?? undefined) === input.refId
    && (existing.platformAdminId ?? undefined) === input.platformAdminId
    && (existing.gameAdminAssignmentId ?? undefined) === input.gameAdminAssignmentId
    && (existing.memo ?? undefined) === input.memo
  );
}

export async function platformReserveObligationsCents(tx: Tx): Promise<bigint> {
  const [groupPackets, internalPackets] = await Promise.all([
    tx.groupPacket.aggregate({
      where: { status: 'ACTIVE' },
      _sum: { remainingCents: true },
    }),
    tx.packet.findMany({
      where: {
        channel: 'INTERNAL',
        status: { in: ['SENT', 'EXPIRED'] },
      },
      select: {
        totalCents: true,
        claims: { select: { amountCents: true } },
      },
    }),
  ]);
  const internalOutstanding = internalPackets.reduce((total, packet) => {
    const claimed = packet.claims.reduce(
      (sum, claim) => sum + claim.amountCents,
      0n,
    );
    const remaining = packet.totalCents - claimed;
    return total + (remaining > 0n ? remaining : 0n);
  }, 0n);
  return (groupPackets._sum.remainingCents ?? 0n) + internalOutstanding;
}

export async function ensureGameBudgetAccount(tx: Tx, gameCode: string) {
  const room = await tx.room.findUnique({
    where: { gameCode },
    select: { gameCode: true },
  });
  if (!room) throw new GameBudgetError('GAME_NOT_FOUND');
  return tx.gameBudgetAccount.upsert({
    where: { gameCode },
    create: { gameCode },
    update: {},
  });
}

/** Records a game-budget posting and updates the materialized balance atomically. */
export async function postGameBudget(
  tx: Tx,
  input: BudgetPostingInput,
): Promise<{ balanceCents: bigint; duplicate: boolean }> {
  assertPositiveAmount(input.amountCents);
  const existing = await tx.gameBudgetLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) {
    if (!sameBudgetPosting(existing, input)) {
      throw new GameBudgetError('IDEMPOTENCY_CONFLICT');
    }
    return { balanceCents: existing.balanceAfterCents, duplicate: true };
  }

  if (input.direction === LedgerDirection.DEBIT) {
    const changed = await tx.gameBudgetAccount.updateMany({
      where: {
        id: input.budgetAccountId,
        balanceCents: { gte: input.amountCents },
      },
      data: { balanceCents: { decrement: input.amountCents } },
    });
    if (changed.count !== 1) throw new GameBudgetError('INSUFFICIENT_GAME_BUDGET');
  } else {
    const changed = await tx.gameBudgetAccount.updateMany({
      where: { id: input.budgetAccountId },
      data: { balanceCents: { increment: input.amountCents } },
    });
    if (changed.count !== 1) throw new GameBudgetError('GAME_BUDGET_NOT_FOUND');
  }

  const account = await tx.gameBudgetAccount.findUniqueOrThrow({
    where: { id: input.budgetAccountId },
    select: { balanceCents: true },
  });
  await tx.gameBudgetLedgerEntry.create({
    data: {
      budgetAccountId: input.budgetAccountId,
      direction: input.direction,
      amountCents: input.amountCents,
      balanceAfterCents: account.balanceCents,
      refType: input.refType,
      refId: input.refId,
      idempotencyKey: input.idempotencyKey,
      platformAdminId: input.platformAdminId,
      gameAdminAssignmentId: input.gameAdminAssignmentId,
      memo: input.memo,
    },
  });
  return { balanceCents: account.balanceCents, duplicate: false };
}

async function postPlatformReserve(
  tx: Tx,
  input: {
    direction: LedgerDirection;
    amountCents: bigint;
    refType: string;
    refId: string;
    idempotencyKey: string;
    operatorId: string;
    memo: string;
  },
) {
  const existing = await tx.ledgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) {
    const matches =
      existing.userId === null
      && existing.accountType === AccountType.PLATFORM_RESERVE
      && existing.direction === input.direction
      && existing.amountCents === input.amountCents
      && existing.refType === input.refType
      && existing.refId === input.refId
      && existing.operatorId === input.operatorId
      && existing.memo === input.memo;
    if (!matches) throw new GameBudgetError('IDEMPOTENCY_CONFLICT');
    return;
  }

  await tx.platformAccount.upsert({
    where: { accountType: AccountType.PLATFORM_RESERVE },
    create: { accountType: AccountType.PLATFORM_RESERVE, balanceCents: 0n },
    update: {},
  });
  if (input.direction === LedgerDirection.DEBIT) {
    const obligationsCents = await platformReserveObligationsCents(tx);
    const minimumBalance = input.amountCents + obligationsCents;
    if (minimumBalance > MAX_DB_BIGINT) {
      throw new GameBudgetError('INSUFFICIENT_PLATFORM_RESERVE');
    }
    const changed = await tx.platformAccount.updateMany({
      where: {
        accountType: AccountType.PLATFORM_RESERVE,
        balanceCents: { gte: minimumBalance },
      },
      data: { balanceCents: { decrement: input.amountCents } },
    });
    if (changed.count !== 1) throw new GameBudgetError('INSUFFICIENT_PLATFORM_RESERVE');
  } else {
    await tx.platformAccount.update({
      where: { accountType: AccountType.PLATFORM_RESERVE },
      data: { balanceCents: { increment: input.amountCents } },
    });
  }
  const account = await tx.platformAccount.findUniqueOrThrow({
    where: { accountType: AccountType.PLATFORM_RESERVE },
  });
  await tx.ledgerEntry.create({
    data: {
      accountType: AccountType.PLATFORM_RESERVE,
      direction: input.direction,
      amountCents: input.amountCents,
      balanceAfterCents: account.balanceCents,
      refType: input.refType,
      refId: input.refId,
      idempotencyKey: input.idempotencyKey,
      operatorId: input.operatorId,
      memo: input.memo,
    },
  });
}

export async function fundGameBudget(input: {
  gameCode: string;
  amountCents: bigint;
  requestId: string;
  platformAdminId: string;
  reason: string;
  ip?: string;
}) {
  assertPositiveAmount(input.amountCents);
  return serializable(async (tx) => {
    const account = await ensureGameBudgetAccount(tx, input.gameCode);
    const key = `game-budget-fund:${input.gameCode}:${input.platformAdminId}:${input.requestId}`;
    const existing = await tx.gameBudgetLedgerEntry.findUnique({
      where: { idempotencyKey: key },
    });
    if (existing) {
      if (
        existing.budgetAccountId !== account.id
        || existing.direction !== LedgerDirection.CREDIT
        || existing.amountCents !== input.amountCents
        || existing.refId !== input.requestId
        || existing.memo !== input.reason
      ) {
        throw new GameBudgetError('IDEMPOTENCY_CONFLICT');
      }
      return { account: { ...account, balanceCents: existing.balanceAfterCents }, duplicate: true };
    }

    await postPlatformReserve(tx, {
      direction: LedgerDirection.DEBIT,
      amountCents: input.amountCents,
      refType: 'game_budget_fund',
      refId: account.id,
      idempotencyKey: `${key}:platform`,
      operatorId: input.platformAdminId,
      memo: input.reason,
    });
    const posting = await postGameBudget(tx, {
      budgetAccountId: account.id,
      direction: LedgerDirection.CREDIT,
      amountCents: input.amountCents,
      refType: 'platform_fund',
      refId: input.requestId,
      idempotencyKey: key,
      platformAdminId: input.platformAdminId,
      memo: input.reason,
    });
    await tx.auditLog.create({
      data: {
        adminId: input.platformAdminId,
        action: 'game_budget_fund',
        target: input.gameCode,
        after: {
          amountCents: String(input.amountCents),
          balanceCents: String(posting.balanceCents),
          reason: input.reason,
          requestId: input.requestId,
        },
        ip: input.ip,
      },
    });
    return {
      account: { ...account, balanceCents: posting.balanceCents },
      duplicate: false,
    };
  });
}

export async function reclaimGameBudget(input: {
  gameCode: string;
  amountCents: bigint;
  requestId: string;
  platformAdminId: string;
  reason: string;
  ip?: string;
}) {
  assertPositiveAmount(input.amountCents);
  return serializable(async (tx) => {
    const account = await ensureGameBudgetAccount(tx, input.gameCode);
    const key = `game-budget-reclaim:${input.gameCode}:${input.platformAdminId}:${input.requestId}`;
    const existing = await tx.gameBudgetLedgerEntry.findUnique({
      where: { idempotencyKey: key },
    });
    if (existing) {
      if (
        existing.budgetAccountId !== account.id
        || existing.direction !== LedgerDirection.DEBIT
        || existing.amountCents !== input.amountCents
        || existing.refId !== input.requestId
        || existing.memo !== input.reason
      ) {
        throw new GameBudgetError('IDEMPOTENCY_CONFLICT');
      }
      return { account: { ...account, balanceCents: existing.balanceAfterCents }, duplicate: true };
    }

    const posting = await postGameBudget(tx, {
      budgetAccountId: account.id,
      direction: LedgerDirection.DEBIT,
      amountCents: input.amountCents,
      refType: 'platform_reclaim',
      refId: input.requestId,
      idempotencyKey: key,
      platformAdminId: input.platformAdminId,
      memo: input.reason,
    });
    await postPlatformReserve(tx, {
      direction: LedgerDirection.CREDIT,
      amountCents: input.amountCents,
      refType: 'game_budget_reclaim',
      refId: account.id,
      idempotencyKey: `${key}:platform`,
      operatorId: input.platformAdminId,
      memo: input.reason,
    });
    await tx.auditLog.create({
      data: {
        adminId: input.platformAdminId,
        action: 'game_budget_reclaim',
        target: input.gameCode,
        after: {
          amountCents: String(input.amountCents),
          balanceCents: String(posting.balanceCents),
          reason: input.reason,
          requestId: input.requestId,
        },
        ip: input.ip,
      },
    });
    return {
      account: { ...account, balanceCents: posting.balanceCents },
      duplicate: false,
    };
  });
}

export async function getGameBudgetOverview(gameCode: string) {
  const room = await prisma.room.findUnique({
    where: { gameCode },
    select: { id: true, gameCode: true },
  });
  if (!room) throw new GameBudgetError('GAME_NOT_FOUND');
  const account = await prisma.gameBudgetAccount.findUnique({
    where: { gameCode },
  });
  return {
    roomId: room.id,
    gameCode,
    account: account ?? {
      id: null,
      gameCode,
      balanceCents: 0n,
      createdAt: null,
      updatedAt: null,
    },
  };
}
