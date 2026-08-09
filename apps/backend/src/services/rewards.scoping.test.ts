import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  progressFindUnique: vi.fn(async ({ where }: any) => {
    const scope = where.gameCode_userId_date;
    return {
      gameCode: scope.gameCode,
      userId: scope.userId,
      date: scope.date,
      counts:
        scope.gameCode === 'GAME_A'
          ? { BAOZI: 2 }
          : { BANKER_ROUNDS: 5 },
    };
  }),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    rewardConfig: {
      findMany: vi.fn(async ({ where }: any) => [
        {
          id: `reward-${where.gameCode}`,
          gameCode: where.gameCode,
          tab: where.gameCode === 'GAME_A' ? 'CHESS' : 'BANKER',
          code: 'scope_test',
          title: '隔离测试',
          conditions:
            where.gameCode === 'GAME_A'
              ? { kind: 'hand_count', handType: 'BAOZI', count: 2 }
              : { kind: 'banker_rounds', count: 5 },
          amountCents: 100n,
          dailyQuota: 0,
          status: 'ACTIVE',
        },
      ]),
    },
    dailyHandProgress: {
      findUnique: mocks.progressFindUnique,
    },
    rewardGrant: {
      findMany: vi.fn(async () => []),
      groupBy: vi.fn(async () => []),
    },
  },
}));

vi.mock('./gameBus.js', () => ({ gameBus: { rewardGranted: vi.fn() } }));
vi.mock('./push.js', () => ({
  pushService: { notifyRewardGranted: vi.fn() },
}));
vi.mock('./wallet.js', () => ({ transfer: vi.fn() }));

import { rewardDashboard } from './rewards.js';

describe('每日奖励游戏隔离', () => {
  it('同一用户同一天按 gameCode 读取独立进度', async () => {
    const [gameA, gameB] = await Promise.all([
      rewardDashboard('GAME_A', 'user-1', '2026-08-07'),
      rewardDashboard('GAME_B', 'user-1', '2026-08-07'),
    ]);

    expect(gameA.counts).toEqual({ BAOZI: 2 });
    expect(gameB.counts).toEqual({ BANKER_ROUNDS: 5 });
    expect(gameA.items[0]).toMatchObject({
      id: 'reward-GAME_A',
      achieved: true,
    });
    expect(gameB.items[0]).toMatchObject({
      id: 'reward-GAME_B',
      achieved: true,
    });
    expect(mocks.progressFindUnique).toHaveBeenCalledWith({
      where: {
        gameCode_userId_date: {
          gameCode: 'GAME_A',
          userId: 'user-1',
          date: '2026-08-07',
        },
      },
    });
  });
});
