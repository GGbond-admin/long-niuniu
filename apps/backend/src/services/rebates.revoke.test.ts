import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountType } from '@prisma/client';

const memory = vi.hoisted(() => {
  const settlements = new Map<string, any>();
  const turnovers: any[] = [];
  const transfers: any[] = [];
  const users: any[] = [];
  return { settlements, turnovers, transfers, users };
});

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: {
      findMany: async ({ where }: any) =>
        memory.users.filter((user) => {
          const clauses = where.OR ?? [];
          if (clauses.length === 0) return true;
          return clauses.some((clause: any) => {
            if (clause.inviterId?.in) return clause.inviterId.in.includes(user.inviterId);
            if (clause.grandInviterId?.in) return clause.grandInviterId.in.includes(user.grandInviterId);
            return false;
          });
        }),
    },
    turnoverDaily: {
      findMany: async ({ where }: any) =>
        memory.turnovers.filter((row) => {
          if (where.date && row.date !== where.date) return false;
          if (where.userId?.in && !where.userId.in.includes(row.userId)) return false;
          return true;
        }),
    },
    rebateSettlement: {
      findMany: async ({ where }: any) =>
        [...memory.settlements.values()].filter((row) => {
          if (where.date && row.date !== where.date) return false;
          if (where.status && row.status !== where.status) return false;
          return true;
        }),
      findUnique: async ({ where }: any) => {
        if (where.id) return memory.settlements.get(where.id) ?? null;
        const key = where.gameCode_userId_date;
        return (
          [...memory.settlements.values()].find(
            (row) =>
              row.gameCode === key.gameCode
              && row.userId === key.userId
              && row.date === key.date,
          ) ?? null
        );
      },
      create: async ({ data }: any) => {
        const row = {
          id: `rb-${memory.settlements.size + 1}`,
          status: 'PAID',
          user: { uid: data.userId, nickname: data.userId },
          ...data,
        };
        memory.settlements.set(row.id, row);
        return { ...row };
      },
      update: async ({ where, data }: any) => {
        const row = memory.settlements.get(where.id);
        Object.assign(row, data);
        return { ...row };
      },
    },
  },
}));

vi.mock('../lib/transaction.js', () => ({
  serializable: async (task: (tx: any) => Promise<unknown>) =>
    task((await import('../lib/prisma.js')).prisma),
}));

vi.mock('./gameConfig.js', () => ({
  getGameConfig: async () => ({
    selfRate: 0.007,
    l1Rate: 0.005,
    l2Rate: 0.003,
    includeTieBets: false,
  }),
}));

vi.mock('./push.js', () => ({
  pushService: { sendCustom: vi.fn(async () => undefined) },
}));

vi.mock('./wallet.js', () => ({
  transfer: async (_tx: unknown, input: any) => {
    memory.transfers.push(input);
  },
}));

import {
  rebateOrderForDate,
  revokeRebateOrder,
  revokeRebateSettlement,
  settleRebates,
} from './rebates.js';

describe('返水日结单撤回', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T10:00:00+08:00'));
    memory.settlements.clear();
    memory.turnovers.length = 0;
    memory.transfers.length = 0;
    memory.users.length = 0;
    memory.turnovers.push({
      gameCode: 'SUPREME_NIUNIU',
      userId: 'user-karl',
      date: '2026-08-21',
      selfCents: 100_000n,
      l1Cents: 50_000n,
      l2Cents: 0n,
    });
  });

  it('日结单拆出每层流水、比例、佣金和贡献人', async () => {
    memory.users.push({
      id: 'user-dev',
      uid: '5372094886',
      nickname: 'Dev6304',
      inviterId: 'user-karl',
      grandInviterId: null,
    });
    memory.turnovers.push({
      gameCode: 'SUPREME_NIUNIU',
      userId: 'user-dev',
      date: '2026-08-21',
      selfCents: 50_000n,
      l1Cents: 0n,
      l2Cents: 0n,
    });
    const order = await settleRebates('2026-08-21');
    const karl = order.items.find((item) => item.userId === 'user-karl');
    expect(karl).toBeDefined();
    expect(order.funding).toMatchObject({
      from: '推广返水支出户',
      to: '玩家可用余额',
    });
    expect(karl).toMatchObject({
      gameTitle: '至尊牛牛',
      rates: { selfRate: 0.007, l1Rate: 0.005, l2Rate: 0.003 },
      breakdown: [
        { key: 'self', turnoverCents: '100000', rate: 0.007, commissionCents: '700' },
        { key: 'l1', turnoverCents: '50000', rate: 0.005, commissionCents: '250' },
        { key: 'l2', turnoverCents: '0', rate: 0.003, commissionCents: '0' },
      ],
      contributors: [
        {
          level: 1,
          uid: '5372094886',
          nickname: 'Dev6304',
          turnoverCents: '50000',
          commissionCents: '250',
        },
      ],
    });
  });

  it('日结后可以按人撤回，并从可用余额扣回支出户', async () => {
    const paid = await settleRebates('2026-08-21');
    expect(paid.paidCount).toBe(1);
    expect(paid.totalCommissionCents).toBe('950');
    expect(memory.transfers[0]).toMatchObject({
      refType: 'rebate',
      to: { userId: 'user-karl', accountType: AccountType.USER_AVAILABLE },
    });

    const revoked = await revokeRebateSettlement([...memory.settlements.keys()][0]!);
    expect(revoked.paidCount).toBe(0);
    expect(revoked.revokedCount).toBe(1);
    expect(memory.transfers.at(-1)).toMatchObject({
      refType: 'rebate_revoke',
      from: { userId: 'user-karl', accountType: AccountType.USER_AVAILABLE },
      to: { accountType: AccountType.PLATFORM_REBATE },
    });
  });

  it('自动补结不会把已撤回的单再发一遍，后台手动日结才会重发', async () => {
    await settleRebates('2026-08-21');
    await revokeRebateOrder('2026-08-21');
    memory.transfers.length = 0;

    const auto = await settleRebates('2026-08-21');
    expect(auto.paidCount).toBe(0);
    expect(memory.transfers).toHaveLength(0);

    const again = await settleRebates('2026-08-21', undefined, { repayRevoked: true });
    expect(again.paidCount).toBe(1);
    expect(memory.transfers[0].idempotencyKey).toMatch(/^rebate-repay:/);
  });

  it('没有已发放记录时不能撤整单', async () => {
    await expect(revokeRebateOrder('2026-08-21')).rejects.toMatchObject({
      code: 'REBATE_ORDER_EMPTY',
    });
    expect(await rebateOrderForDate('2026-08-21')).toMatchObject({
      paidCount: 0,
      revokedCount: 0,
    });
  });
});
