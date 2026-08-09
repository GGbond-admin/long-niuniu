import { describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({
  events: [] as Array<{ id: string; roundId: string; type: string }>,
}));

vi.mock('../lib/redis.js', () => ({
  withRedisLock: vi.fn(async (_key: string, _ttl: number, work: () => Promise<unknown>) =>
    work(),
  ),
  redis: () => ({
    lrange: vi.fn(async () => []),
    rpush: vi.fn(async () => 1),
    ltrim: vi.fn(async () => 'OK'),
    expire: vi.fn(async () => 1),
  }),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
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
  },
}));

vi.mock('./gameBus.js', () => ({ gameBus: { on: vi.fn() } }));
vi.mock('./gameSettings.js', () => ({
  isAssistantEnabledSync: () => true,
  isAssistantEnabledFresh: async () => true,
}));
vi.mock('./roomAnnounce.js', () => ({
  buildRoundAnnounceMessages: vi.fn(async () => [
    { kind: 'text', content: '庄家锁定' },
    { kind: 'banner', banner: 'bet-start' },
    { kind: 'text', content: '开始下注' },
    {
      kind: 'countdown',
      mode: 'bet',
      endsAt: '2026-08-07T08:00:00.000Z',
      template: '还剩 {{remaining}} 秒',
    },
  ]),
}));

import { chatHistory, ensureRoundAnnouncement } from './roomHub.js';

describe('阶段机器人播报幂等', () => {
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
});
