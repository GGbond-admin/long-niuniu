import { AccountType } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  applyFinanceTrendRow,
  enumerateKlDays,
  enumerateKlRange,
  financeOrderCreatedAt,
  resolveFinanceTrendDates,
  serializeFinanceTrendDay,
  summarizeFinanceOrderStats,
} from './financeReport.js';

describe('enumerateKlDays', () => {
  it('按吉隆坡日历回填连续天数，含今天', () => {
    expect(enumerateKlDays(3, '2026-08-22')).toEqual([
      '2026-08-20',
      '2026-08-21',
      '2026-08-22',
    ]);
  });
});

describe('enumerateKlRange', () => {
  it('自由选日起止按日历展开，起止颠倒也能用', () => {
    expect(enumerateKlRange('2026-08-20', '2026-08-22')).toEqual([
      '2026-08-20',
      '2026-08-21',
      '2026-08-22',
    ]);
    expect(enumerateKlRange('2026-08-22', '2026-08-22')).toEqual(['2026-08-22']);
    expect(enumerateKlRange('2026-08-22', '2026-08-21')).toEqual([
      '2026-08-21',
      '2026-08-22',
    ]);
  });
});

describe('resolveFinanceTrendDates', () => {
  it('有起止日期时优先生效，否则回退到最近 N 日', () => {
    expect(resolveFinanceTrendDates({ from: '2026-08-21', to: '2026-08-22' }, '2026-08-22')).toEqual([
      '2026-08-21',
      '2026-08-22',
    ]);
    expect(resolveFinanceTrendDates({ days: 2 }, '2026-08-22')).toEqual([
      '2026-08-21',
      '2026-08-22',
    ]);
  });
});

describe('finance trend buckets', () => {
  it('净利 = 抽水+上庄费+服务费 − 奖励−返水−分成，充提单独记账', () => {
    const bucket = {
      date: '2026-08-22',
      rakeCents: 0n,
      seatFeeCents: 0n,
      serviceFeeCents: 0n,
      rewardsCents: 0n,
      rebatesCents: 0n,
      profitShareCents: 0n,
      depositsCents: 50_000n,
      withdrawalsCents: 10_000n,
    };
    applyFinanceTrendRow(bucket, {
      accountType: AccountType.PLATFORM_RAKE,
      direction: 'CREDIT',
      refType: 'rake',
      amountCents: 3_000n,
    });
    applyFinanceTrendRow(bucket, {
      accountType: AccountType.PLATFORM_FEES,
      direction: 'CREDIT',
      refType: 'fee_banker_seat',
      amountCents: 200n,
    });
    applyFinanceTrendRow(bucket, {
      accountType: AccountType.PLATFORM_FEES,
      direction: 'CREDIT',
      refType: 'fee_service',
      amountCents: 100n,
    });
    applyFinanceTrendRow(bucket, {
      accountType: AccountType.PLATFORM_REWARD,
      direction: 'DEBIT',
      refType: 'reward',
      amountCents: 500n,
    });
    applyFinanceTrendRow(bucket, {
      accountType: AccountType.PLATFORM_RESERVE,
      direction: 'CREDIT',
      refType: 'fee_packet_agent',
      amountCents: 9_999n,
    });

    const row = serializeFinanceTrendDay(bucket);
    expect(row.incomeCents).toBe('3300');
    expect(row.expenseCents).toBe('500');
    expect(row.netProfitCents).toBe('2800');
    expect(row.depositsCents).toBe('50000');
    expect(row.withdrawalsCents).toBe('10000');
  });
});

describe('finance order book', () => {
  it('按吉隆坡日历切提交日窗口', () => {
    const window = financeOrderCreatedAt('2026-08-22', '2026-08-22');
    expect(window?.gte).toEqual(new Date('2026-08-22T00:00:00+08:00'));
    expect(window?.lt).toEqual(new Date('2026-08-23T00:00:00+08:00'));
    expect(financeOrderCreatedAt()).toBeUndefined();
  });

  it('汇总各状态笔数与金额，全部=三态之和', () => {
    const stats = summarizeFinanceOrderStats([
      { status: 'PENDING', count: 1, amountCents: 10_000n },
      { status: 'COMPLETED', count: 2, amountCents: 30_000n },
    ]);
    expect(stats.counts).toEqual({ ALL: 3, PENDING: 1, COMPLETED: 2, REJECTED: 0 });
    expect(stats.amounts.ALL).toBe('40000');
    expect(stats.amounts.PENDING).toBe('10000');
  });
});
