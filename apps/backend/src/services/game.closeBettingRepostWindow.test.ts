import { beforeEach, describe, expect, it, vi } from 'vitest';

const events = vi.hoisted(() =>
  [] as Array<{ roundId: string; type: string; payload?: unknown }>,
);

const tx = vi.hoisted(() => ({
  round: {
    findUnique: vi.fn(async () => ({
      id: 'round-1',
      roomId: 'room-1',
      phase: 'BETTING',
      bankerId: 'banker-1',
      bankerReservedCents: 10_000n,
      configSnapshot: {},
      bets: [{ id: 'bet-1', status: 'FROZEN' }],
    })),
    update: vi.fn(async () => ({
      id: 'round-1',
      roomId: 'room-1',
      phase: 'SENDING_PACKET',
    })),
  },
  wallet: {
    findUnique: vi.fn(async () => ({ availableCents: 100_000n })),
  },
  packet: {
    upsert: vi.fn(async () => ({ id: 'packet-1' })),
  },
  roundEvent: {
    create: vi.fn(async ({ data }: {
      data: { roundId: string; type: string; payload?: unknown };
    }) => {
      events.push(data);
      return { id: `event-${events.length}`, ...data };
    }),
  },
}));

vi.mock('../config.js', () => ({
  env: { sensitiveDataKey: 'test-key', tngPacketHosts: [] },
}));
vi.mock('../lib/prisma.js', () => ({ prisma: tx }));
vi.mock('../lib/transaction.js', () => ({
  serializable: async (task: (client: typeof tx) => Promise<unknown>) => task(tx),
}));
vi.mock('./gameSettings.js', () => ({
  getGameSettings: vi.fn(),
  parseSettingsSnapshot: vi.fn(() => ({
    fees: {
      bankerSeatFeeRatio: 0.01,
      serviceFeeCents: 3_800,
      packetPerHeadCents: 104,
      playerRakeRatio: 0.03,
      bankerRakeRatio: 0.05,
    },
    round: {
      claimDurationSeconds: 40,
      repostWindowSeconds: 5,
      bankerDiceTimeoutSeconds: 15,
    },
  })),
  setAssistantService: vi.fn(),
  settingsSnapshot: vi.fn(),
}));
vi.mock('./wallet.js', () => ({
  freezeBanker: vi.fn(async () => undefined),
  transfer: vi.fn(),
  unfreeze: vi.fn(),
}));

import { closeBetting } from './game.js';

describe('封盘重推确认窗口', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T05:00:00.000Z'));
    events.length = 0;
  });

  it('封盘事务会记录可重推截止时间', async () => {
    await closeBetting('round-1');

    expect(events).toContainEqual({
      roundId: 'round-1',
      type: 'BANKER_REPOST_WINDOW',
      payload: {
        endsAt: '2026-08-19T05:00:05.000Z',
        seconds: 5,
      },
    });
    expect(events).toContainEqual({
      roundId: 'round-1',
      type: 'BANKER_DICE_DEADLINE',
      payload: {
        startsAt: '2026-08-19T05:00:05.000Z',
        endsAt: '2026-08-19T05:00:20.000Z',
        seconds: 15,
      },
    });
  });
});
