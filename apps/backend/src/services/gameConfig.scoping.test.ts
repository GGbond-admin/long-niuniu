import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({
  rows: new Map<string, { gameCode: string; key: string; value: unknown }>(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    gameConfig: {
      findUnique: vi.fn(async ({ where }: any) => {
        const scope = where.gameCode_key;
        return memory.rows.get(`${scope.gameCode}:${scope.key}`) ?? null;
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const scope = where.gameCode_key;
        const mapKey = `${scope.gameCode}:${scope.key}`;
        const current = memory.rows.get(mapKey);
        const row = current ? { ...current, ...update } : { ...create };
        memory.rows.set(mapKey, row);
        return row;
      }),
    },
  },
}));

import { getGameConfig, setGameConfig } from './gameConfig.js';

describe('游戏配置命名空间', () => {
  beforeEach(() => {
    memory.rows.clear();
  });

  it('相同 key 在不同 gameCode 下互不覆盖', async () => {
    await setGameConfig('GAME_A', 'round', { bidDurationSeconds: 30 });
    await setGameConfig('GAME_B', 'round', { bidDurationSeconds: 90 });

    await expect(
      getGameConfig('GAME_A', 'round', { bidDurationSeconds: 10 }),
    ).resolves.toEqual({ bidDurationSeconds: 30 });
    await expect(
      getGameConfig('GAME_B', 'round', { bidDurationSeconds: 10 }),
    ).resolves.toEqual({ bidDurationSeconds: 90 });
    expect(memory.rows.size).toBe(2);
  });
});
