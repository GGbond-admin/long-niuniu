import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);

vi.mock('../config.js', () => ({ env: { nodeEnv: 'test' } }));
vi.mock('../lib/redis.js', () => {
  const subscriber = {
    status: 'wait',
    connect: vi.fn(async () => {
      calls.push('connect');
    }),
    subscribe: vi.fn(async () => {
      calls.push('subscribe');
      return 1;
    }),
    on: vi.fn(),
    disconnect: vi.fn(),
  };
  const command = {
    duplicate: vi.fn(() => subscriber),
    publish: vi.fn(async () => 1),
  };
  return {
    redis: () => command,
    withRedisLock: vi.fn(async (_key: string, _ttl: number, work: () => Promise<unknown>) =>
      work(),
    ),
  };
});
vi.mock('../lib/prisma.js', () => ({ prisma: {} }));
vi.mock('./gameBus.js', () => ({ gameBus: { on: vi.fn() } }));
vi.mock('./gameSettings.js', () => ({
  isAssistantEnabledSync: () => true,
  isAssistantEnabledFresh: async () => true,
}));
vi.mock('./roomAnnounce.js', () => ({ buildRoundAnnounceMessages: vi.fn() }));

import { initRoomHub } from './roomHub.js';

describe('多实例房间事件订阅', () => {
  it('lazy Redis 连接先 connect 再 subscribe', async () => {
    initRoomHub();
    await vi.waitFor(() => expect(calls).toEqual(['connect', 'subscribe']));
  });
});
