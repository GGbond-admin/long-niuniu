import { describe, expect, it } from 'vitest';
import { DEFAULT_BETTING_CONFIG } from '../engine/betting.js';
import { DEFAULT_FEE_CONFIG } from '../engine/fees.js';
import { DEFAULT_HAND_CONFIG } from '../engine/hand.js';
import { DEFAULT_REBATE_CONFIG } from '../engine/rebate.js';
import { deepMerge } from './gameConfig.js';
import {
  DEFAULT_MESSAGE_TEMPLATES,
  DEFAULT_REWARD_RULES,
  DEFAULT_ROUND_CONFIG,
  validateGameConfig,
} from './gameSettings.js';

describe('游戏配置跨字段校验', () => {
  it('拒绝最低竞标额高于最高竞标额', () => {
    expect(() =>
      validateGameConfig('round', {
        bankerBidMinCents: 20_000,
        bankerBidMaxCents: 10_000,
      }),
    ).toThrow(/上庄起拍价不能高于最高出价/);
  });

  it('单字段更新也会与默认完整配置交叉校验', () => {
    expect(() =>
      validateGameConfig('betting', {
        betMinCents: 5_000,
      }),
    ).toThrow(/普通下注最低不能高于梭哈最低/);
    expect(() =>
      validateGameConfig('round', {
        bankerBidMinCents: 200_000_000,
      }),
    ).toThrow(/上庄起拍价不能高于最高出价/);
  });

  it('封盘重推确认窗口只允许 3 至 30 秒', () => {
    expect(() =>
      validateGameConfig('round', { repostWindowSeconds: 2 }),
    ).toThrow();
    expect(() =>
      validateGameConfig('round', { repostWindowSeconds: 31 }),
    ).toThrow();
    expect(
      validateGameConfig('round', { repostWindowSeconds: 5 }),
    ).toBeTruthy();
  });

  it('庄家投骰时限只允许 5 至 120 秒', () => {
    expect(() =>
      validateGameConfig('round', { bankerDiceTimeoutSeconds: 4 }),
    ).toThrow();
    expect(() =>
      validateGameConfig('round', { bankerDiceTimeoutSeconds: 121 }),
    ).toThrow();
    expect(
      validateGameConfig('round', { bankerDiceTimeoutSeconds: 15 }),
    ).toBeTruthy();
  });

  it('保存下注比例时丢弃旧人数系数，不因多余字段整单失败', () => {
    const saved = validateGameConfig('betting', {
      betMinCents: 300,
      shMinCents: 3000,
      betRatio: 0.005,
      shRatio: 0.05,
      playerCoefTiers: [{ minPlayers: 0, maxPlayers: 9, coef: 2 }],
    } as never) as {
      betRatio: number;
      shRatio: number;
      playerCoefTiers?: unknown;
    };

    expect(saved.betRatio).toBe(0.005);
    expect(saved.shRatio).toBe(0.05);
    expect(saved.playerCoefTiers).toBeUndefined();
  });

  it('模拟后台保存：旧库多余字段与新表单合并后仍能写入', () => {
    const cases = [
      ['betting', DEFAULT_BETTING_CONFIG, { betRatio: 0.005, shRatio: 0.05 }],
      ['fees', DEFAULT_FEE_CONFIG, { bankerSeatFeeRatio: 0.01, playerRakeRatio: 0.03 }],
      ['rebate', DEFAULT_REBATE_CONFIG, { selfRate: 0.007 }],
      ['round', DEFAULT_ROUND_CONFIG, { bidDurationSeconds: 30 }],
      ['rewards', DEFAULT_REWARD_RULES, { minBetCents: 500 }],
      ['hand', DEFAULT_HAND_CONFIG, { bustThreshold: 3 }],
      ['messages', DEFAULT_MESSAGE_TEMPLATES, { bidCountdown3: '3' }],
    ] as const;

    for (const [key, current, patch] of cases) {
      const saved = validateGameConfig(
        key,
        deepMerge({ ...current, legacyRemovedField: true }, patch),
      ) as Record<string, unknown>;
      expect(saved.legacyRemovedField, key).toBeUndefined();
    }
  });

  it('梭哈比例按小数写入，未换算的百分数 5 会被拒绝', () => {
    expect(() => validateGameConfig('betting', { shRatio: 5 })).toThrow();
    expect(
      (validateGameConfig('betting', { shRatio: 0.05 }) as { shRatio: number }).shRatio,
    ).toBe(0.05);
  });
});
