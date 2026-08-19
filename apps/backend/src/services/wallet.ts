/**
 * 钱包记账服务 — 对应《04-账务与结算说明》
 * 原则：每笔变动写 ledger（幂等键唯一）；余额与流水同事务。
 */
import { AccountType, LedgerDirection, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

type Tx = Prisma.TransactionClient;

export class WalletError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
  }
}

const USER_BALANCE_FIELD: Partial<
  Record<
    AccountType,
    'availableCents' | 'freezeBankerCents' | 'freezeBetCents' | 'freezeWithdrawCents'
  >
> = {
  [AccountType.USER_AVAILABLE]: 'availableCents',
  [AccountType.USER_FREEZE_BANKER]: 'freezeBankerCents',
  [AccountType.USER_FREEZE_BET]: 'freezeBetCents',
  [AccountType.USER_FREEZE_WITHDRAW]: 'freezeWithdrawCents',
};

export interface PostingInput {
  userId?: string;
  accountType: AccountType;
  direction: LedgerDirection; // CREDIT = 增加该科目，DEBIT = 减少
  amountCents: bigint;
  refType: string;
  refId?: string;
  roundId?: string;
  idempotencyKey: string;
  operatorId?: string;
  memo?: string;
}

/** 在事务内写一条分录并同步用户/平台科目余额 */
export async function post(tx: Tx, input: PostingInput): Promise<void> {
  if (input.amountCents <= 0n) throw new WalletError('INVALID_AMOUNT');

  const existing = await tx.ledgerEntry.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) {
    const samePosting =
      (existing.userId ?? undefined) === input.userId &&
      existing.accountType === input.accountType &&
      existing.direction === input.direction &&
      existing.amountCents === input.amountCents &&
      existing.refType === input.refType &&
      (existing.refId ?? undefined) === input.refId &&
      (existing.roundId ?? undefined) === input.roundId;
    if (!samePosting) throw new WalletError('IDEMPOTENCY_CONFLICT');
    return; // 幂等：完全相同的分录已入账
  }

  let balanceAfter: bigint | null = null;
  const field = USER_BALANCE_FIELD[input.accountType];

  if (field) {
    if (!input.userId) throw new WalletError('USER_REQUIRED');
    if (input.direction === LedgerDirection.DEBIT) {
      // 条件更新防止并发请求同时通过余额检查造成超扣。
      const updated = await tx.wallet.updateMany({
        where: { userId: input.userId, [field]: { gte: input.amountCents } },
        data: { [field]: { decrement: input.amountCents } },
      });
      if (updated.count !== 1) throw new WalletError('INSUFFICIENT_BALANCE');
    } else {
      const updated = await tx.wallet.updateMany({
        where: { userId: input.userId },
        data: { [field]: { increment: input.amountCents } },
      });
      if (updated.count !== 1) throw new WalletError('WALLET_NOT_FOUND');
    }
    const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId: input.userId } });
    balanceAfter = wallet[field] as bigint;
  } else {
    if (input.userId) throw new WalletError('PLATFORM_ACCOUNT_CANNOT_HAVE_USER');
    let account: { balanceCents: bigint };
    if (
      input.accountType === AccountType.PLATFORM_RESERVE
      && input.direction === LedgerDirection.DEBIT
    ) {
      await tx.platformAccount.upsert({
        where: { accountType: input.accountType },
        create: { accountType: input.accountType, balanceCents: 0n },
        update: {},
      });
      const updated = await tx.platformAccount.updateMany({
        where: {
          accountType: input.accountType,
          balanceCents: { gte: input.amountCents },
        },
        data: { balanceCents: { decrement: input.amountCents } },
      });
      if (updated.count !== 1) throw new WalletError('INSUFFICIENT_BALANCE');
      account = await tx.platformAccount.findUniqueOrThrow({
        where: { accountType: input.accountType },
      });
    } else {
      const delta =
        input.direction === LedgerDirection.CREDIT
          ? input.amountCents
          : -input.amountCents;
      account = await tx.platformAccount.upsert({
        where: { accountType: input.accountType },
        create: { accountType: input.accountType, balanceCents: delta },
        update: { balanceCents: { increment: delta } },
      });
    }
    balanceAfter = account.balanceCents;
  }

  await tx.ledgerEntry.create({
    data: {
      userId: input.userId,
      accountType: input.accountType,
      direction: input.direction,
      amountCents: input.amountCents,
      balanceAfterCents: balanceAfter,
      refType: input.refType,
      refId: input.refId,
      roundId: input.roundId,
      idempotencyKey: input.idempotencyKey,
      operatorId: input.operatorId,
      memo: input.memo,
    },
  });
}

/** 科目转移：from 减、to 增（同事务、双分录） */
export async function transfer(
  tx: Tx,
  params: {
    amountCents: bigint;
    from: { userId?: string; accountType: AccountType };
    to: { userId?: string; accountType: AccountType };
    refType: string;
    refId?: string;
    roundId?: string;
    idempotencyKey: string; // 会派生 :out / :in
    operatorId?: string;
    memo?: string;
  },
): Promise<void> {
  await post(tx, {
    userId: params.from.userId,
    accountType: params.from.accountType,
    direction: LedgerDirection.DEBIT,
    amountCents: params.amountCents,
    refType: params.refType,
    refId: params.refId,
    roundId: params.roundId,
    idempotencyKey: `${params.idempotencyKey}:out`,
    operatorId: params.operatorId,
    memo: params.memo,
  });
  await post(tx, {
    userId: params.to.userId,
    accountType: params.to.accountType,
    direction: LedgerDirection.CREDIT,
    amountCents: params.amountCents,
    refType: params.refType,
    refId: params.refId,
    roundId: params.roundId,
    idempotencyKey: `${params.idempotencyKey}:in`,
    operatorId: params.operatorId,
    memo: params.memo,
  });
}

/** 冻结下注：可用 → 冻结-下注 */
export async function freezeBet(tx: Tx, userId: string, amountCents: bigint, roundId: string, refId: string) {
  await transfer(tx, {
    amountCents,
    from: { userId, accountType: AccountType.USER_AVAILABLE },
    to: { userId, accountType: AccountType.USER_FREEZE_BET },
    refType: 'bet',
    refId,
    roundId,
    idempotencyKey: `bet:${roundId}:${userId}:${refId}`,
  });
}

/** 冻结庄池：可用 → 冻结-庄池 */
export async function freezeBanker(tx: Tx, userId: string, amountCents: bigint, roundId: string, refId: string) {
  await transfer(tx, {
    amountCents,
    from: { userId, accountType: AccountType.USER_AVAILABLE },
    to: { userId, accountType: AccountType.USER_FREEZE_BANKER },
    refType: 'bid',
    refId,
    roundId,
    idempotencyKey: `bid:${roundId}:${userId}:${refId}`,
  });
}

/** 解冻（撤回/取消局/平局退回） */
export async function unfreeze(
  tx: Tx,
  userId: string,
  accountType: Extract<AccountType, 'USER_FREEZE_BET' | 'USER_FREEZE_BANKER'>,
  amountCents: bigint,
  roundId: string,
  reason: string,
  refId: string,
) {
  await transfer(tx, {
    amountCents,
    from: { userId, accountType },
    to: { userId, accountType: AccountType.USER_AVAILABLE },
    refType: reason,
    refId,
    roundId,
    idempotencyKey: `unfreeze:${roundId}:${userId}:${refId}`,
  });
}
