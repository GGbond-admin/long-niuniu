import { describe, expect, it, vi } from 'vitest';
import type { RoomChatMessage } from './roomHub.js';

const history = vi.hoisted(() =>
  Array.from({ length: 150 }, (_, index) => ({
    id: `m${index}`,
    type: 'TEXT',
    content: `message-${index}`,
    from: null,
    at: new Date(Date.now() - 150_000 + index * 1_000).toISOString(),
  })) as RoomChatMessage[],
);
const redisLrange = vi.hoisted(() => vi.fn());
const redisPublish = vi.hoisted(() => vi.fn(async () => 1));
const roomHistoryOverrides = vi.hoisted(
  () => new Map<string, RoomChatMessage[]>(),
);

vi.mock('../config.js', () => ({ env: { nodeEnv: 'test' } }));
vi.mock('../lib/redis.js', () => {
  redisLrange.mockImplementation(async (_key: string, start: number, stop: number) => {
    const source = roomHistoryOverrides.get(_key) ?? history;
    const normalize = (index: number) =>
      index < 0
        ? Math.max(0, source.length + index)
        : Math.min(source.length, index);
    const from = normalize(start);
    const through = normalize(stop);
    if (from >= source.length || through < from) return [];
    return source
      .slice(from, through + 1)
      .map((message) => JSON.stringify(message));
  });
  const command = {
    lrange: redisLrange,
    publish: redisPublish,
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
  broadcastRoomMemberModeration,
  broadcastRoomModeration,
  loadChatHistoryBefore,
  rebroadcastRoomState,
  removeClient,
  resolveChatReply,
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
    expect(chatHistory.hasMore).toBe(true);

    removeClient(roomId, current.client);
  });

  it('以上一页首条消息为游标，每次返回更早 50 条并标记是否还有历史', async () => {
    const firstPage = await loadChatHistoryBefore(
      'room-history-page',
      { id: 'm50', at: history[50]!.at },
      50,
    );

    expect(firstPage.messages).toHaveLength(50);
    expect(firstPage.messages[0]?.id).toBe('m0');
    expect(firstPage.messages[49]?.id).toBe('m49');
    expect(firstPage.hasMore).toBe(false);

    const middlePage = await loadChatHistoryBefore(
      'room-history-page',
      { id: 'm100', at: history[100]!.at },
      50,
    );

    expect(middlePage.messages).toHaveLength(50);
    expect(middlePage.messages[0]?.id).toBe('m50');
    expect(middlePage.messages[49]?.id).toBe('m99');
    expect(middlePage.hasMore).toBe(true);
  });

  it('用一次有界 Redis 快照分页，不读取完整 2,000 条', async () => {
    const roomId = 'room-large-history';
    const largeHistory = Array.from({ length: 2_000 }, (_, index) => ({
      id: `large-${index}`,
      type: 'TEXT',
      content: `large-message-${index}`,
      from: null,
      at: new Date(Date.now() - 2_000_000 + index * 1_000).toISOString(),
    }));
    roomHistoryOverrides.set(`room:chat:${roomId}`, largeHistory);
    redisLrange.mockClear();

    const page = await loadChatHistoryBefore(
      roomId,
      { id: 'large-1900', at: largeHistory[1900]!.at },
      50,
    );

    expect(page.messages[0]?.id).toBe('large-1850');
    expect(page.messages[49]?.id).toBe('large-1899');
    expect(page.hasMore).toBe(true);
    expect(
      redisLrange.mock.calls
        .filter(([key]) => key === `room:chat:${roomId}`)
        .map(([, start, stop]) => [start, stop]),
    ).toEqual([[-700, -1]]);
    roomHistoryOverrides.delete(`room:chat:${roomId}`);
  });

  it('同毫秒消息按 Redis 插入顺序分页，游标删除时要求客户端重试', async () => {
    const roomId = 'room-deleted-cursor';
    const at = new Date().toISOString();
    const fullHistory = Array.from({ length: 120 }, (_, index) => ({
      id: `same-${String(119 - index).padStart(3, '0')}`,
      type: 'TEXT',
      content: `same-message-${index}`,
      from: null,
      at,
    }));
    const before = fullHistory[70]!;
    roomHistoryOverrides.set(`room:chat:${roomId}`, fullHistory);

    const page = await loadChatHistoryBefore(roomId, before, 20);

    expect(page.messages.map((message) => message.id)).toEqual(
      fullHistory.slice(50, 70).map((message) => message.id),
    );
    expect(page.hasMore).toBe(true);

    const deletedRoomId = `${roomId}-missing`;
    roomHistoryOverrides.set(
      `room:chat:${deletedRoomId}`,
      fullHistory.filter((message) => message.id !== before.id),
    );
    await expect(
      loadChatHistoryBefore(deletedRoomId, before, 20),
    ).resolves.toMatchObject({
      messages: expect.any(Array),
      hasMore: true,
      cursorExpired: true,
    });
    roomHistoryOverrides.delete(`room:chat:${roomId}`);
    roomHistoryOverrides.delete(`room:chat:${deletedRoomId}`);
  });

  it('合并相同游标的并发读取，且 Redis 短暂失败后允许重试', async () => {
    const before = { id: 'm100', at: history[100]!.at };
    const first = loadChatHistoryBefore('room-history-concurrent', before, 50);
    const second = loadChatHistoryBefore('room-history-concurrent', before, 50);
    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({ hasMore: true });

    redisLrange.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(
      loadChatHistoryBefore('room-history-retry', before, 50),
    ).rejects.toThrow('redis unavailable');
    await expect(
      loadChatHistoryBefore('room-history-retry', before, 50),
    ).resolves.toMatchObject({
      messages: expect.any(Array),
      hasMore: true,
    });
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

  it('禁言事件只定向目标连接并发布跨实例控制事件', async () => {
    const roomId = 'room-member-moderation';
    const target = client();
    const other = client();
    other.client.userId = 'user-2';
    other.client.uid = '10002';
    addClient(roomId, target.client);
    addClient(roomId, other.client);
    await vi.waitFor(() => {
      expect(
        target.socket.send.mock.calls.some(
          ([raw]) => JSON.parse(String(raw)).type === 'chat_history',
        ),
      ).toBe(true);
      expect(
        other.socket.send.mock.calls.some(
          ([raw]) => JSON.parse(String(raw)).type === 'chat_history',
        ),
      ).toBe(true);
    });
    target.socket.send.mockClear();
    other.socket.send.mockClear();
    redisPublish.mockClear();

    await broadcastRoomMemberModeration({
      roomId,
      userId: 'user-1',
      moderation: {
        muted: true,
        mutedAt: '2026-08-19T08:00:00.000Z',
        mutedUntil: '2026-08-19T09:00:00.000Z',
        reason: '刷屏',
      },
    });

    expect(target.socket.send).toHaveBeenCalledOnce();
    expect(JSON.parse(String(target.socket.send.mock.calls[0]?.[0]))).toMatchObject({
      type: 'moderation',
      muted: true,
      reason: '刷屏',
    });
    expect(other.socket.send).not.toHaveBeenCalled();
    expect(target.client.chatMuteReason).toBe('刷屏');
    expect(redisPublish).toHaveBeenCalledWith(
      'niuniu:room:broadcast',
      expect.stringContaining('"control":"member_moderation"'),
    );

    removeClient(roomId, target.client);
    removeClient(roomId, other.client);
  });

  it('全群禁言事件立即更新房内所有连接并发布跨实例控制事件', async () => {
    const roomId = 'room-global-moderation';
    const first = client();
    const second = client();
    second.client.userId = 'user-2';
    addClient(roomId, first.client);
    addClient(roomId, second.client);
    await vi.waitFor(() => {
      expect(first.socket.send).toHaveBeenCalled();
      expect(second.socket.send).toHaveBeenCalled();
    });
    first.socket.send.mockClear();
    second.socket.send.mockClear();
    redisPublish.mockClear();

    await broadcastRoomModeration({
      roomId,
      moderation: {
        muted: true,
        mutedAt: '2026-08-19T12:00:00.000Z',
        reason: '运营维护',
      },
    });

    for (const current of [first, second]) {
      expect(JSON.parse(String(current.socket.send.mock.calls[0]?.[0]))).toMatchObject({
        type: 'room_moderation',
        muted: true,
        reason: '运营维护',
      });
      expect(current.client.roomChatMuteReason).toBe('运营维护');
    }
    expect(redisPublish).toHaveBeenCalledWith(
      'niuniu:room:broadcast',
      expect.stringContaining('"control":"room_moderation"'),
    );

    removeClient(roomId, first.client);
    removeClient(roomId, second.client);
  });

  it('回复只能引用当前房间内其他玩家的有效文字消息', async () => {
    const roomId = 'room-chat-reply';
    const target: RoomChatMessage = {
      id: 'reply-target',
      type: 'TEXT',
      content: '今晚继续吗？',
      from: {
        uid: '20002',
        nickname: '小美',
        avatarUrl: null,
      },
      at: new Date().toISOString(),
    };
    roomHistoryOverrides.set(`room:chat:${roomId}`, [
      target,
      {
        ...target,
        id: 'system-target',
        type: 'SYSTEM',
        from: null,
      },
    ]);

    await expect(
      resolveChatReply(roomId, target.id, '10001'),
    ).resolves.toEqual({
      messageId: target.id,
      uid: '20002',
      nickname: '小美',
      content: '今晚继续吗？',
      type: 'TEXT',
    });
    await expect(
      resolveChatReply(roomId, target.id, '20002'),
    ).resolves.toBeNull();
    await expect(
      resolveChatReply(roomId, 'system-target', '10001'),
    ).resolves.toBeNull();
    await expect(
      resolveChatReply(roomId, 'missing-target', '10001'),
    ).resolves.toBeNull();

    roomHistoryOverrides.delete(`room:chat:${roomId}`);
  });
});
