import { RoundPhase } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({
  events: [] as Array<{ type: string; createdAt: Date }>,
  topUpVirtualIfNeeded: vi.fn(),
  continueBankerWithFallback: vi.fn(),
  bankerContinuationFunding: vi.fn(),
  findVirtualBanker: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    room: {
      findUnique: vi.fn(async () => ({ gameCode: 'SUPREME_NIUNIU' })),
    },
    round: {
      findUnique: vi.fn(async () => ({
        id: 'round-1',
        roomId: 'room-1',
        phase: RoundPhase.FINISHED,
        bankerId: 'banker-1',
        isContinued: false,
        continuationUsed: false,
        configSnapshot: {},
        events: memory.events,
      })),
      findMany: vi.fn(async () => []),
    },
    virtualPlayer: {
      findFirst: memory.findVirtualBanker,
    },
    groupPacket: {
      findMany: vi.fn(async () => []),
    },
  },
}));

vi.mock('../lib/redis.js', () => ({
  withRedisLock: vi.fn(
    async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  ),
}));

vi.mock('./game.js', () => {
  class GameError extends Error {
    constructor(public code: string) {
      super(code);
    }
  }
  return {
    BANKER_BID_INCREMENT_CENTS: 10_000n,
    bankerContinuationFunding: memory.bankerContinuationFunding,
    currentRoundForRoom: vi.fn(),
    GameError,
    placeBankerBid: vi.fn(),
    placeBet: vi.fn(),
  };
});

vi.mock('./bankerContinuationFlow.js', () => ({
  continueBankerWithFallback: memory.continueBankerWithFallback,
}));
vi.mock('./gameBus.js', () => ({
  gameBus: { on: vi.fn(), transition: vi.fn() },
}));
vi.mock('./gameSettings.js', () => ({
  getGameSettings: vi.fn(async () => ({ round: { assistantEnabled: true } })),
  parseSettingsSnapshot: vi.fn(() => ({
    round: { continuationWindowSeconds: 15 },
  })),
}));
vi.mock('./virtualPlayers.js', () => ({
  listEnabledVirtualsForRoom: vi.fn(async () => []),
  topUpVirtualIfNeeded: memory.topUpVirtualIfNeeded,
}));
vi.mock('./roomChatPolicy.js', () => ({
  ROOM_ANNOUNCED_FINISHED: 'ROOM_ANNOUNCED_FINISHED',
  getRoomChatPolicy: vi.fn(async () => ({ muted: false, stage: null })),
}));
vi.mock('./bidAuction.js', () => ({ announceBidPlaced: vi.fn() }));
vi.mock('./chatCommands.js', () => ({ runBankerDiceCeremony: vi.fn() }));
vi.mock('./groupPacket.js', () => ({ claimGroupPacket: vi.fn() }));
vi.mock('./roomHub.js', () => ({ appendChat: vi.fn() }));

import { scheduleVirtualContinuationForRound } from './virtualPlayerWorker.js';

describe('虚拟庄续庄窗口', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T10:00:05.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0);
    memory.events = [];
    memory.topUpVirtualIfNeeded.mockReset();
    memory.continueBankerWithFallback.mockReset();
    memory.bankerContinuationFunding.mockReset();
    memory.bankerContinuationFunding.mockResolvedValue({
      requiredCents: 80_000n,
    });
    memory.findVirtualBanker.mockReset();
    memory.findVirtualBanker.mockResolvedValue({ userId: 'banker-1' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('成绩单完成事件出现前不自动续庄', async () => {
    await scheduleVirtualContinuationForRound('room-1', 'round-1');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(memory.findVirtualBanker).not.toHaveBeenCalled();
    expect(memory.continueBankerWithFallback).not.toHaveBeenCalled();
  });

  it('从完成事件起计时，并按续庄所需金额自动补款后确认', async () => {
    memory.events = [
      {
        type: 'ROOM_ANNOUNCED_FINISHED',
        createdAt: new Date('2026-08-19T10:00:00.000Z'),
      },
    ];

    await scheduleVirtualContinuationForRound('room-1', 'round-1');
    // scheduler 心跳与播报完成事件可能并发触发，不得反复重置同一确认计时器。
    await scheduleVirtualContinuationForRound('room-1', 'round-1');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(memory.topUpVirtualIfNeeded).toHaveBeenCalledWith(
      'banker-1',
      'SYSTEM',
      80_000n,
    );
    expect(memory.continueBankerWithFallback).toHaveBeenCalledWith(
      'round-1',
      'banker-1',
    );
    expect(memory.continueBankerWithFallback).toHaveBeenCalledTimes(1);
  });
});
