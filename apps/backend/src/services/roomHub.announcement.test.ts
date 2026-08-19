import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({
  events: [] as Array<{ id: string; roundId: string; type: string }>,
  scoreboardUpdates: [] as Array<Record<string, unknown>>,
  scoreboardUpdateWheres: [] as Array<Record<string, unknown>>,
  lockKeys: [] as string[],
  redisRows: new Map<string, string[]>(),
  scoreboardRevision: 0,
  scoreboardMessageIds: [] as string[],
  scoreboardStatus: 'LEGACY',
  forceRevisionRace: false,
  raceToFailed: false,
  shrinkAfterRace: false,
}));

vi.mock('../lib/redis.js', () => ({
  withRedisLock: vi.fn(async (key: string, _ttl: number, work: () => Promise<unknown>) => {
    memory.lockKeys.push(key);
    return work();
  }),
  redis: () => ({
    lrange: vi.fn(async (key: string) => memory.redisRows.get(key) ?? []),
    rpush: vi.fn(async (key: string, ...rows: string[]) => {
      const stored = memory.redisRows.get(key) ?? [];
      stored.push(...rows);
      memory.redisRows.set(key, stored);
      return stored.length;
    }),
    ltrim: vi.fn(async () => 'OK'),
    expire: vi.fn(async () => 1),
  }),
}));

vi.mock('../lib/prisma.js', () => {
  const prisma: any = {
    roundEvent: {
      findFirst: vi.fn(async ({ where }: { where: { roundId: string; type: string } }) =>
        memory.events.find(
          (event) => event.roundId === where.roundId && event.type === where.type,
        ) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: { roundId: string; type: string } }) => {
        const row = { id: `event-${memory.events.length + 1}`, ...data };
        memory.events.push(row);
        return row;
      }),
    },
    roundScoreboard: {
      findUnique: vi.fn(async () => ({
        presentationRevision: memory.scoreboardRevision,
        publishedChatMessageIds: [...memory.scoreboardMessageIds],
      })),
      updateMany: vi.fn(async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        memory.scoreboardUpdateWheres.push(where);
        memory.scoreboardUpdates.push(data);
        if (
          memory.forceRevisionRace
          && where.presentationRevision === memory.scoreboardRevision
        ) {
          memory.forceRevisionRace = false;
          memory.scoreboardRevision += 1;
          memory.scoreboardStatus = memory.raceToFailed ? 'FAILED' : 'PENDING';
          return { count: 0 };
        }
        if (
          typeof where.presentationRevision === 'number'
          && where.presentationRevision !== memory.scoreboardRevision
        ) {
          return { count: 0 };
        }
        const statusFilter = where.presentationSyncStatus as
          | string
          | { in?: string[] }
          | undefined;
        if (
          typeof statusFilter === 'string'
            ? memory.scoreboardStatus !== statusFilter
            : statusFilter?.in && !statusFilter.in.includes(memory.scoreboardStatus)
        ) {
          return { count: 0 };
        }
        if (Array.isArray(data.publishedChatMessageIds)) {
          memory.scoreboardMessageIds = [...data.publishedChatMessageIds] as string[];
        }
        if (typeof data.presentationSyncStatus === 'string') {
          memory.scoreboardStatus = data.presentationSyncStatus;
        }
        return { count: 1 };
      }),
    },
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(prisma)),
  };
  return { prisma };
});

vi.mock('./scoreboardSyncLock.js', () => {
  class ScoreboardSyncLockLostError extends Error {}
  return {
    ScoreboardSyncLockLostError,
    withScoreboardSyncLock: vi.fn(
      async (
        roundId: string,
        work: (lease: {
          fence: null;
          assertHeld: () => Promise<void>;
        }) => Promise<unknown>,
      ) => {
        memory.lockKeys.push(`niuniu:round:${roundId}:scoreboard-presentation`);
        return work({ fence: null, assertHeld: async () => undefined });
      },
    ),
  };
});

vi.mock('./gameBus.js', () => ({
  gameBus: { on: vi.fn(), announcementCompleted: vi.fn() },
}));
vi.mock('./gameSettings.js', () => ({
  isAssistantEnabledSync: () => true,
  isAssistantEnabledFresh: async () => true,
}));
vi.mock('./roomAnnounce.js', () => ({
  buildRoundAnnounceMessages: vi.fn(async ({ to }: { to: string }) => {
    if (to === 'FINISHED') {
      const scoreboard = [
        {
          kind: 'text',
          content: '成绩单第一段',
          messageKey: 'scoreboard:0',
          scoreboardChunkIndex: 0,
        },
        ...(
          memory.shrinkAfterRace && memory.scoreboardRevision > 0
            ? []
            : [
                {
                  kind: 'text',
                  content: '成绩单第二段',
                  messageKey: 'scoreboard:1',
                  scoreboardChunkIndex: 1,
                },
              ]
        ),
      ];
      return [
          { kind: 'text', content: '结算完成', messageKey: 'finished:settling' },
          ...scoreboard,
      ];
    }
    return [
      { kind: 'text', content: '庄家锁定' },
      { kind: 'banner', banner: 'bet-start' },
      { kind: 'text', content: '开始下注' },
      {
        kind: 'countdown',
        mode: 'bet',
        endsAt: '2026-08-07T08:00:00.000Z',
        template: '还剩 {{remaining}} 秒',
      },
    ];
  }),
}));

import {
  chatHistory,
  ensureRoundAnnouncement,
  existingChatMessageIds,
} from './roomHub.js';

describe('阶段机器人播报幂等', () => {
  beforeEach(() => {
    memory.events.length = 0;
    memory.scoreboardUpdates.length = 0;
    memory.scoreboardUpdateWheres.length = 0;
    memory.lockKeys.length = 0;
    memory.scoreboardRevision = 0;
    memory.scoreboardMessageIds = [];
    memory.scoreboardStatus = 'LEGACY';
    memory.forceRevisionRace = false;
    memory.raceToFailed = false;
    memory.shrinkAfterRace = false;
  });

  it('并发 transition 只写入一组有序消息，并在全部完成后落标记', async () => {
    const params = { roundId: 'round-announcement-1', roomId: 'room-announcement-1', to: 'BETTING' };

    await Promise.all([
      ensureRoundAnnouncement(params),
      ensureRoundAnnouncement(params),
    ]);

    expect(
      chatHistory(params.roomId).map((message) =>
        message.type === 'BANNER' ? `${message.type}:${message.content}` : message.type,
      ),
    ).toEqual(['SYSTEM', 'BANNER:bet-start', 'SYSTEM', 'COUNTDOWN']);
    expect(memory.events.filter((event) => event.type === 'ROOM_ANNOUNCED_BETTING')).toHaveLength(1);
  });

  it('首次发布成绩单时使用稳定消息 ID 并记录映射', async () => {
    const params = {
      roundId: 'round-finished-1',
      roomId: 'room-finished-1',
      to: 'FINISHED',
    };

    await ensureRoundAnnouncement(params);

    expect(chatHistory(params.roomId).map((message) => message.id)).toEqual([
      'round:round-finished-1:finished:settling',
      'round:round-finished-1:scoreboard:0',
      'round:round-finished-1:scoreboard:1',
    ]);
    expect(memory.scoreboardUpdates.at(-1)).toMatchObject({
      publishedChatMessageIds: [
        'round:round-finished-1:scoreboard:0',
        'round:round-finished-1:scoreboard:1',
      ],
      presentationSyncStatus: 'SYNCED',
      presentationSyncError: null,
    });
    expect(memory.scoreboardUpdateWheres.at(-1)).toEqual({
      roundId: 'round-finished-1',
      presentationRevision: 0,
    });
    expect(memory.lockKeys).toContain(
      'niuniu:round:round-finished-1:scoreboard-presentation',
    );
  });

  it('超过 7 天的原消息不可再原位编辑', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
      const params = {
        roundId: 'round-expiring-1',
        roomId: 'room-expiring-1',
        to: 'FINISHED',
      };
      await ensureRoundAnnouncement(params);
      const messageId = 'round:round-expiring-1:scoreboard:0';

      await expect(existingChatMessageIds(params.roomId, [messageId])).resolves.toEqual([
        messageId,
      ]);
      vi.setSystemTime(new Date('2026-08-08T00:00:01.000Z'));
      await expect(existingChatMessageIds(params.roomId, [messageId])).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('发布过程中展示修订变化时在同一 lease 内重建最新版本后才记完成', async () => {
    const params = {
      roundId: 'round-finished-race',
      roomId: 'room-finished-race',
      to: 'FINISHED',
    };
    memory.forceRevisionRace = true;

    await ensureRoundAnnouncement(params);

    expect(
      memory.events.some((event) => event.type === 'ROOM_ANNOUNCED_FINISHED'),
    ).toBe(true);
    expect(memory.scoreboardUpdateWheres).toContainEqual({
      roundId: params.roundId,
      presentationRevision: { not: 0 },
      presentationSyncStatus: {
        in: ['PENDING', 'FAILED'],
      },
    });
    expect(memory.scoreboardUpdates.at(-1)).toMatchObject({
      publishedChatMessageIds: [
        'round:round-finished-race:scoreboard:0',
        'round:round-finished-race:scoreboard:1',
      ],
    });
  });

  it('新修订等待锁超时标记 FAILED 后仍接管真实分段映射并清理旧段', async () => {
    const params = {
      roundId: 'round-finished-failed-race',
      roomId: 'room-finished-failed-race',
      to: 'FINISHED',
    };
    memory.forceRevisionRace = true;
    memory.raceToFailed = true;
    memory.shrinkAfterRace = true;

    await ensureRoundAnnouncement(params);

    expect(memory.scoreboardStatus).toBe('SYNCED');
    expect(memory.scoreboardMessageIds).toEqual([
      'round:round-finished-failed-race:scoreboard:0',
    ]);
    expect(chatHistory(params.roomId).map((message) => message.id)).toEqual([
      'round:round-finished-failed-race:finished:settling',
      'round:round-finished-failed-race:scoreboard:0',
    ]);
    expect(memory.scoreboardUpdateWheres).toContainEqual({
      roundId: params.roundId,
      presentationRevision: { not: 0 },
      presentationSyncStatus: {
        in: ['PENDING', 'FAILED'],
      },
    });
  });
});
