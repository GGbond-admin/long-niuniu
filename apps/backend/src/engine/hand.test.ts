import { describe, expect, it } from 'vitest';
import {
  CompareResult,
  DEFAULT_HAND_CONFIG,
  HandType,
  compareHands,
  evaluateHand,
  handTypeOf,
  isBust,
  keyDigits,
  pointsOf,
} from './hand.js';
import { toCents } from './betting.js';

describe('点数计算（06 文档 §1.1）', () => {
  it('3.42 → 3+4+2=9 → 9点', () => {
    expect(pointsOf(toCents('3.42'))).toBe(9);
  });
  it('2.80 → 2+8+0=10 → 10点（牛牛）', () => {
    expect(pointsOf(toCents('2.80'))).toBe(10);
  });
  it('27.23 → 2+7+2+3=14 → 4点（多位整数全数字求和）', () => {
    expect(pointsOf(toCents('27.23'))).toBe(4);
  });
  it('总和个位为 0 → 10点', () => {
    expect(pointsOf(toCents('1.09'))).toBe(10); // 1+0+9=10
  });
  it('0.09 → 9点', () => {
    expect(pointsOf(toCents('0.09'))).toBe(9);
  });
});

describe('牌型判定（06 文档 §1.2）', () => {
  it('豹子：1.11 / 7.77 / 9.99', () => {
    expect(handTypeOf(toCents('1.11'))).toBe(HandType.BAOZI);
    expect(handTypeOf(toCents('7.77'))).toBe(HandType.BAOZI);
    expect(handTypeOf(toCents('9.99'))).toBe(HandType.BAOZI);
  });
  it('满牛：1.00 / 5.00 / 88.00', () => {
    expect(handTypeOf(toCents('1.00'))).toBe(HandType.MANNIU);
    expect(handTypeOf(toCents('5.00'))).toBe(HandType.MANNIU);
    expect(handTypeOf(toCents('88.00'))).toBe(HandType.MANNIU);
  });
  it('反顺：9.87 / 3.21 / 2.10', () => {
    expect(handTypeOf(toCents('9.87'))).toBe(HandType.FANSHUN);
    expect(handTypeOf(toCents('3.21'))).toBe(HandType.FANSHUN);
    expect(handTypeOf(toCents('2.10'))).toBe(HandType.FANSHUN);
  });
  it('顺子：0.12 / 1.23 / 7.89', () => {
    expect(handTypeOf(toCents('0.12'))).toBe(HandType.SHUNZI);
    expect(handTypeOf(toCents('1.23'))).toBe(HandType.SHUNZI);
    expect(handTypeOf(toCents('7.89'))).toBe(HandType.SHUNZI);
  });
  it('对子：1.22 / 7.55', () => {
    expect(handTypeOf(toCents('1.22'))).toBe(HandType.DUIZI);
    expect(handTypeOf(toCents('7.55'))).toBe(HandType.DUIZI);
  });
  it('金牛：0.10 / 0.50', () => {
    expect(handTypeOf(toCents('0.10'))).toBe(HandType.JINNIU);
    expect(handTypeOf(toCents('0.50'))).toBe(HandType.JINNIU);
  });
  it('普通：2.80 / 3.42', () => {
    expect(handTypeOf(toCents('2.80'))).toBe(HandType.NORMAL);
    expect(handTypeOf(toCents('3.42'))).toBe(HandType.NORMAL);
  });
  it('关键三位数字提取', () => {
    expect(keyDigits(toCents('27.23'))).toEqual([7, 2, 3]); // a=整数位个位
    expect(keyDigits(toCents('0.56'))).toEqual([0, 5, 6]);
  });
});

describe('比牌（06 文档 §2）', () => {
  it('等级不同高者胜：豹子 > 满牛', () => {
    const banker = evaluateHand(toCents('5.00'));
    const player = evaluateHand(toCents('1.11'));
    expect(compareHands(banker, player)).toBe(CompareResult.PLAYER_WIN);
  });
  it('同级（同点）比金额：2.80 赢 1.09（均 10 点普通）', () => {
    const banker = evaluateHand(toCents('1.09'));
    const player = evaluateHand(toCents('2.80'));
    expect(compareHands(banker, player)).toBe(CompareResult.PLAYER_WIN);
  });
  it('金额完全相同 → 平局', () => {
    const a = evaluateHand(toCents('2.80'));
    const b = evaluateHand(toCents('2.80'));
    expect(compareHands(a, b)).toBe(CompareResult.TIE);
  });
});

describe('自爆（06 文档 §2.1）', () => {
  it('普通牌型点数 ≤3 自爆：1.20 → 3点自爆', () => {
    const h = evaluateHand(toCents('1.20'));
    expect(h.type).toBe(HandType.NORMAL);
    expect(h.points).toBe(3);
    expect(isBust(h)).toBe(true);
  });
  it('1.10 → 1+1+0=2 点，普通，自爆', () => {
    // 1.10: digits a=1,b=1,c=0 → 无牌型规则匹配 → 普通，2 点
    const h = evaluateHand(toCents('1.10'));
    expect(h.type).toBe(HandType.NORMAL);
    expect(h.points).toBe(2);
    expect(isBust(h)).toBe(true);
  });
  it('4 点普通牌型不自爆：1.30', () => {
    const h = evaluateHand(toCents('1.30'));
    expect(h.type).toBe(HandType.NORMAL);
    expect(h.points).toBe(4);
    expect(isBust(h)).toBe(false);
  });
  it('边界：0.03 属金牛（仅一位非零），默认豁免自爆', () => {
    const h = evaluateHand(toCents('0.03'));
    expect(h.type).toBe(HandType.JINNIU);
    expect(isBust(h)).toBe(false);
  });
  it('特殊牌型豁免：金牛 0.10（1点）不自爆', () => {
    const h = evaluateHand(toCents('0.10'));
    expect(h.type).toBe(HandType.JINNIU);
    expect(h.points).toBe(1);
    expect(isBust(h)).toBe(false);
  });
  it('豁免关闭时金牛 0.10 判自爆', () => {
    const h = evaluateHand(toCents('0.10'));
    expect(isBust(h, { ...DEFAULT_HAND_CONFIG, bustExemptSpecialHands: false })).toBe(true);
  });
});
