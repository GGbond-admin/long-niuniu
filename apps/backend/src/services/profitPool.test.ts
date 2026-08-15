import { describe, expect, it } from 'vitest';
import { bucketShareCents, expenseOf, previousDay } from './profitPool.js';

describe('利润池与称桶分配（需求文档核对）', () => {
  it('文档第八节示例：流水30k/100k、净池7500、占成65/130 → RM1125', () => {
    const amount = bucketShareCents({
      netPoolCents: 750_000n, // RM7,500
      agentTurnoverCents: 3_000_000n, // RM30,000
      companyTurnoverCents: 10_000_000n, // RM100,000
      sharePoints: 65,
      bucketBase: 130,
    });
    expect(amount).toBe(112_500n); // RM1,125
  });

  it('文档第五节：三代理 30/20/50 分 7500，占成 130/130 时按贡献比拿满', () => {
    const base = {
      netPoolCents: 750_000n,
      companyTurnoverCents: 10_000_000n,
      sharePoints: 130,
      bucketBase: 130,
    };
    const a = bucketShareCents({ ...base, agentTurnoverCents: 3_000_000n });
    const b = bucketShareCents({ ...base, agentTurnoverCents: 2_000_000n });
    const c = bucketShareCents({ ...base, agentTurnoverCents: 5_000_000n });
    expect(a).toBe(225_000n); // RM2,250
    expect(b).toBe(150_000n); // RM1,500
    expect(c).toBe(375_000n); // RM3,750
    expect(a + b + c).toBe(750_000n); // 分满净池
  });

  it('文档第三节：公司支出 = 总流水 × 2.5%（100k → 2500）', () => {
    expect(expenseOf(10_000_000n, 0.025)).toBe(250_000n);
  });

  it('文档第六节：不同占成等级实得比例 = 点数 ÷ 130', () => {
    const base = {
      netPoolCents: 1_000_000n,
      agentTurnoverCents: 1n,
      companyTurnoverCents: 1n,
      bucketBase: 130,
    };
    // 占成 65 → 实得 50%
    expect(bucketShareCents({ ...base, sharePoints: 65 })).toBe(500_000n);
    // 占成 130 → 实得 100%
    expect(bucketShareCents({ ...base, sharePoints: 130 })).toBe(1_000_000n);
  });

  it('净池为负或流水为零时不分配', () => {
    expect(
      bucketShareCents({
        netPoolCents: -100n,
        agentTurnoverCents: 100n,
        companyTurnoverCents: 100n,
        sharePoints: 65,
        bucketBase: 130,
      }),
    ).toBe(0n);
    expect(
      bucketShareCents({
        netPoolCents: 100n,
        agentTurnoverCents: 0n,
        companyTurnoverCents: 100n,
        sharePoints: 65,
        bucketBase: 130,
      }),
    ).toBe(0n);
    expect(
      bucketShareCents({
        netPoolCents: 100n,
        agentTurnoverCents: 100n,
        companyTurnoverCents: 0n,
        sharePoints: 65,
        bucketBase: 130,
      }),
    ).toBe(0n);
  });

  it('分成向下取整到分，残差归公司', () => {
    // 净池 1.01，贡献 1/3，占成 65/130 → 理论 0.1683… → 取整 16 分
    const amount = bucketShareCents({
      netPoolCents: 101n,
      agentTurnoverCents: 1n,
      companyTurnoverCents: 3n,
      sharePoints: 65,
      bucketBase: 130,
    });
    expect(amount).toBe(16n);
  });

  it('previousDay 跨月跨年正确（马来西亚时区）', () => {
    expect(previousDay('2026-08-15')).toBe('2026-08-14');
    expect(previousDay('2026-08-01')).toBe('2026-07-31');
    expect(previousDay('2026-01-01')).toBe('2025-12-31');
  });
});
