import { describe, expect, it, vi } from 'vitest';

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

vi.mock('../lib/prisma.js', () => ({ prisma: {} }));
vi.mock('./gameBus.js', () => ({ gameBus: { on: vi.fn() } }));
vi.mock('./gameSettings.js', () => ({
  isAssistantEnabledSync: () => true,
  isAssistantEnabledFresh: async () => true,
}));
vi.mock('./roomAnnounce.js', () => ({ buildRoundAnnounceMessages: vi.fn() }));

import { appendGamePacketMessage, chatHistory } from './roomHub.js';

describe('对局红包聊天事件', () => {
  it('按 packetId 只插入一次，并保留局号用于历史红包判定', async () => {
    const first = await appendGamePacketMessage('packet-test-room', {
      packetId: 'packet-1',
      roundId: 'round-1',
    });
    const duplicate = await appendGamePacketMessage('packet-test-room', {
      packetId: 'packet-1',
      roundId: 'round-1',
    });

    expect(duplicate.id).toBe(first.id);
    expect(chatHistory('packet-test-room')).toHaveLength(1);
    expect(first).toMatchObject({
      type: 'GAME_PACKET',
      from: null,
    });
    expect(JSON.parse(first.content)).toEqual({
      id: 'packet-1',
      roundId: 'round-1',
      greeting: '恭喜发财，大吉大利',
    });
  });
});
