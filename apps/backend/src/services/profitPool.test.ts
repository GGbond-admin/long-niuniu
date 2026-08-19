import { describe, expect, it } from 'vitest';
import {
  bucketShareCents,
  computeAgentShares,
  expenseOf,
  previousDay,
  type AgentShareInput,
} from './profitPool.js';

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

  it('代理占成超过称桶基准时拒绝计算，禁止利润池超发', () => {
    expect(() =>
      computeAgentShares({
        netPoolCents: 10_000n,
        companyTurnoverCents: 10_000n,
        bucketBase: 50,
        agents: [
          {
            agentId: 'agent-over-limit',
            parentAgentId: null,
            sharePoints: 70,
            status: 'ACTIVE',
            selfTurnoverCents: 10_000n,
          },
        ],
      }),
    ).toThrow('INVALID_SHARE_POINTS');
  });

  it('previousDay 跨月跨年正确（马来西亚时区）', () => {
    expect(previousDay('2026-08-15')).toBe('2026-08-14');
    expect(previousDay('2026-08-01')).toBe('2026-07-31');
    expect(previousDay('2026-01-01')).toBe('2025-12-31');
  });
});

describe('上下级占成差额制（代理称桶制度与上下级分成机制说明文档）', () => {
  /** 构造代理线：所有流水都由链条末端代理的玩家产生 */
  function chain(points: number[], tailTurnover: bigint): AgentShareInput[] {
    return points.map((sharePoints, index) => ({
      agentId: `agent-${index}`,
      parentAgentId: index === 0 ? null : `agent-${index - 1}`,
      sharePoints,
      status: 'ACTIVE',
      selfTurnoverCents: index === points.length - 1 ? tailTurnover : 0n,
      label: `L${index}`,
      uid: `10000${index}`,
    }));
  }

  it('文档 4.3：公司→A65→B55→C45→D40，D线基础利润 RM10,000', () => {
    // 净池 RM10,000、公司流水全部来自 D 的玩家 → D 线基础利润 = RM10,000
    const results = computeAgentShares({
      netPoolCents: 1_000_000n,
      companyTurnoverCents: 5_000_000n,
      bucketBase: 130,
      agents: chain([65, 55, 45, 40], 5_000_000n),
    });
    const [a, b, c, d] = ['agent-0', 'agent-1', 'agent-2', 'agent-3'].map(
      (id) => results.get(id)!,
    );
    // D：自身 40/130 → RM3,076.92
    expect(d.selfAmountCents).toBe(307_692n);
    expect(d.overrideAmountCents).toBe(0n);
    // C：差额 45−40=5 → RM384.61（分向下取整；文档四舍五入为 384.62）
    expect(c.overrideAmountCents).toBe(38_461n);
    expect(c.selfAmountCents).toBe(0n);
    // B：差额 55−45=10 → RM769.23
    expect(b.overrideAmountCents).toBe(76_923n);
    // A：差额 65−55=10 → RM769.23
    expect(a.overrideAmountCents).toBe(76_923n);
    // 守恒：整条线合计 ≤ 顶层上限 65/130 = RM5,000，残差归公司
    const total =
      a.amountCents + b.amountCents + c.amountCents + d.amountCents;
    expect(total).toBe(499_999n); // 500,000 − 1 分取整残差
    expect(total <= 500_000n).toBe(true);
  });

  it('文档 4.2：A65/B55，B 团队基础利润 RM10,000 → B 55/130、A 差额 10/130', () => {
    const results = computeAgentShares({
      netPoolCents: 1_000_000n,
      companyTurnoverCents: 5_000_000n,
      bucketBase: 130,
      agents: chain([65, 55], 5_000_000n),
    });
    const a = results.get('agent-0')!;
    const b = results.get('agent-1')!;
    expect(b.selfAmountCents).toBe(423_076n); // RM4,230.76（文档四舍五入 4,230.77）
    expect(a.overrideAmountCents).toBe(76_923n); // RM769.23
    // A 不重复领取完整 65%，只取 10 点差额
    expect(a.selfAmountCents).toBe(0n);
  });

  it('团队流水自底向上聚合：中间层也有直属玩家流水', () => {
    const agents = chain([65, 55], 3_000_000n);
    agents[0].selfTurnoverCents = 2_000_000n; // A 也有直属玩家
    const results = computeAgentShares({
      netPoolCents: 1_000_000n,
      companyTurnoverCents: 5_000_000n,
      bucketBase: 130,
      agents,
    });
    const a = results.get('agent-0')!;
    const b = results.get('agent-1')!;
    expect(a.teamTurnoverCents).toBe(5_000_000n);
    expect(b.teamTurnoverCents).toBe(3_000_000n);
    // A 自身：净池 × (2/5) × 65/130 = RM2,000
    expect(a.selfAmountCents).toBe(200_000n);
    // A 差额：净池 × (3/5) × 10/130 = RM461.53…
    expect(a.overrideAmountCents).toBe(46_153n);
    // B 自身：净池 × (3/5) × 55/130
    expect(b.selfAmountCents).toBe(253_846n);
  });

  it('停用代理不领取（归公司留存），上级仍按差额领取、团队流水照常聚合', () => {
    const agents = chain([65, 55, 45], 5_000_000n);
    agents[1].status = 'DISABLED'; // B 停用
    const results = computeAgentShares({
      netPoolCents: 1_000_000n,
      companyTurnoverCents: 5_000_000n,
      bucketBase: 130,
      agents,
    });
    const a = results.get('agent-0')!;
    const b = results.get('agent-1')!;
    const c = results.get('agent-2')!;
    expect(b.amountCents).toBe(0n); // 停用不领取
    expect(a.overrideAmountCents).toBe(76_923n); // A 仍按 65−55 差额领取
    expect(c.selfAmountCents).toBe(346_153n); // C 自身 45/130 不受影响
  });

  it('下级占成被误配为不低于上级时，上级差额为 0（不产生负数）', () => {
    const results = computeAgentShares({
      netPoolCents: 1_000_000n,
      companyTurnoverCents: 1_000_000n,
      bucketBase: 130,
      agents: chain([55, 65], 1_000_000n),
    });
    expect(results.get('agent-0')!.overrideAmountCents).toBe(0n);
  });

  it('多个直属下级的差额明细逐一记录', () => {
    const agents: AgentShareInput[] = [
      {
        agentId: 'top',
        parentAgentId: null,
        sharePoints: 65,
        status: 'ACTIVE',
        selfTurnoverCents: 0n,
        label: 'A',
        uid: '1000001',
      },
      {
        agentId: 'x',
        parentAgentId: 'top',
        sharePoints: 60,
        status: 'ACTIVE',
        selfTurnoverCents: 2_000_000n,
        label: 'X',
        uid: '1000002',
      },
      {
        agentId: 'y',
        parentAgentId: 'top',
        sharePoints: 50,
        status: 'ACTIVE',
        selfTurnoverCents: 3_000_000n,
        label: 'Y',
        uid: '1000003',
      },
    ];
    const results = computeAgentShares({
      netPoolCents: 1_000_000n,
      companyTurnoverCents: 5_000_000n,
      bucketBase: 130,
      agents,
    });
    const top = results.get('top')!;
    expect(top.breakdown).toHaveLength(2);
    const [x, y] = top.breakdown;
    expect(x.diffPoints).toBe(5);
    expect(y.diffPoints).toBe(15);
    // X 团队差额：净池 × (2/5) × 5/130；Y 团队差额：净池 × (3/5) × 15/130
    expect(x.amountCents).toBe(15_384n);
    expect(y.amountCents).toBe(69_230n);
    expect(top.overrideAmountCents).toBe(84_614n);
  });
});
