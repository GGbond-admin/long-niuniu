import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  turnoverFindMany: vi.fn(),
  settlementFindMany: vi.fn(),
  getGameConfig: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    turnoverDaily: { findMany: mocks.turnoverFindMany },
    rebateSettlement: { findMany: mocks.settlementFindMany },
  },
}));
vi.mock('../lib/transaction.js', () => ({ serializable: vi.fn() }));
vi.mock('./gameConfig.js', () => ({ getGameConfig: mocks.getGameConfig }));
vi.mock('./push.js', () => ({ pushService: { sendCustom: vi.fn() } }));
vi.mock('./wallet.js', () => ({ transfer: vi.fn() }));

import {
  estimatedCommissionInRange,
  PROMOTION_RANGE_MAX_DAYS,
  resolvePromotionPeriod,
} from './rebates.js';

describe('推广查询区间', () => {
  it('无参数时回到今天', () => {
    expect(resolvePromotionPeriod({}, '2026-08-22')).toEqual({
      from: '2026-08-22',
      to: '2026-08-22',
    });
  });

  it('兼容旧 date 参数', () => {
    expect(resolvePromotionPeriod({ date: '2026-08-15' }, '2026-08-22')).toEqual({
      from: '2026-08-15',
      to: '2026-08-15',
    });
  });

  it('起止对调、截到今天', () => {
    expect(
      resolvePromotionPeriod({ from: '2026-08-20', to: '2026-08-10' }, '2026-08-22'),
    ).toEqual({ from: '2026-08-10', to: '2026-08-20' });
    expect(
      resolvePromotionPeriod({ from: '2026-08-01', to: '2026-08-30' }, '2026-08-22'),
    ).toEqual({ from: '2026-08-01', to: '2026-08-22' });
  });

  it('超过上限拒绝', () => {
    expect(() =>
      resolvePromotionPeriod(
        { from: '2026-01-01', to: '2026-08-22' },
        '2026-08-22',
      ),
    ).toThrow('PROMOTION_RANGE_TOO_LONG');
    expect(PROMOTION_RANGE_MAX_DAYS).toBe(92);
  });
});

describe('区间佣金汇总', () => {
  it('已结算日用入账金额，未结算日按比例估算后相加', async () => {
    mocks.turnoverFindMany.mockResolvedValue([
      {
        date: '2026-08-20',
        gameCode: 'SUPREME_NIUNIU',
        selfCents: 10_000n,
        l1Cents: 0n,
        l2Cents: 0n,
      },
      {
        date: '2026-08-21',
        gameCode: 'SUPREME_NIUNIU',
        selfCents: 20_000n,
        l1Cents: 0n,
        l2Cents: 0n,
      },
    ]);
    mocks.settlementFindMany.mockResolvedValue([
      {
        date: '2026-08-20',
        gameCode: 'SUPREME_NIUNIU',
        commissionCents: 70n,
      },
    ]);
    mocks.getGameConfig.mockResolvedValue({
      selfRate: 0.007,
      l1Rate: 0.005,
      l2Rate: 0.003,
    });
    await expect(
      estimatedCommissionInRange('user-1', '2026-08-20', '2026-08-21'),
    ).resolves.toBe(210n);
  });
});
