import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({
  broadcasts: [] as Array<{ type?: string; highCents?: string; roundId?: string }>,
  rebroadcasts: [] as Array<{ roundId: string }>,
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => ({
        uid: 'brian',
        nickname: 'Brian',
        tgUsername: null,
        avatarUrl: null,
      })),
    },
    bankerBid: {
      findMany: vi.fn(async () => [
        {
          amountCents: 215_000n,
          user: {
            uid: 'brian',
            nickname: 'Brian',
            tgUsername: null,
            avatarUrl: null,
          },
        },
        {
          amountCents: 205_000n,
          user: {
            uid: 'caleb',
            nickname: 'Caleb',
            tgUsername: null,
            avatarUrl: null,
          },
        },
      ]),
    },
  },
}));

vi.mock('./game.js', () => ({
  BANKER_BID_INCREMENT_CENTS: 10_000n,
  closeBidding: vi.fn(),
  GameError: class GameError extends Error {
    constructor(public code: string) {
      super(code);
    }
  },
}));

vi.mock('./gameBus.js', () => ({
  gameBus: { transition: vi.fn() },
}));

vi.mock('./gameSettings.js', () => ({
  getMessageTemplatesForRoom: vi.fn(async () => ({
    bidPlaced: '叫价更新 {{player}} {{high}} {{next}}',
  })),
  renderMessage: (template: string, vars: Record<string, string | number>) =>
    template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(vars[key] ?? '')),
}));

vi.mock('./roomHub.js', () => ({
  rebroadcastRoomState: vi.fn(async (params: { roundId: string }) => {
    memory.rebroadcasts.push(params);
  }),
  broadcastToRoomCluster: vi.fn(async (_roomId: string, payload: { type?: string }) => {
    memory.broadcasts.push(payload);
  }),
  systemChat: vi.fn(),
  appendSystemChatOnce: vi.fn(),
  appendAssistantChatOnce: vi.fn(),
}));

import { announceBidPlaced } from './bidAuction.js';

describe('叫价更新即时同步当前最高', () => {
  beforeEach(() => {
    memory.broadcasts.length = 0;
    memory.rebroadcasts.length = 0;
  });

  it('每次出价都推送 bid_update，不等 30 秒整桌心跳', async () => {
    await announceBidPlaced({
      roundId: 'round-1',
      roomId: 'room-1',
      userId: 'user-brian',
      amountCents: 215_000n,
    });

    expect(memory.broadcasts).toContainEqual(
      expect.objectContaining({
        type: 'bid_update',
        roundId: 'round-1',
        highCents: '215000',
        nextCents: '225000',
        bidCount: 2,
        amountCents: '215000',
        leader: expect.objectContaining({ uid: 'brian', nickname: 'Brian' }),
      }),
    );
    expect(memory.rebroadcasts).toHaveLength(0);
  });

  it('最后 5 秒延时加价仍会重播房间倒计时', async () => {
    await announceBidPlaced({
      roundId: 'round-1',
      roomId: 'room-1',
      userId: 'user-brian',
      amountCents: 215_000n,
      extendedEndsAt: new Date('2026-08-22T04:00:05.000Z'),
    });

    expect(memory.broadcasts.some((item) => item.type === 'bid_update')).toBe(true);
    expect(memory.rebroadcasts).toEqual([
      expect.objectContaining({ roundId: 'round-1', roomId: 'room-1' }),
    ]);
  });
});
