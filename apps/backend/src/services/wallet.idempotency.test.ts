import { AccountType, LedgerDirection } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { post } from './wallet.js';

function transactionWith(existing: Record<string, unknown>) {
  return {
    ledgerEntry: {
      findUnique: vi.fn().mockResolvedValue(existing),
      create: vi.fn(),
    },
    wallet: {
      update: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    platformAccount: {
      upsert: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
  };
}

const input = {
  userId: 'user-1',
  accountType: AccountType.USER_AVAILABLE,
  direction: LedgerDirection.DEBIT,
  amountCents: 5_000n,
  refType: 'tip',
  refId: 'request-1',
  idempotencyKey: 'tip:user-1:request-1:out',
};

describe('钱包分录幂等校验', () => {
  it('完全相同的重放直接返回', async () => {
    const tx = transactionWith(input);

    await expect(post(tx as never, input)).resolves.toBeUndefined();
    expect(tx.wallet.update).not.toHaveBeenCalled();
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
  });

  it('拒绝同一账务键对应不同金额', async () => {
    const tx = transactionWith({ ...input, amountCents: 10_000n });

    await expect(post(tx as never, input)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect(tx.wallet.update).not.toHaveBeenCalled();
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
  });
});
