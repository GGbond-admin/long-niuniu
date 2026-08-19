import { describe, expect, it, vi } from 'vitest';

const { findMany } = vi.hoisted(() => ({
  findMany: vi.fn(async () => [
    {
      uid: '1234567890',
      nickname: '新昵称',
      avatarUrl: '/avatars/nft-08.jpg',
    },
  ]),
}));

vi.mock('../lib/redis.js', () => ({
  withRedisLock: vi.fn(async (_key: string, _ttl: number, work: () => Promise<unknown>) =>
    work(),
  ),
  redis: () => ({
    lrange: vi.fn(async () => [
      JSON.stringify({
        id: 'message-1',
        type: 'TEXT',
        content: '你好',
        from: {
          uid: '1234567890',
          nickname: '旧昵称',
          avatarUrl: null,
        },
        at: new Date().toISOString(),
      }),
    ]),
  }),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: { user: { findMany } },
}));
vi.mock('./gameBus.js', () => ({ gameBus: { on: vi.fn() } }));
vi.mock('./gameSettings.js', () => ({
  isAssistantEnabledSync: () => true,
  isAssistantEnabledFresh: async () => true,
}));
vi.mock('./roomAnnounce.js', () => ({ buildRoundAnnounceMessages: vi.fn() }));

import { loadChatHistory } from './roomHub.js';

describe('群聊头像同步', () => {
  it('读取历史消息时使用用户当前头像与昵称', async () => {
    const messages = await loadChatHistory('avatar-sync-room');

    expect(findMany).toHaveBeenCalledWith({
      where: { uid: { in: ['1234567890'] } },
      select: { uid: true, nickname: true, avatarUrl: true },
    });
    expect(messages[0]?.from).toEqual({
      uid: '1234567890',
      nickname: '新昵称',
      avatarUrl: '/avatars/nft-08.jpg',
    });
  });
});
