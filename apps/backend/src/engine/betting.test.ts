import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BETTING_CONFIG,
  acceptBetAmount,
  bettingRange,
  fromCents,
  maxAffordableBetCents,
  parseBetMessage,
  toCents,
  toCentsBigInt,
  validateBet,
} from './betting.js';
import { dailyCommission } from './rebate.js';

describe('动态范围（06 文档 §3）', () => {
  it('庄钱 25000 → 满注 0.6% 为 3~150，满梭哈 5% 为 30~1250', () => {
    const r = bettingRange(toCents('25000'));
    expect(r.betMinCents).toBe(toCents('3'));
    expect(r.betMaxCents).toBe(toCents('150'));
    expect(r.shMinCents).toBe(toCents('30'));
    expect(r.shMaxCents).toBe(toCents('1250'));
  });
  it('庄钱 10000、默认满注 0.6% → 下注上限 60，满梭哈 5% → 500', () => {
    const r = bettingRange(toCents('10000'));
    expect(r.betMaxCents).toBe(toCents('60'));
    expect(r.shMaxCents).toBe(toCents('500'));
  });
  it('后台满注 0.5%、满梭哈 5%：上庄 10000 → 3~50 / 30~500', () => {
    const config = { ...DEFAULT_BETTING_CONFIG, betRatio: 0.005, shRatio: 0.05 };
    const r = bettingRange(toCents('10000'), config);
    expect(r.betMinCents).toBe(toCents('3'));
    expect(r.betMaxCents).toBe(toCents('50'));
    expect(r.shMinCents).toBe(toCents('30'));
    expect(r.shMaxCents).toBe(toCents('500'));
  });
  it('庄钱 8540、默认 0.6% → 下注上限 51.24', () => {
    const r = bettingRange(toCents('8540'));
    expect(r.betMaxCents).toBe(toCents('51.24'));
  });
  it('庄钱再小也不关闭梭哈，普通/梭哈上限仍保底到最低额', () => {
    const r = bettingRange(toCents('300'));
    expect(r.shMinCents).toBe(toCents('30'));
    expect(r.shMaxCents).toBe(toCents('30'));
    expect(validateBet(toCents('30'), true, r).ok).toBe(true);
    expect(validateBet(toCents('31'), true, r).ok).toBe(false);
    expect(r.betMaxCents).toBe(toCents('3'));
  });
  it('范围校验：普通与梭哈都受房间上限', () => {
    const r = bettingRange(toCents('25000'));
    expect(validateBet(toCents('10'), false, r).ok).toBe(true);
    expect(validateBet(toCents('151'), false, r).ok).toBe(false);
    expect(validateBet(toCents('29.99'), true, r).ok).toBe(false);
    expect(validateBet(toCents('1250'), true, r).ok).toBe(true);
    expect(validateBet(toCents('1250.01'), true, r).ok).toBe(false);
  });
});

describe('最大赔付预留与自动降额', () => {
  const range = {
    betMinCents: toCents('2'),
    betMaxCents: toCents('500'),
    shMinCents: toCents('20'),
    shMaxCents: toCents('1000'),
  };

  it.each([
    ['200', '50', '11', '187'],
    ['500', '100', '29', '493'],
    ['1000', '100', '58', '986'],
    ['1700', '100', '100', '1700'],
  ])('余额 RM%s、输入 RM%s → 接受 RM%s、预留 RM%s', (balance, requested, accepted, reserved) => {
    const result = acceptBetAmount({
      requestedCents: BigInt(toCents(requested)),
      liabilityBalanceCents: BigInt(toCents(balance)),
      maxMultiplier: 17,
      isAllIn: false,
      range,
    });

    expect(result).toMatchObject({
      ok: true,
      acceptedCents: BigInt(toCents(accepted)),
      reservedCents: BigInt(toCents(reserved)),
      maxAffordableCents: BigInt(toCents(accepted)),
      adjusted: requested !== accepted,
    });
  });

  it('赔付能力上限按完整 RM 向下取整', () => {
    expect(maxAffordableBetCents(BigInt(toCents('200')), 17)).toBe(BigInt(toCents('11')));
    expect(maxAffordableBetCents(BigInt(toCents('16.99')), 17)).toBe(0n);
  });

  it('最终接受金额同时受房间动态上限约束', () => {
    const result = acceptBetAmount({
      requestedCents: BigInt(toCents('100')),
      liabilityBalanceCents: BigInt(toCents('10000')),
      maxMultiplier: 17,
      isAllIn: false,
      range: { ...range, betMaxCents: toCents('42.70') },
    });

    expect(result).toMatchObject({
      ok: true,
      acceptedCents: BigInt(toCents('42.70')),
      maxAcceptedCents: BigInt(toCents('42.70')),
      adjusted: true,
    });
  });

  it('输入低于最低下注仍拒绝，不会自动上调', () => {
    expect(
      acceptBetAmount({
        requestedCents: BigInt(toCents('1')),
        liabilityBalanceCents: BigInt(toCents('1000')),
        maxMultiplier: 17,
        isAllIn: false,
        range,
      }),
    ).toMatchObject({ ok: false, reason: 'BELOW_BET_MIN' });
  });

  it('余额连最低下注的最大赔付都无法承担时拒绝', () => {
    expect(
      acceptBetAmount({
        requestedCents: BigInt(toCents('10')),
        liabilityBalanceCents: BigInt(toCents('20')),
        maxMultiplier: 17,
        isAllIn: false,
        range,
      }),
    ).toMatchObject({
      ok: false,
      reason: 'MAX_LIABILITY_BELOW_MIN',
      maxAffordableCents: BigInt(toCents('1')),
    });
  });

  it('自定义最高倍数会同步收紧下注并增加预留', () => {
    const result = acceptBetAmount({
      requestedCents: BigInt(toCents('50')),
      liabilityBalanceCents: BigInt(toCents('200')),
      maxMultiplier: 20,
      isAllIn: false,
      range,
    });

    expect(result).toMatchObject({
      ok: true,
      acceptedCents: BigInt(toCents('10')),
      reservedCents: BigInt(toCents('200')),
    });
  });

  it('梭哈超过房间满梭哈上限时降到房间上限', () => {
    const result = acceptBetAmount({
      requestedCents: BigInt(toCents('300')),
      liabilityBalanceCents: BigInt(toCents('5000')),
      maxMultiplier: 17,
      isAllIn: true,
      range: { ...range, shMaxCents: toCents('250') },
    });

    expect(result).toMatchObject({
      ok: true,
      acceptedCents: BigInt(toCents('250')),
      reservedCents: BigInt(toCents('250')),
      maxAcceptedCents: BigInt(toCents('250')),
      adjusted: true,
      adjustedBy: ['ROOM_LIMIT'],
    });
  });

  it('梭哈按 1:1 预留，可精确到分押上全部余额', () => {
    const result = acceptBetAmount({
      requestedCents: BigInt(toCents('123.45')),
      liabilityBalanceCents: BigInt(toCents('123.45')),
      maxMultiplier: 17,
      isAllIn: true,
      range,
    });

    expect(result).toMatchObject({
      ok: true,
      acceptedCents: BigInt(toCents('123.45')),
      reservedCents: BigInt(toCents('123.45')),
      maxAffordableCents: BigInt(toCents('123.45')),
      liabilityMultiplier: 1,
      maxMultiplier: 17,
      adjusted: false,
    });
  });

  it('梭哈超出余额时降到余额本身，而不是余额 ÷ 最高倍数', () => {
    const result = acceptBetAmount({
      requestedCents: BigInt(toCents('900')),
      liabilityBalanceCents: BigInt(toCents('520.07')),
      maxMultiplier: 17,
      isAllIn: true,
      range,
    });

    expect(result).toMatchObject({
      ok: true,
      acceptedCents: BigInt(toCents('520.07')),
      reservedCents: BigInt(toCents('520.07')),
      adjustedBy: ['LIABILITY_LIMIT'],
    });
  });

  it('梭哈余额不足最低梭哈额时仍拒绝', () => {
    expect(
      acceptBetAmount({
        requestedCents: BigInt(toCents('20')),
        liabilityBalanceCents: BigInt(toCents('19.99')),
        maxMultiplier: 17,
        isAllIn: true,
        range,
      }),
    ).toMatchObject({ ok: false, reason: 'MAX_LIABILITY_BELOW_MIN' });
  });

  it('普通下注仍按最高倍数预留，并向下取整到完整 RM', () => {
    const result = acceptBetAmount({
      requestedCents: BigInt(toCents('123.45')),
      liabilityBalanceCents: BigInt(toCents('123.45')),
      maxMultiplier: 17,
      isAllIn: false,
      range,
    });

    expect(result).toMatchObject({
      ok: true,
      acceptedCents: BigInt(toCents('7')),
      reservedCents: BigInt(toCents('119')),
      liabilityMultiplier: 17,
    });
  });
});

describe('下注指令解析', () => {
  it('纯数字 → 下注', () => {
    expect(parseBetMessage('10')).toEqual({ kind: 'BET', amountCents: 1000 });
    expect(parseBetMessage('2.5')).toEqual({ kind: 'BET', amountCents: 250 });
  });
  it('sh金额 → 梭哈', () => {
    expect(parseBetMessage('sh300')).toEqual({ kind: 'ALL_IN', amountCents: 30000 });
    expect(parseBetMessage('SH 27.23')).toEqual({ kind: 'ALL_IN', amountCents: 2723 });
  });
  it('0 → 撤回', () => {
    expect(parseBetMessage('0')).toEqual({ kind: 'WITHDRAW' });
  });
  it('其他消息忽略', () => {
    expect(parseBetMessage('hello')).toEqual({ kind: 'IGNORE' });
    expect(parseBetMessage('10块')).toEqual({ kind: 'IGNORE' });
  });
});

describe('金额工具', () => {
  it('toCents / fromCents 互转', () => {
    expect(toCents('31.2')).toBe(3120);
    expect(toCents('1.04')).toBe(104);
    expect(fromCents(3120)).toBe('31.20');
    expect(fromCents(-127147)).toBe('-1271.47');
  });

  it('大额字符串直接精确解析为 BigInt，不经过 Number 舍入', () => {
    expect(toCentsBigInt('90071992547409.91')).toBe(9_007_199_254_740_991n);
    expect(toCentsBigInt('92233720368547758.07')).toBe(9_223_372_036_854_775_807n);
  });

  it('超过数据库 BIGINT 上限时明确拒绝', () => {
    expect(() => toCentsBigInt('92233720368547758.08')).toThrow('AMOUNT_TOO_LARGE');
    expect(() => toCentsBigInt('0'.repeat(10_000))).toThrow('AMOUNT_TOO_LARGE');
  });
});

describe('返水佣金（06 文档 §7）', () => {
  it('1000×0.7% + 2000×0.5% + 500×0.3% = 18.50', () => {
    const commission = dailyCommission({
      selfCents: toCents('1000'),
      l1Cents: toCents('2000'),
      l2Cents: toCents('500'),
    });
    expect(commission).toBe(toCents('18.50'));
  });
});
