import { beforeEach, describe, expect, it, vi } from 'vitest';

const message = {
  id: 'scoreboard-strict-1',
  type: 'SYSTEM',
  content: '旧成绩单',
  from: null,
  at: new Date().toISOString(),
};
const publish = vi.hoisted(() => vi.fn(async () => 1));
const redisState = vi.hoisted(() => ({ evalResult: 0 }));
const redisEval = vi.hoisted(() =>
  vi.fn(async () => redisState.evalResult),
);

vi.mock('../config.js', () => ({ env: { nodeEnv: 'test' } }));
vi.mock('../lib/redis.js', () => ({
  redis: () => ({
    lrange: vi.fn(async () => [JSON.stringify(message)]),
    eval: redisEval,
    publish,
  }),
  withRedisLock: vi.fn(
    async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  ),
}));
vi.mock('../lib/prisma.js', () => ({ prisma: {} }));
vi.mock('./gameBus.js', () => ({ gameBus: { on: vi.fn() } }));
vi.mock('./gameSettings.js', () => ({
  isAssistantEnabledSync: () => true,
  isAssistantEnabledFresh: async () => true,
}));
vi.mock('./roomAnnounce.js', () => ({ buildRoundAnnounceMessages: vi.fn() }));

import { ScoreboardSyncLockLostError } from './scoreboardSyncLock.js';
import { chatHistory, updateChatStrict } from './roomHub.js';

describe('聊天消息严格原位更新', () => {
  beforeEach(() => {
    redisState.evalResult = 0;
    publish.mockClear();
    redisEval.mockClear();
  });

  it('Redis 中目标已消失时返回 null 且不在内存复活消息', async () => {
    await expect(
      updateChatStrict('room-strict-1', message.id, { content: '不应复活' }),
    ).resolves.toBeNull();

    expect(chatHistory('room-strict-1')).toEqual([]);
    expect(publish).toHaveBeenCalledWith(
      'niuniu:room:broadcast',
      expect.stringContaining('"type":"chat_delete"'),
    );
  });

  it('Lua fencing token 失效时不再更新或广播成绩单', async () => {
    redisState.evalResult = -1;

    await expect(
      updateChatStrict(
        'room-strict-fence',
        message.id,
        { content: '失效持锁者不得写入' },
        {
          fence: { key: 'scoreboard-lock', token: 'old-token' },
          assertHeld: async () => undefined,
        },
      ),
    ).rejects.toBeInstanceOf(ScoreboardSyncLockLostError);
    expect(publish).not.toHaveBeenCalled();
  });

  it('持锁更新在同一 Lua 中写 Redis 并发布，不走锁外广播', async () => {
    redisState.evalResult = 1;

    await expect(
      updateChatStrict(
        'room-strict-fenced-publish',
        message.id,
        { content: '原子更新并发布' },
        {
          fence: { key: 'scoreboard-lock', token: 'current-token' },
          assertHeld: async () => undefined,
        },
      ),
    ).resolves.toMatchObject({ content: '原子更新并发布' });

    expect(String(redisEval.mock.calls.at(-1)?.[0])).toContain(
      "redis.call('PUBLISH'",
    );
    expect(publish).not.toHaveBeenCalled();
  });
});
