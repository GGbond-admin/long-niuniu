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
  maxPayoutMultiplier,
  multiplierOf,
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
  it('27.23 → 三位 7+2+3=12 → 2点', () => {
    expect(pointsOf(toCents('27.23'))).toBe(2);
  });
  it('三位和刚好 10 → 10点', () => {
    expect(pointsOf(toCents('1.09'))).toBe(10); // 1+0+9=10
  });
  it('三位和为 20 → 0点', () => {
    expect(pointsOf(toCents('9.83'))).toBe(0); // 9+8+3=20
  });
  it('1.28 → 1+2+8=11 → 1点', () => {
    expect(pointsOf(toCents('1.28'))).toBe(1);
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
  it('反顺（倒顺）：连续递减 9.87 / 3.21 / 2.10', () => {
    expect(handTypeOf(toCents('9.87'))).toBe(HandType.FANSHUN);
    expect(handTypeOf(toCents('3.21'))).toBe(HandType.FANSHUN);
    expect(handTypeOf(toCents('2.10'))).toBe(HandType.FANSHUN);
  });
  it('反顺：0.98 按规则列为倒顺，且小于 2.10', () => {
    expect(handTypeOf(toCents('0.98'))).toBe(HandType.FANSHUN);
    expect(compareHands(evaluateHand(toCents('2.10')), evaluateHand(toCents('0.98')))).toBe(
      CompareResult.BANKER_WIN,
    );
  });
  it('反顺：仅递减但不连续不算，如 9.51 / 3.10', () => {
    expect(handTypeOf(toCents('9.51'))).toBe(HandType.NORMAL);
    expect(handTypeOf(toCents('3.10'))).toBe(HandType.NORMAL);
  });
  it('顺子：连续递增 0.12 / 1.23 / 7.89（0 可作起点）', () => {
    expect(handTypeOf(toCents('0.12'))).toBe(HandType.SHUNZI);
    expect(handTypeOf(toCents('1.23'))).toBe(HandType.SHUNZI);
    expect(handTypeOf(toCents('7.89'))).toBe(HandType.SHUNZI);
  });
  it('顺子：仅递增但不连续不算，如 0.13 / 1.28 / 5.68', () => {
    expect(handTypeOf(toCents('0.13'))).toBe(HandType.NORMAL);
    expect(handTypeOf(toCents('1.28'))).toBe(HandType.NORMAL);
    expect(handTypeOf(toCents('5.68'))).toBe(HandType.NORMAL);
  });
  it('对子：1.22 / 7.55', () => {
    expect(handTypeOf(toCents('1.22'))).toBe(HandType.DUIZI);
    expect(handTypeOf(toCents('7.55'))).toBe(HandType.DUIZI);
  });
  it('金牛：仅 0.X0（X=1–9）', () => {
    expect(handTypeOf(toCents('0.10'))).toBe(HandType.JINNIU);
    expect(handTypeOf(toCents('0.50'))).toBe(HandType.JINNIU);
    expect(handTypeOf(toCents('0.90'))).toBe(HandType.JINNIU);
  });
  it('金牛：0.0X 不再算金牛', () => {
    expect(handTypeOf(toCents('0.05'))).toBe(HandType.NORMAL);
    expect(handTypeOf(toCents('0.02'))).toBe(HandType.NORMAL);
  });
  it('牛牛：三位相加刚好等于 10', () => {
    expect(handTypeOf(toCents('2.35'))).toBe(HandType.NIUNIU);
    expect(handTypeOf(toCents('4.15'))).toBe(HandType.NIUNIU);
    expect(handTypeOf(toCents('5.50'))).toBe(HandType.NIUNIU);
    expect(handTypeOf(toCents('2.80'))).toBe(HandType.NIUNIU);
    expect(handTypeOf(toCents('0.19'))).toBe(HandType.NIUNIU);
    expect(handTypeOf(toCents('5.32'))).toBe(HandType.NIUNIU);
  });
  it('牛牛兜底于其他特别牌型：0.55 判对子、1.36 判牛牛', () => {
    expect(handTypeOf(toCents('0.55'))).toBe(HandType.DUIZI); // 和为 10 但对子优先
    expect(handTypeOf(toCents('1.36'))).toBe(HandType.NIUNIU); // 递增但不连续 → 牛牛
  });
  it('相加为 20 不是牛牛，按普通 0 点', () => {
    const hand = evaluateHand(toCents('9.83'));
    expect(hand.type).toBe(HandType.NORMAL);
    expect(hand.points).toBe(0);
  });
  it('免死：0.01 固定判免死', () => {
    expect(handTypeOf(toCents('0.01'))).toBe(HandType.MIANSI);
  });
  it('普通：3.42 / 9.83', () => {
    expect(handTypeOf(toCents('3.42'))).toBe(HandType.NORMAL);
    expect(handTypeOf(toCents('9.83'))).toBe(HandType.NORMAL);
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
  it('豹子对豹子比金额：9.99 赢 1.11', () => {
    const banker = evaluateHand(toCents('1.11'));
    const player = evaluateHand(toCents('9.99'));
    expect(compareHands(banker, player)).toBe(CompareResult.PLAYER_WIN);
  });
  it('满牛对满牛比金额：88.00 赢 5.00', () => {
    const banker = evaluateHand(toCents('5.00'));
    const player = evaluateHand(toCents('88.00'));
    expect(compareHands(banker, player)).toBe(CompareResult.PLAYER_WIN);
  });
  it('顺子对顺子比金额：7.89 赢 0.12', () => {
    const banker = evaluateHand(toCents('0.12'));
    const player = evaluateHand(toCents('7.89'));
    expect(compareHands(banker, player)).toBe(CompareResult.PLAYER_WIN);
  });
  it('倒顺对倒顺比金额：9.87 赢 2.10', () => {
    const banker = evaluateHand(toCents('2.10'));
    const player = evaluateHand(toCents('9.87'));
    expect(compareHands(banker, player)).toBe(CompareResult.PLAYER_WIN);
  });
  it('对子对对子只比后两位：1.99 赢 9.11', () => {
    const banker = evaluateHand(toCents('9.11'));
    const player = evaluateHand(toCents('1.99'));
    expect(banker.type).toBe(HandType.DUIZI);
    expect(player.type).toBe(HandType.DUIZI);
    expect(compareHands(banker, player)).toBe(CompareResult.PLAYER_WIN);
  });
  it('对子后两位相同再比前位：9.22 赢 1.22', () => {
    const banker = evaluateHand(toCents('1.22'));
    const player = evaluateHand(toCents('9.22'));
    expect(compareHands(banker, player)).toBe(CompareResult.PLAYER_WIN);
  });
  it('对子完全相同 → 庄赢：庄 1.22 对闲 1.22', () => {
    expect(compareHands(evaluateHand(toCents('1.22')), evaluateHand(toCents('1.22')))).toBe(
      CompareResult.BANKER_WIN,
    );
  });
  it('对子先比后两位：8.99 赢 9.88', () => {
    expect(compareHands(evaluateHand(toCents('9.88')), evaluateHand(toCents('8.99')))).toBe(
      CompareResult.PLAYER_WIN,
    );
  });
  it('对子完整排序：后两位 99>88>…>11，同后两位再比前位', () => {
    const ordered = [
      '8.99', '0.99', '9.88', '0.88', '9.77', '0.55', '9.22', '1.22', '9.11', '0.11',
    ];
    for (let i = 0; i < ordered.length - 1; i += 1) {
      expect(compareHands(evaluateHand(toCents(ordered[i])), evaluateHand(toCents(ordered[i + 1])))).toBe(
        CompareResult.BANKER_WIN,
      );
    }
  });
  it('金牛对金牛只比中间位：0.90 赢 10.80', () => {
    const banker = evaluateHand(toCents('10.80'));
    const player = evaluateHand(toCents('0.90'));
    expect(banker.type).toBe(HandType.JINNIU);
    expect(player.type).toBe(HandType.JINNIU);
    expect(compareHands(banker, player)).toBe(CompareResult.PLAYER_WIN);
  });
  it('金牛中间位相同再比整笔金额：10.50 赢 0.50', () => {
    const banker = evaluateHand(toCents('0.50'));
    const player = evaluateHand(toCents('10.50'));
    expect(compareHands(banker, player)).toBe(CompareResult.PLAYER_WIN);
  });
  it('普通先比点数：0.09（9点）赢 1.30（4点），即使金额更小', () => {
    const banker = evaluateHand(toCents('1.30'));
    const player = evaluateHand(toCents('0.09'));
    expect(banker.type).toBe(HandType.NORMAL);
    expect(player.type).toBe(HandType.NORMAL);
    expect(compareHands(banker, player)).toBe(CompareResult.PLAYER_WIN);
  });
  it('普通同点再比金额：3.42 赢 1.26（同为 9 点）', () => {
    const banker = evaluateHand(toCents('1.26'));
    const player = evaluateHand(toCents('3.42'));
    expect(banker.points).toBe(9);
    expect(player.points).toBe(9);
    expect(compareHands(banker, player)).toBe(CompareResult.PLAYER_WIN);
  });
  it('同级比金额：2.80 赢 1.09（均为牛牛）', () => {
    const banker = evaluateHand(toCents('1.09'));
    const player = evaluateHand(toCents('2.80'));
    expect(compareHands(banker, player)).toBe(CompareResult.PLAYER_WIN);
  });
  it('牛牛等级低于金牛：0.10 赢 2.80', () => {
    const banker = evaluateHand(toCents('0.10'));
    const player = evaluateHand(toCents('2.80'));
    expect(compareHands(banker, player)).toBe(CompareResult.BANKER_WIN);
  });
  it('牛牛等级高于普通：2.80 赢 9.83（普通 0 点）', () => {
    const banker = evaluateHand(toCents('9.83'));
    const player = evaluateHand(toCents('2.80'));
    expect(compareHands(banker, player)).toBe(CompareResult.PLAYER_WIN);
  });
  it('普通 9 点大于 0 点：3.42 赢 9.83', () => {
    expect(compareHands(evaluateHand(toCents('9.83')), evaluateHand(toCents('3.42')))).toBe(
      CompareResult.PLAYER_WIN,
    );
  });
  it('金额完全相同 → 庄赢', () => {
    const banker = evaluateHand(toCents('2.80'));
    const player = evaluateHand(toCents('2.80'));
    expect(compareHands(banker, player)).toBe(CompareResult.BANKER_WIN);
  });
});

describe('牌型倍数', () => {
  it('牛牛默认 10 倍', () => {
    expect(multiplierOf(evaluateHand(toCents('2.35')))).toBe(10);
  });
  it('普通 0 点走点数倍数表（默认 1 倍）', () => {
    expect(multiplierOf(evaluateHand(toCents('9.83')))).toBe(1);
  });
});

describe('最大赔付倍数', () => {
  it('默认配置最高为豹子 17 倍，免死占位倍数不参与', () => {
    expect(maxPayoutMultiplier()).toBe(17);
  });

  it('使用本局配置中的真实最高倍数，不硬编码 17', () => {
    expect(
      maxPayoutMultiplier({
        ...DEFAULT_HAND_CONFIG,
        normalMultipliers: {
          ...DEFAULT_HAND_CONFIG.normalMultipliers,
          10: 20,
        },
      }),
    ).toBe(20);
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
  it('普通 0 点视为自爆', () => {
    const h = evaluateHand(toCents('9.83'));
    expect(h.type).toBe(HandType.NORMAL);
    expect(h.points).toBe(0);
    expect(isBust(h)).toBe(true);
  });
  it('4 点普通牌型不自爆：1.30', () => {
    const h = evaluateHand(toCents('1.30'));
    expect(h.type).toBe(HandType.NORMAL);
    expect(h.points).toBe(4);
    expect(isBust(h)).toBe(false);
  });
  it('边界：0.03 不再是金牛，按普通 3 点自爆', () => {
    const h = evaluateHand(toCents('0.03'));
    expect(h.type).toBe(HandType.NORMAL);
    expect(isBust(h)).toBe(true);
  });
  it('特殊牌型永不自爆：金牛 0.10（1点）不自爆', () => {
    const h = evaluateHand(toCents('0.10'));
    expect(h.type).toBe(HandType.JINNIU);
    expect(h.points).toBe(1);
    expect(isBust(h)).toBe(false);
  });
  it('特殊牌型永不自爆：满牛 1.00（1点）不自爆，即使自爆线拉满', () => {
    const h = evaluateHand(toCents('1.00'));
    expect(h.type).toBe(HandType.MANNIU);
    expect(h.points).toBe(1);
    expect(isBust(h)).toBe(false);
    expect(isBust(h, { ...DEFAULT_HAND_CONFIG, bustThreshold: 10 })).toBe(false);
  });
  it('免死 0.01 永不自爆', () => {
    const h = evaluateHand(toCents('0.01'));
    expect(h.type).toBe(HandType.MIANSI);
    expect(isBust(h)).toBe(false);
    expect(isBust(h, { ...DEFAULT_HAND_CONFIG, bustThreshold: 10 })).toBe(false);
  });
  it('关闭自爆后普通低点也不再判自爆', () => {
    const h = evaluateHand(toCents('1.20'));
    expect(h.type).toBe(HandType.NORMAL);
    expect(h.points).toBe(3);
    expect(isBust(h, { ...DEFAULT_HAND_CONFIG, bustEnabled: false })).toBe(false);
  });
});
