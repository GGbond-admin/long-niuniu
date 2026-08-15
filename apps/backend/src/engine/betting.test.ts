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

// 用系数=1 的档位来校验基础公式
const flatConfig = {
  ...DEFAULT_BETTING_CONFIG,
  playerCoefTiers: [{ maxPlayers: Infinity, coef: 1.0 }],
};

describe('动态范围（06 文档 §3）', () => {
  it('庄钱 5000 → 下注 2~25 / 梭哈 20~250', () => {
    const r = bettingRange(toCents('5000'), 30, flatConfig);
    expect(r.betMinCents).toBe(toCents('2'));
    expect(r.betMaxCents).toBe(toCents('25'));
    expect(r.shMinCents).toBe(toCents('20'));
    expect(r.shMaxCents).toBe(toCents('250'));
  });
  it('庄钱 10000 → 下注 2~50 / 梭哈 20~500', () => {
    const r = bettingRange(toCents('10000'), 30, flatConfig);
    expect(r.betMaxCents).toBe(toCents('50'));
    expect(r.shMaxCents).toBe(toCents('500'));
  });
  it('庄钱 8540 → 下注上限 42.7 / 梭哈上限 427（对应截图 2~42 / 20~427）', () => {
    const r = bettingRange(toCents('8540'), 30, flatConfig);
    expect(r.betMaxCents).toBe(toCents('42.7'));
    expect(r.shMaxCents).toBe(toCents('427'));
  });
  it('人数少 → 系数上调（默认 <10 人 ×2）', () => {
    const r = bettingRange(toCents('5000'), 8);
    expect(r.betMaxCents).toBe(toCents('50')); // 25 × 2
  });
  it('范围校验', () => {
    const r = bettingRange(toCents('5000'), 30, flatConfig);
    expect(validateBet(toCents('10'), false, r).ok).toBe(true);
    expect(validateBet(toCents('26'), false, r).ok).toBe(false);
    expect(validateBet(toCents('100'), true, r).ok).toBe(true);
    expect(validateBet(toCents('300'), true, r).ok).toBe(false);
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

  it('梭哈使用梭哈最低与最高范围', () => {
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
      adjusted: true,
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
