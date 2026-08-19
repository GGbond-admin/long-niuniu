import { LedgerDirection } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  platformReserveObligationsCents,
  postGameBudget,
} from './gameBudget.js';

function budgetTx(initialBalance: bigint) {
  let balance = initialBalance;
  const entries = new Map<string, Record<string, unknown>>();
  return {
    get balance() {
      return balance;
    },
    entries,
    tx: {
      gameBudgetLedgerEntry: {
        findUnique: vi.fn(async ({ where }: { where: { idempotencyKey: string } }) =>
          entries.get(where.idempotencyKey) ?? null,
        ),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          entries.set(String(data.idempotencyKey), data);
          return data;
        }),
      },
      gameBudgetAccount: {
        updateMany: vi.fn(async ({
          where,
          data,
        }: {
          where: { id: string; balanceCents?: { gte: bigint } };
          data: {
            balanceCents: { decrement?: bigint; increment?: bigint };
          };
        }) => {
          if (where.id !== 'budget-1') return { count: 0 };
          const minimum = where.balanceCents?.gte;
          if (minimum !== undefined && balance < minimum) return { count: 0 };
          balance -= data.balanceCents.decrement ?? 0n;
          balance += data.balanceCents.increment ?? 0n;
          return { count: 1 };
        }),
        findUniqueOrThrow: vi.fn(async () => ({ balanceCents: balance })),
      },
    },
  };
}

function debit(idempotencyKey: string, amountCents = 7_000n) {
  return {
    budgetAccountId: 'budget-1',
    direction: LedgerDirection.DEBIT,
    amountCents,
    refType: 'group_packet_create',
    refId: `packet-${idempotencyKey}`,
    idempotencyKey,
    gameAdminAssignmentId: 'assignment-1',
  };
}

describe('游戏共享预算原子记账', () => {
  it('并发扣减依靠条件更新，余额不足的一笔原子失败且不超扣', async () => {
    const memory = budgetTx(10_000n);

    const results = await Promise.allSettled([
      postGameBudget(memory.tx as never, debit('request-a')),
      postGameBudget(memory.tx as never, debit('request-b')),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'INSUFFICIENT_GAME_BUDGET' },
    });
    expect(memory.balance).toBe(3_000n);
    expect(memory.tx.gameBudgetLedgerEntry.create).toHaveBeenCalledOnce();
  });

  it('相同幂等键和相同参数直接回放原余额，不再次变更账户', async () => {
    const memory = budgetTx(10_000n);
    await postGameBudget(memory.tx as never, debit('request-a'));
    memory.tx.gameBudgetAccount.updateMany.mockClear();

    await expect(
      postGameBudget(memory.tx as never, debit('request-a')),
    ).resolves.toEqual({ balanceCents: 3_000n, duplicate: true });
    expect(memory.tx.gameBudgetAccount.updateMany).not.toHaveBeenCalled();
  });

  it('拒绝把同一幂等键重用于不同金额', async () => {
    const memory = budgetTx(10_000n);
    await postGameBudget(memory.tx as never, debit('request-a'));

    await expect(
      postGameBudget(memory.tx as never, debit('request-a', 1_000n)),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(memory.balance).toBe(3_000n);
  });

  it('平台可用备付金扣除群红包托管与进行中内部红包义务', async () => {
    const tx = {
      groupPacket: {
        aggregate: vi.fn(async () => ({
          _sum: { remainingCents: 4_000n },
        })),
      },
      packet: {
        findMany: vi.fn(async () => [
          {
            totalCents: 10_000n,
            claims: [{ amountCents: 3_000n }, { amountCents: 2_000n }],
          },
        ]),
      },
    };

    await expect(
      platformReserveObligationsCents(tx as never),
    ).resolves.toBe(9_000n);
    expect(tx.packet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          channel: 'INTERNAL',
          status: { in: ['SENT', 'EXPIRED'] },
        },
      }),
    );
  });
});
