import { describe, expect, it } from 'vitest';
import {
  CompareResult,
  HAND_RANK,
  HandType,
  compareHandStrength,
  compareHands,
  evaluateHand,
  handTypeOf,
  pointsOf,
} from './hand.js';
import { toCents } from './betting.js';

/** 《至尊牛牛_完整排序_对子与普通点数完全分开》特别牌型表 */
const SPECIAL_ORDER: Array<{ type: HandType; amounts: string[] }> = [
  { type: HandType.BAOZI, amounts: ['9.99', '8.88', '7.77', '6.66', '5.55', '4.44', '3.33', '2.22', '1.11'] },
  { type: HandType.MANNIU, amounts: ['9.00', '8.00', '7.00', '6.00', '5.00', '4.00', '3.00', '2.00', '1.00'] },
  { type: HandType.SHUNZI, amounts: ['7.89', '6.78', '5.67', '4.56', '3.45', '2.34', '1.23', '0.12'] },
  { type: HandType.FANSHUN, amounts: ['9.87', '8.76', '7.65', '6.54', '5.43', '4.32', '3.21', '2.10', '0.98'] },
  { type: HandType.DUIZI, amounts: [] },
  { type: HandType.JINNIU, amounts: ['0.90', '0.80', '0.70', '0.60', '0.50', '0.40', '0.30', '0.20', '0.10'] },
];

/** 对子排序表：后两位 99>…>11，同后两位再比前位；豹子金额已排除 */
const PAIR_ORDER = [
  '8.99', '7.99', '6.99', '5.99', '4.99', '3.99', '2.99', '1.99', '0.99',
  '9.88', '7.88', '6.88', '5.88', '4.88', '3.88', '2.88', '1.88', '0.88',
  '9.77', '8.77', '6.77', '5.77', '4.77', '3.77', '2.77', '1.77', '0.77',
  '9.66', '8.66', '7.66', '5.66', '4.66', '3.66', '2.66', '1.66', '0.66',
  '9.55', '8.55', '7.55', '6.55', '4.55', '3.55', '2.55', '1.55', '0.55',
  '9.44', '8.44', '7.44', '6.44', '5.44', '3.44', '2.44', '1.44', '0.44',
  '9.33', '8.33', '7.33', '6.33', '5.33', '4.33', '2.33', '1.33', '0.33',
  '9.22', '8.22', '7.22', '6.22', '5.22', '4.22', '3.22', '1.22', '0.22',
  '9.11', '8.11', '7.11', '6.11', '5.11', '4.11', '3.11', '2.11', '0.11',
];

describe('完整排序表对照', () => {
  it('特别牌型等级：豹子 > 满牛 > 顺子 > 倒顺 > 对子 > 金牛 > 牛牛 > 普通', () => {
    expect(HAND_RANK[HandType.BAOZI]).toBeGreaterThan(HAND_RANK[HandType.MANNIU]);
    expect(HAND_RANK[HandType.MANNIU]).toBeGreaterThan(HAND_RANK[HandType.SHUNZI]);
    expect(HAND_RANK[HandType.SHUNZI]).toBeGreaterThan(HAND_RANK[HandType.FANSHUN]);
    expect(HAND_RANK[HandType.FANSHUN]).toBeGreaterThan(HAND_RANK[HandType.DUIZI]);
    expect(HAND_RANK[HandType.DUIZI]).toBeGreaterThan(HAND_RANK[HandType.JINNIU]);
    expect(HAND_RANK[HandType.JINNIU]).toBeGreaterThan(HAND_RANK[HandType.NIUNIU]);
    expect(HAND_RANK[HandType.NIUNIU]).toBeGreaterThan(HAND_RANK[HandType.NORMAL]);
  });

  it('特别牌型内部按表中金额比较，且最小的高等级仍赢最大的低等级', () => {
    const weakestOf: Partial<Record<HandType, number>> = {};
    const strongestOf: Partial<Record<HandType, number>> = {};
    for (const { type, amounts } of SPECIAL_ORDER) {
      const list = type === HandType.DUIZI ? PAIR_ORDER : amounts;
      for (let i = 0; i < list.length; i += 1) {
        const hand = evaluateHand(toCents(list[i]!));
        expect(hand.type).toBe(type);
        if (i < list.length - 1) {
          expect(compareHands(evaluateHand(toCents(list[i]!)), evaluateHand(toCents(list[i + 1]!)))).toBe(
            CompareResult.BANKER_WIN,
          );
        }
      }
      weakestOf[type] = toCents(list[list.length - 1]!);
      strongestOf[type] = toCents(list[0]!);
    }

    const chain: HandType[] = [
      HandType.BAOZI,
      HandType.MANNIU,
      HandType.SHUNZI,
      HandType.FANSHUN,
      HandType.DUIZI,
      HandType.JINNIU,
    ];
    for (let i = 0; i < chain.length - 1; i += 1) {
      const higherWeak = evaluateHand(weakestOf[chain[i]!]!);
      const lowerStrong = evaluateHand(strongestOf[chain[i + 1]!]!);
      expect(compareHandStrength(higherWeak, lowerStrong)).toBeGreaterThan(0);
    }

    expect(compareHands(evaluateHand(toCents('0.10')), evaluateHand(toCents('9.10')))).toBe(
      CompareResult.BANKER_WIN,
    );
    expect(compareHands(evaluateHand(toCents('0.19')), evaluateHand(toCents('9.91')))).toBe(
      CompareResult.BANKER_WIN,
    );
  });

  it('对子 81 个金额与排序表完全一致，且不混入普通点数', () => {
    expect(PAIR_ORDER).toHaveLength(81);
    for (const amount of PAIR_ORDER) {
      const hand = evaluateHand(toCents(amount));
      expect(hand.type).toBe(HandType.DUIZI);
    }
    for (let i = 0; i < PAIR_ORDER.length - 1; i += 1) {
      expect(
        compareHands(evaluateHand(toCents(PAIR_ORDER[i]!)), evaluateHand(toCents(PAIR_ORDER[i + 1]!))),
      ).toBe(CompareResult.BANKER_WIN);
    }
  });

  it('普通点数：1.28 为 1 点；牛牛/10点 > 9点 > … > 0点，同点比金额', () => {
    expect(handTypeOf(toCents('1.28'))).toBe(HandType.NORMAL);
    expect(pointsOf(toCents('1.28'))).toBe(1);
    expect(pointsOf(toCents('9.83'))).toBe(0);
    expect(handTypeOf(toCents('9.10'))).toBe(HandType.NIUNIU);
    expect(compareHands(evaluateHand(toCents('9.10')), evaluateHand(toCents('0.19')))).toBe(
      CompareResult.BANKER_WIN,
    );
    expect(compareHands(evaluateHand(toCents('9.91')), evaluateHand(toCents('0.09')))).toBe(
      CompareResult.BANKER_WIN,
    );
    expect(compareHands(evaluateHand(toCents('3.42')), evaluateHand(toCents('1.26')))).toBe(
      CompareResult.BANKER_WIN,
    );
  });

  it('0.01 免死单独处理；0.98 列为倒顺', () => {
    expect(handTypeOf(toCents('0.01'))).toBe(HandType.MIANSI);
    expect(handTypeOf(toCents('0.98'))).toBe(HandType.FANSHUN);
    expect(compareHands(evaluateHand(toCents('9.87')), evaluateHand(toCents('0.98')))).toBe(
      CompareResult.BANKER_WIN,
    );
  });
});
