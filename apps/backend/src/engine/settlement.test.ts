import { describe, expect, it } from 'vitest';
import { settleRound } from './settlement.js';
import { toCents } from './betting.js';
import { DEFAULT_HAND_CONFIG } from './hand.js';

const handConfig = {
  ...DEFAULT_HAND_CONFIG,
  // 测试用普通点倍数：全部 1 倍，便于核对金额
  normalMultipliers: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1 },
};

describe('单局结算（06 文档 §6 / 04 文档 T01–T08）', () => {
  it('T01 闲赢：倍数12（对子）注10，庄池充足 → 闲净+114，抽水6，庄-120', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('3.42'), // 普通 9 点
      potCents: toCents('1000'),
      players: [{ userId: 'p1', betCents: toCents('10'), claimCents: toCents('1.22') }], // 对子 12x
      handConfig,
    });
    const pair = r.pairs[0];
    expect(pair.outcome).toBe('PLAYER_WIN');
    expect(pair.multiplier).toBe(12);
    expect(pair.payableCents).toBe(toCents('120'));
    expect(pair.paidCents).toBe(toCents('120'));
    expect(pair.rakeCents).toBe(toCents('6'));
    expect(pair.playerNetCents).toBe(toCents('114'));
    expect(pair.bankerNetCents).toBe(-toCents('120'));
  });

  it('T02 闲赢但庄池不足 → 实付=庄池，免赔>0', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('3.42'),
      potCents: toCents('80'),
      players: [{ userId: 'p1', betCents: toCents('10'), claimCents: toCents('1.22') }],
      handConfig,
    });
    const pair = r.pairs[0];
    expect(pair.paidCents).toBe(toCents('80'));
    expect(pair.shortfallCents).toBe(toCents('40'));
    expect(pair.rakeCents).toBe(toCents('4')); // 按实付抽
    expect(pair.playerNetCents).toBe(toCents('76'));
  });

  it('T03 闲输注10 → 闲-10，庄净+9.5，抽水0.5', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('1.22'), // 对子
      potCents: toCents('1000'),
      players: [{ userId: 'p1', betCents: toCents('10'), claimCents: toCents('3.42') }], // 普通9点
      handConfig,
    });
    const pair = r.pairs[0];
    expect(pair.outcome).toBe('BANKER_WIN');
    expect(pair.playerNetCents).toBe(-toCents('10'));
    expect(pair.bankerNetCents).toBe(toCents('9.5'));
    expect(pair.rakeCents).toBe(toCents('0.5'));
  });

  it('T04 金额完全相同 → 平局不结算不抽水', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('2.80'),
      potCents: toCents('1000'),
      players: [{ userId: 'p1', betCents: toCents('10'), claimCents: toCents('2.80') }],
      handConfig,
    });
    expect(r.pairs[0].outcome).toBe('TIE');
    expect(r.pairs[0].rakeCents).toBe(0);
    expect(r.stats.tie).toBe(1);
  });

  it('同点（10点）比金额：2.80 赢 1.09', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('1.09'),
      potCents: toCents('1000'),
      players: [{ userId: 'p1', betCents: toCents('10'), claimCents: toCents('2.80') }],
      handConfig,
    });
    expect(r.pairs[0].outcome).toBe('PLAYER_WIN');
  });

  it('闲家自爆（≤3点普通）直接输', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('1.30'), // 普通4点，不自爆
      potCents: toCents('1000'),
      players: [{ userId: 'p1', betCents: toCents('10'), claimCents: toCents('1.20') }], // 普通3点自爆
      handConfig,
    });
    expect(r.pairs[0].outcome).toBe('BANKER_WIN');
    expect(r.pairs[0].isBustPlayer).toBe(true);
  });

  it('庄家自爆 → 未自爆闲家全赢；双自爆 → 庄赢', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('1.20'), // 普通3点自爆
      potCents: toCents('1000'),
      players: [
        { userId: 'p1', betCents: toCents('10'), claimCents: toCents('1.30') }, // 普通4点，不自爆
        { userId: 'p2', betCents: toCents('10'), claimCents: toCents('1.10') }, // 普通2点自爆
      ],
      handConfig,
    });
    expect(r.pairs[0].outcome).toBe('PLAYER_WIN');
    // 双自爆 → 庄赢（已确认）
    expect(r.pairs[1].outcome).toBe('BANKER_WIN');
    expect(r.pairs[1].isBustPlayer).toBe(true);
    expect(r.pairs[1].isBustBanker).toBe(true);
  });

  it('庄家费用：庄钱5000 → 上庄费50；服务费38；30人代包费31.2', () => {
    const players = Array.from({ length: 29 }, (_, i) => ({
      userId: `p${i}`,
      betCents: toCents('10'),
      claimCents: toCents('3.42'),
    }));
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('1.22'),
      potCents: toCents('5000'),
      players,
      participantCount: 30,
      handConfig,
    });
    expect(r.fees.seatFeeCents).toBe(toCents('50'));
    expect(r.fees.serviceFeeCents).toBe(toCents('38'));
    expect(r.fees.packetFeeCents).toBe(toCents('31.2'));
  });

  it('庄家净结果 = 盈亏 − 三费（成绩单口径）', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('1.22'), // 对子，庄赢
      potCents: toCents('5000'),
      players: [{ userId: 'p1', betCents: toCents('100'), claimCents: toCents('3.42') }],
      participantCount: 2,
      handConfig,
    });
    // 庄收 100 - 5 抽水 = 95；费用 = 50 + 38 + 2.08
    expect(r.bankerGrossCents).toBe(toCents('95'));
    expect(r.fees.totalCents).toBe(toCents('50') + toCents('38') + 2 * 104);
    expect(r.bankerNetCents).toBe(r.bankerGrossCents - r.fees.totalCents);
  });
});
