import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => {
  const events: Array<{ type: string; createdAt: Date; payload?: unknown }> = [];
  const actions: string[] = [];
  const closeBidding = vi.fn(async () => {
    actions.push('close-bidding');
    return { phase: 'BETTING' };
  });
  const transition = vi.fn();

  return { actions, assistantEnabled: true, closeBidding, events, transition };
});

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    round: {
      findUnique: vi.fn(async () => ({
        id: 'round-1',
        roomId: 'room-1',
        phase: 'BANKER_BID',
        bidEndsAt: new Date('2026-08-07T07:00:00.000Z'),
      })),
    },
    bankerBid: {
      findMany: vi.fn(async () => [
        {
          amountCents: 500_000n,
          user: { uid: 'winner', nickname: '赢家', tgUsername: null },
        },
        {
          amountCents: 480_000n,
          user: { uid: 'runner-up', nickname: '第二名', tgUsername: null },
        },
      ]),
    },
    roundEvent: {
      findMany: vi.fn(async () => memory.events),
      create: vi.fn(async ({ data }: { data: { type: string; payload?: unknown } }) => {
        const row = { ...data, createdAt: new Date(Date.now()) };
        memory.events.push(row);
        return row;
      }),
    },
  },
}));

vi.mock('./game.js', () => ({
  BANKER_BID_INCREMENT_CENTS: 10_000n,
  closeBidding: memory.closeBidding,
  GameError: class GameError extends Error {
    constructor(public code: string) {
      super(code);
    }
  },
}));

vi.mock('./gameBus.js', () => ({
  gameBus: { transition: memory.transition },
}));

vi.mock('./gameSettings.js', () => ({
  getMessageTemplatesForRoom: vi.fn(async () => ({
    bidCountdownStart: 'bid-countdown-start',
    bidFinalList: 'bid-final-list\n{{bidList}}\n{{leader}} RM {{high}}',
    bidCountdown3: '3',
    bidCountdown2: '2',
    bidCountdown1: '1',
  })),
  renderMessage: (template: string, vars: Record<string, string | number>) =>
    template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(vars[key] ?? '')),
}));

vi.mock('./roomHub.js', () => ({
  rebroadcastRoomState: vi.fn(async () => undefined),
  broadcastToRoomCluster: vi.fn(async () => undefined),
  systemChat: vi.fn((_roomId: string, content: string) => {
    memory.actions.push(content.startsWith('bid-final-list') ? 'bid-final-list' : content);
  }),
  appendSystemChatOnce: vi.fn(
    async (_roomId: string, _id: string, content: string) => {
      if (!memory.assistantEnabled) return null;
      memory.actions.push(content.startsWith('bid-final-list') ? 'bid-final-list' : content);
      return { id: _id };
    },
  ),
  appendAssistantChatOnce: vi.fn(
    async (_roomId: string, _id: string, message: { content: string }) => {
      if (!memory.assistantEnabled) return null;
      const payload = JSON.parse(message.content) as { emoji?: string };
      memory.actions.push(String(payload.emoji));
      return { id: _id };
    },
  ),
}));

import { advanceBidClosingCeremony } from './bidAuction.js';

describe('竞庄收官播报顺序', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T07:00:10.000Z'));
    memory.actions.length = 0;
    memory.assistantEnabled = true;
    memory.events.length = 0;
    memory.closeBidding.mockClear();
    memory.transition.mockClear();
  });

  it('先 3/2/1，再发最终名单，最后锁定庄家', async () => {
    await advanceBidClosingCeremony({ roundId: 'round-1', roomId: 'room-1' });

    for (let step = 0; step < 5; step += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await advanceBidClosingCeremony({ roundId: 'round-1', roomId: 'room-1' });
    }

    expect(memory.actions).toEqual([
      'bid-countdown-start',
      '3',
      '2',
      '1',
      'bid-final-list',
      'close-bidding',
    ]);
    expect(memory.events.map((event) => event.type)).toEqual([
      'BID_CLOSING',
      'BID_COUNTDOWN_3',
      'BID_COUNTDOWN_2',
      'BID_COUNTDOWN_1',
      'BID_FINAL_LIST',
    ]);
    expect(memory.transition).toHaveBeenCalledWith({
      roundId: 'round-1',
      roomId: 'room-1',
      from: 'BANKER_BID',
      to: 'BETTING',
    });
  });

  it('小助手暂停时不落步骤标记，恢复后从同一步继续', async () => {
    memory.assistantEnabled = false;
    await advanceBidClosingCeremony({ roundId: 'round-1', roomId: 'room-1' });
    expect(memory.events).toHaveLength(0);

    memory.assistantEnabled = true;
    await advanceBidClosingCeremony({ roundId: 'round-1', roomId: 'room-1' });
    expect(memory.events.map((event) => event.type)).toEqual(['BID_CLOSING']);
    expect(memory.actions).toEqual(['bid-countdown-start']);
  });
});
