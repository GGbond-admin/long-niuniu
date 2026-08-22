import { ProfitPoolBatchStatus, RoomStartMode, RoundPhase } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  buildRoundLiveStats,
  compareMetric,
  formatWaitLabel,
  isSendingPacketStuck,
  malaysiaHour,
  phaseCountdownSeconds,
  phaseLabel,
  phaseWaitingSeconds,
  profitPoolHint,
  remainingSeconds,
  resolveRebateDayStatus,
  shouldAlertCancelled,
  startModeLabel,
} from './adminDashboard.js';

describe('运营总览指标对照', () => {
  it('昨日为 0、今日有值视为新增', () => {
    expect(compareMetric(12, 0)).toEqual({
      direction: 'new',
      percent: null,
      label: '较昨日新增',
    });
  });

  it('两侧都为 0 视为持平', () => {
    expect(compareMetric(0n, 0n)).toEqual({
      direction: 'flat',
      percent: 0,
      label: '与昨日持平',
    });
  });

  it('按昨日计算涨跌百分比', () => {
    expect(compareMetric(12, 10)).toEqual({
      direction: 'up',
      percent: 20,
      label: '较昨日 +20%',
    });
    expect(compareMetric(8, 10)).toEqual({
      direction: 'down',
      percent: -20,
      label: '较昨日 -20%',
    });
  });
});

describe('工单等待文案', () => {
  it('按秒、分、小时格式化', () => {
    expect(formatWaitLabel(45)).toBe('45秒');
    expect(formatWaitLabel(125)).toBe('2分钟');
    expect(formatWaitLabel(3665)).toBe('1小时1分');
  });
});

describe('利润池批次提示', () => {
  it('14 点前未出批次显示准备中', () => {
    const now = new Date('2026-08-22T05:00:00.000Z');
    expect(malaysiaHour(now)).toBe(13);
    expect(profitPoolHint(now, null)).toEqual({
      ready: false,
      label: '报表准备中',
      detail: '请在下午2点后查看',
      status: null,
      poolCode: null,
      pendingBatchCount: 0,
    });
  });

  it('有待发放批次会追加提示', () => {
    expect(profitPoolHint(new Date('2026-08-22T08:00:00.000Z'), null, 2, 1)).toMatchObject({
      detail: '下午2点后可生成利润池报表 · 3 个批次待发放',
      pendingBatchCount: 3,
    });
  });

  it('今日已出批次回传批次号与状态', () => {
    expect(
      profitPoolHint(new Date('2026-08-22T08:00:00.000Z'), {
        poolCode: 'PP-20260822-01',
        status: ProfitPoolBatchStatus.PENDING,
      }),
    ).toEqual({
      ready: true,
      label: 'PP-20260822-01',
      detail: '已生成 · 待分配',
      status: ProfitPoolBatchStatus.PENDING,
      poolCode: 'PP-20260822-01',
      pendingBatchCount: 0,
    });
  });
});

describe('返水日结状态', () => {
  it('无流水、已入账、待结算', () => {
    expect(resolveRebateDayStatus('2026-08-21', 0, 0)).toMatchObject({
      status: 'empty',
      label: '无有效流水',
    });
    expect(resolveRebateDayStatus('2026-08-21', 5, 5)).toMatchObject({
      status: 'settled',
      label: '已入账',
    });
    expect(resolveRebateDayStatus('2026-08-21', 5, 2)).toMatchObject({
      status: 'pending',
      label: '待结算 · 差 3 人',
    });
  });
});

describe('取消局告警阈值', () => {
  it('达到 3 局或较昨日大涨才告警', () => {
    expect(shouldAlertCancelled(3)).toBe(true);
    expect(shouldAlertCancelled(1, { direction: 'up', percent: 100, label: '较昨日 +100%' })).toBe(true);
    expect(shouldAlertCancelled(1, { direction: 'flat', percent: 0, label: '与昨日持平' })).toBe(false);
  });
});

describe('牌桌文案与倒计时', () => {
  it('开局模式与阶段用运营中文', () => {
    expect(startModeLabel(RoomStartMode.AUTO)).toBe('自动连续');
    expect(startModeLabel(RoomStartMode.STOPPED)).toBe('结束待机');
    expect(phaseLabel(RoundPhase.CLAIMING)).toBe('抢包中');
    expect(phaseLabel(null)).toBe('等待开局');
  });

  it('只在竞标、下注、抢包阶段倒计时', () => {
    const now = new Date('2026-08-22T10:00:00.000Z');
    const ends = {
      bidEndsAt: new Date('2026-08-22T10:00:26.000Z'),
      betEndsAt: new Date('2026-08-22T10:00:40.000Z'),
      claimEndsAt: new Date('2026-08-22T10:01:00.000Z'),
    };
    expect(remainingSeconds(ends.bidEndsAt, now)).toBe(26);
    expect(phaseCountdownSeconds(RoundPhase.BANKER_BID, ends, now)).toBe(26);
    expect(phaseCountdownSeconds(RoundPhase.BETTING, ends, now)).toBe(40);
    expect(phaseCountdownSeconds(RoundPhase.CLAIMING, ends, now)).toBe(60);
    expect(phaseCountdownSeconds(RoundPhase.SETTLING, ends, now)).toBeNull();
  });

  it('待发包与认额复核会累计阶段等待', () => {
    const now = new Date('2026-08-22T10:02:00.000Z');
    expect(
      phaseWaitingSeconds(RoundPhase.SENDING_PACKET, {
        betEndsAt: new Date('2026-08-22T10:00:00.000Z'),
      }, now),
    ).toBe(120);
    expect(isSendingPacketStuck(RoundPhase.SENDING_PACKET, 120)).toBe(true);
  });

  it('本局关键数字按阶段输出', () => {
    expect(
      buildRoundLiveStats({
        phase: RoundPhase.BANKER_BID,
        potCents: 0n,
        topBidCents: 500000n,
        betCount: 0,
        claimCount: 0,
        participantCount: null,
      }).headline,
    ).toBe('最高庄钱 RM 5000.00');
    expect(
      buildRoundLiveStats({
        phase: RoundPhase.CLAIMING,
        potCents: 500000n,
        topBidCents: null,
        betCount: 4,
        claimCount: 2,
        participantCount: 5,
      }),
    ).toEqual({ headline: '2/5 已认额', detail: '还差 3 人' });
  });
});
