import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);
const subscriberHandlers = vi.hoisted(
  () => new Map<string, (...args: string[]) => void>(),
);
const redisRead = vi.hoisted(() => ({
  pending: null as Promise<string[]> | null,
  responses: [] as Array<string[] | Promise<string[]>>,
  count: 0,
}));

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
    on: vi.fn((event: string, handler: (...args: string[]) => void) => {
      subscriberHandlers.set(event, handler);
    }),
    disconnect: vi.fn(),
  };
  const command = {
    duplicate: vi.fn(() => subscriber),
    publish: vi.fn(async () => 1),
    lrange: vi.fn(async () => {
      redisRead.count += 1;
      const queued = redisRead.responses.shift();
      if (queued) return queued;
      return redisRead.pending ? redisRead.pending : [];
    }),
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

import { chatHistory, initRoomHub, loadChatHistory } from './roomHub.js';

describe('多实例房间事件订阅', () => {
  it('lazy Redis 连接先 connect 再 subscribe', async () => {
    initRoomHub();
    await vi.waitFor(() => expect(calls).toEqual(['connect', 'subscribe']));
  });

  it('远端 chat_update/chat_delete 同步本实例缓存', async () => {
    initRoomHub();
    await vi.waitFor(() => expect(subscriberHandlers.has('message')).toBe(true));
    const onMessage = subscriberHandlers.get('message')!;
    const message = {
      id: 'scoreboard-1',
      type: 'SYSTEM',
      content: '新成绩单',
      from: null,
      at: new Date().toISOString(),
    };

    onMessage(
      'niuniu:room:broadcast',
      JSON.stringify({
        origin: 'remote-instance',
        roomId: 'room-cache-1',
        payload: { type: 'chat_update', message },
      }),
    );
    expect(chatHistory('room-cache-1')).toEqual([message]);

    onMessage(
      'niuniu:room:broadcast',
      JSON.stringify({
        origin: 'remote-instance',
        roomId: 'room-cache-1',
        payload: { type: 'chat_delete', messageId: message.id },
      }),
    );
    expect(chatHistory('room-cache-1')).toEqual([]);

    // 删除之后迟到的 update 不得把旧分段重新放回缓存。
    onMessage(
      'niuniu:room:broadcast',
      JSON.stringify({
        origin: 'remote-instance',
        roomId: 'room-cache-1',
        payload: { type: 'chat_update', message },
      }),
    );
    expect(chatHistory('room-cache-1')).toEqual([]);
  });

  it('历史加载期间收到远端删除时不把迟到快照重新返回给客户端', async () => {
    initRoomHub();
    await vi.waitFor(() => expect(subscriberHandlers.has('message')).toBe(true));
    const onMessage = subscriberHandlers.get('message')!;
    const roomId = 'room-cache-race';
    const message = {
      id: 'scoreboard-race-1',
      type: 'SYSTEM',
      content: '即将删除的旧成绩单',
      from: null,
      at: new Date().toISOString(),
    };
    onMessage(
      'niuniu:room:broadcast',
      JSON.stringify({
        origin: 'remote-instance',
        roomId,
        payload: { type: 'chat', message },
      }),
    );

    let resolveRows!: (rows: string[]) => void;
    redisRead.pending = new Promise<string[]>((resolve) => {
      resolveRows = resolve;
    });
    const loading = loadChatHistory(roomId);
    onMessage(
      'niuniu:room:broadcast',
      JSON.stringify({
        origin: 'remote-instance',
        roomId,
        payload: { type: 'chat_delete', messageId: message.id },
      }),
    );
    redisRead.pending = Promise.resolve([]);
    resolveRows([JSON.stringify(message)]);

    await expect(loading).resolves.toEqual([]);
    expect(chatHistory(roomId)).toEqual([]);
    redisRead.pending = null;
  });

  it('Redis 已无消息时不会由漏收删除广播的陈旧内存复活', async () => {
    initRoomHub();
    await vi.waitFor(() => expect(subscriberHandlers.has('message')).toBe(true));
    const onMessage = subscriberHandlers.get('message')!;
    const roomId = 'room-cache-authoritative';
    const message = {
      id: 'scoreboard-stale-1',
      type: 'SYSTEM',
      content: '其它实例已删除的旧分段',
      from: null,
      at: new Date().toISOString(),
    };
    onMessage(
      'niuniu:room:broadcast',
      JSON.stringify({
        origin: 'remote-instance',
        roomId,
        payload: { type: 'chat', message },
      }),
    );
    expect(chatHistory(roomId)).toEqual([message]);

    redisRead.pending = null;
    await expect(loadChatHistory(roomId)).resolves.toEqual([]);
    expect(chatHistory(roomId)).toEqual([]);
  });

  it('同一稳定 ID 被重新写入 Redis 后可淘汰旧 tombstone', async () => {
    initRoomHub();
    await vi.waitFor(() => expect(subscriberHandlers.has('message')).toBe(true));
    const onMessage = subscriberHandlers.get('message')!;
    const roomId = 'room-cache-recreated';
    const original = {
      id: 'round:recreated:scoreboard:1',
      type: 'SYSTEM',
      content: '缩段前的旧内容',
      from: null,
      at: new Date().toISOString(),
    };
    onMessage(
      'niuniu:room:broadcast',
      JSON.stringify({
        origin: 'remote-instance',
        roomId,
        payload: { type: 'chat', message: original },
      }),
    );
    onMessage(
      'niuniu:room:broadcast',
      JSON.stringify({
        origin: 'remote-instance',
        roomId,
        payload: { type: 'chat_delete', messageId: original.id },
      }),
    );

    const recreated = {
      ...original,
      content: '扩段后重新创建的内容',
      // 故意沿用相同时间，验证二次 Redis 权威读取而非依赖跨实例时钟。
      at: original.at,
    };
    redisRead.pending = Promise.resolve([JSON.stringify(recreated)]);

    await expect(loadChatHistory(roomId)).resolves.toEqual([recreated]);
    expect(chatHistory(roomId)).toEqual([recreated]);
    redisRead.pending = null;
  });

  it('确认重建期间收到更新的删除事件时不得清除新 tombstone', async () => {
    initRoomHub();
    await vi.waitFor(() => expect(subscriberHandlers.has('message')).toBe(true));
    const onMessage = subscriberHandlers.get('message')!;
    const roomId = 'room-cache-tombstone-generation';
    const message = {
      id: 'round:tombstone-race:scoreboard:1',
      type: 'SYSTEM',
      content: '待确认的重建分段',
      from: null,
      at: new Date().toISOString(),
    };
    onMessage(
      'niuniu:room:broadcast',
      JSON.stringify({
        origin: 'remote-instance',
        roomId,
        payload: { type: 'chat', message },
      }),
    );
    const deleteEvent = JSON.stringify({
      origin: 'remote-instance',
      roomId,
      payload: { type: 'chat_delete', messageId: message.id },
    });
    onMessage('niuniu:room:broadcast', deleteEvent);

    let resolveConfirmation!: (rows: string[]) => void;
    const confirmation = new Promise<string[]>((resolve) => {
      resolveConfirmation = resolve;
    });
    const readsBefore = redisRead.count;
    redisRead.responses.push(
      Promise.resolve([JSON.stringify(message)]),
      confirmation,
    );
    const loading = loadChatHistory(roomId);
    await vi.waitFor(() => expect(redisRead.count).toBeGreaterThanOrEqual(readsBefore + 2));

    // 二次 LRANGE 已产生旧快照，但处理结果前又收到更新一代删除。
    onMessage('niuniu:room:broadcast', deleteEvent);
    resolveConfirmation([JSON.stringify(message)]);

    await expect(loading).resolves.toEqual([]);
    expect(chatHistory(roomId)).toEqual([]);
    redisRead.responses.length = 0;
  });
});
