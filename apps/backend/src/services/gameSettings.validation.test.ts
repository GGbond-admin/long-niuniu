import { describe, expect, it } from 'vitest';
import { validateGameConfig } from './gameSettings.js';

describe('游戏配置跨字段校验', () => {
  it('拒绝最低竞标额高于最高竞标额', () => {
    expect(() =>
      validateGameConfig('round', {
        bankerBidMinCents: 20_000,
        bankerBidMaxCents: 10_000,
      }),
    ).toThrow();
  });

  it('单字段更新也会与默认完整配置交叉校验', () => {
    expect(() =>
      validateGameConfig('betting', {
        betMinCents: 5_000,
      }),
    ).toThrow();
    expect(() =>
      validateGameConfig('round', {
        bankerBidMinCents: 200_000_000,
      }),
    ).toThrow();
  });

  it('拒绝人数分档乱序或在覆盖房间上限后继续追加', () => {
    expect(() =>
      validateGameConfig('betting', {
        playerCoefTiers: [
          { maxPlayers: 20, coef: 1.5 },
          { maxPlayers: 9, coef: 2 },
        ],
      }),
    ).toThrow();
    expect(() =>
      validateGameConfig('betting', {
        playerCoefTiers: [
          { maxPlayers: 100, coef: 1.5 },
          { maxPlayers: 9999, coef: 1 },
        ],
      }),
    ).toThrow();
  });

  it('接受严格递增且覆盖最大房间人数的分档', () => {
    expect(
      validateGameConfig('betting', {
        playerCoefTiers: [
          { maxPlayers: 9, coef: 2 },
          { maxPlayers: 20, coef: 1.5 },
          { maxPlayers: 100, coef: 1 },
        ],
      }),
    ).toBeTruthy();
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
});
