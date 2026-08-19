import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settlementFindMany: vi.fn(async ({ where }: any) => {
    const gameCode = where.round.room.gameCode;
    return gameCode === 'GAME_A'
      ? [
          {
            userId: 'player-a',
            betCents: 1_000n,
            round: { bankerId: 'banker-a' },
          },
        ]
      : [
          {
            userId: 'player-b',
            betCents: 2_000n,
            round: { bankerId: 'banker-b' },
          },
        ];
  }),
  leaderboardUpsert: vi.fn(async ({ create }: any) => ({
    id: `board-${create.gameCode}`,
    ...create,
    generatedAt: new Date('2026-08-07T00:00:00.000Z'),
  })),
  transfer: vi.fn(async () => undefined),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    settlement: { findMany: mocks.settlementFindMany },
    dailyHandProgress: { findMany: vi.fn(async () => []) },
    round: { findMany: vi.fn(async () => []) },
    user: {
      findMany: vi.fn(async ({ where }: any) => {
        if (where.kind === 'VIRTUAL') return [];
        return (where.id?.in ?? []).map((id: string) => ({
          id,
          uid: `uid-${id}`,
          nickname: id,
          avatarUrl: null,
        }));
      }),
    },
    leaderboard: {
      upsert: mocks.leaderboardUpsert,
      findUnique: vi.fn(async ({ where }: any) => ({
        gameCode: where.gameCode_type_period_periodKey.gameCode,
        rankSnapshot: [{ rank: 1, userId: 'winner-1' }],
      })),
    },
    ledgerEntry: { findUnique: vi.fn(async () => null) },
  },
}));

vi.mock('./gameConfig.js', () => ({
  getGameConfig: vi.fn(async (_gameCode: string, _key: string, defaults: unknown) => defaults),
}));
vi.mock('./gameSettings.js', () => ({
  getGameSettings: vi.fn(async () => ({
    rebate: { includeTieBets: false },
  })),
}));
vi.mock('./rebates.js', () => ({ malaysiaDay: () => '2026-08-07' }));
vi.mock('../lib/transaction.js', () => ({
  serializable: vi.fn(async (work: (tx: object) => Promise<unknown>) => work({})),
}));
vi.mock('./wallet.js', () => ({ transfer: mocks.transfer }));

import {
  distributeLeaderboardRewards,
  generateLeaderboard,
  leaderboardSnapshotHash,
} from './leaderboards.js';

describe('排行榜游戏隔离', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('积分榜只读取目标游戏房间内的已结算流水', async () => {
    const [gameA, gameB] = await Promise.all([
      generateLeaderboard('GAME_A', 'points', 'daily'),
      generateLeaderboard('GAME_B', 'points', 'daily'),
    ]);

    expect(mocks.settlementFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          round: expect.objectContaining({
            room: { gameCode: 'GAME_A' },
          }),
        }),
      }),
    );
    expect(gameA.rankSnapshot).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: 'player-a', score: '1000' }),
      ]),
    );
    expect(gameB.rankSnapshot).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: 'player-b', score: '2000' }),
      ]),
    );
    expect(mocks.leaderboardUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          gameCode_type_period_periodKey: {
            gameCode: 'GAME_A',
            type: 'points',
            period: 'daily',
            periodKey: '2026-08-07',
          },
        },
      }),
    );
  });

  it('相同榜型周期名次的发奖幂等键包含 gameCode', async () => {
    const gameAPreview = await generateLeaderboard('GAME_A', 'points', 'daily', '2026-08-06');
    const gameBPreview = await generateLeaderboard('GAME_B', 'points', 'daily', '2026-08-06');
    await distributeLeaderboardRewards({
      gameCode: 'GAME_A',
      type: 'points',
      period: 'daily',
      periodKey: '2026-08-06',
      expectedSnapshotHash: leaderboardSnapshotHash(gameAPreview.rankSnapshot),
      prizes: [{ rank: 1, amountCents: 888n }],
      operatorId: 'admin-1',
    });
    await distributeLeaderboardRewards({
      gameCode: 'GAME_B',
      type: 'points',
      period: 'daily',
      periodKey: '2026-08-06',
      expectedSnapshotHash: leaderboardSnapshotHash(gameBPreview.rankSnapshot),
      prizes: [{ rank: 1, amountCents: 888n }],
      operatorId: 'admin-1',
    });

    const idempotencyKeys = mocks.transfer.mock.calls.map(
      (call) => call[1].idempotencyKey,
    );
    expect(idempotencyKeys).toEqual([
      'lb-reward:GAME_A:points:daily:2026-08-06:rank1',
      'lb-reward:GAME_B:points:daily:2026-08-06:rank1',
    ]);
  });

  it('当前仍在变化的周期禁止发奖', async () => {
    await expect(
      distributeLeaderboardRewards({
        gameCode: 'GAME_A',
        type: 'points',
        period: 'daily',
        periodKey: '2026-08-07',
        expectedSnapshotHash: '0'.repeat(64),
        prizes: [{ rank: 1, amountCents: 888n }],
        operatorId: 'admin-1',
      }),
    ).rejects.toThrow('LEADERBOARD_PERIOD_NOT_CLOSED');
    expect(mocks.transfer).not.toHaveBeenCalled();
  });

  it('预览后榜单发生变化时拒绝按旧快照发奖', async () => {
    await expect(
      distributeLeaderboardRewards({
        gameCode: 'GAME_A',
        type: 'points',
        period: 'daily',
        periodKey: '2026-08-06',
        expectedSnapshotHash: '0'.repeat(64),
        prizes: [{ rank: 1, amountCents: 888n }],
        operatorId: 'admin-1',
      }),
    ).rejects.toThrow('LEADERBOARD_SNAPSHOT_CHANGED');
    expect(mocks.transfer).not.toHaveBeenCalled();
  });
});
