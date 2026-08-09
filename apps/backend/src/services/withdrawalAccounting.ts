import { AccountType, type Prisma } from '@prisma/client';
import { transfer } from './wallet.js';

function snapshotRecord(snapshot: unknown): Record<string, unknown> {
  return snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    ? (snapshot as Record<string, unknown>)
    : {};
}

export function withdrawFeeCents(snapshot: unknown): bigint {
  const value = snapshotRecord(snapshot).feeCents;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return 0n;
  return BigInt(value);
}

export function withdrawUsedFreeQuota(snapshot: unknown): boolean {
  return snapshotRecord(snapshot).freeQuota === true;
}

export function withdrawalAmounts(amountCents: bigint, snapshot: unknown) {
  const feeCents = withdrawFeeCents(snapshot);
  if (feeCents < 0n || feeCents > amountCents) {
    throw new Error('INVALID_WITHDRAW_FEE');
  }
  return {
    feeCents,
    netCents: amountCents - feeCents,
  };
}

export async function completeWithdrawalAccounting(
  tx: Prisma.TransactionClient,
  order: {
    id: string;
    userId: string;
    amountCents: bigint;
    targetSnapshot: unknown;
    operatorId: string;
  },
): Promise<void> {
  const { feeCents, netCents } = withdrawalAmounts(
    order.amountCents,
    order.targetSnapshot,
  );

  if (netCents > 0n) {
    await transfer(tx, {
      amountCents: netCents,
      from: {
        userId: order.userId,
        accountType: AccountType.USER_FREEZE_WITHDRAW,
      },
      to: { accountType: AccountType.ADJUST_CLEARING },
      refType: 'withdraw_complete',
      refId: order.id,
      idempotencyKey: `withdraw-complete:${order.id}`,
      operatorId: order.operatorId,
      memo: '提现实际到账金额',
    });
  }

  if (feeCents > 0n) {
    await transfer(tx, {
      amountCents: feeCents,
      from: {
        userId: order.userId,
        accountType: AccountType.USER_FREEZE_WITHDRAW,
      },
      to: { accountType: AccountType.PLATFORM_FEES },
      refType: 'withdraw_fee',
      refId: order.id,
      idempotencyKey: `withdraw-fee:${order.id}`,
      operatorId: order.operatorId,
      memo: '提现手续费',
    });
  }
}
