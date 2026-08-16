import { describe, expect, it, vi } from 'vitest';

const history = vi.hoisted(() =>
  Array.from({ length: 150 }, (_, index) => ({
    id: `m${index}`,
    type: 'TEXT',
    content: `message-${index}`,
    from: null,
    at: new Date(1_700_000_000_000 + index).toISOString(),
  })),
);

vi.mock('../config.js', () => ({ env: { nodeEnv: 'test' } }));
vi.mock('../lib/redis.js', () => {
  const command = {
    lrange: vi.fn(async () => history.map((message) => JSON.stringify(message))),
    publish: vi.fn(async () => 1),
  };
  return {
    redis: () => command,
    withRedisLock: vi.fn(async (_key: string, _ttl: number, work: () => Promise<unknown>) =>
      work(),
    ),
  };
});
vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock('./gameBus.js', () => ({ gameBus: { on: vi.fn() } }));
vi.mock('./gameSettings.js', () => ({
  isAssistantEnabledSync: () => true,
  isAssistantEnabledFresh: async () => true,
}));
vi.mock('./roomAnnounce.js', () => ({ buildRoundAnnounceMessages: vi.fn() }));

import {
  addClient,
  rebroadcastRoomState,
  removeClient,
  type RoomClient,
} from './roomHub.js';

function client() {
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: vi.fn(),
  };
  return {
    socket,
    client: {
      socket,
      userId: 'user-1',
      uid: '10001',
      nickname: '测试用户',
    } as unknown as RoomClient,
  };
}

describe('玩家端聊天窗口', () => {
  it('首次连接只下发最近 100 条，而不是完整持久化历史', async () => {
    const roomId = 'room-client-window';
    const current = client();
    addClient(roomId, current.client);

    await vi.waitFor(() => {
      const payloads = current.socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
      expect(payloads.some((payload) => payload.type === 'chat_history')).toBe(true);
    });

    const payloads = current.socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    const chatHistory = payloads.find((payload) => payload.type === 'chat_history');
    expect(chatHistory.messages).toHaveLength(100);
    expect(chatHistory.messages[0]?.id).toBe('m50');

    removeClient(roomId, current.client);
  });

  it('状态心跳只广播 round，不重复下发整段聊天历史', async () => {
    const roomId = 'room-state-heartbeat';
    const current = client();
    addClient(roomId, current.client);
    await vi.waitFor(() =>
      expect(
        current.socket.send.mock.calls.some(
          ([raw]) => JSON.parse(String(raw)).type === 'chat_history',
        ),
      ).toBe(true),
    );
    current.socket.send.mockClear();

    await rebroadcastRoomState({
      roomId,
      roundId: 'round-1',
      phase: 'WAITING',
    });

    const types = current.socket.send.mock.calls.map(
      ([raw]) => JSON.parse(String(raw)).type,
    );
    expect(types).toEqual(['round']);

    removeClient(roomId, current.client);
  });
});
