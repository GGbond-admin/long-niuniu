import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BETTING_CONFIG,
  bettingRange,
  fromCents,
  parseBetMessage,
  toCents,
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
