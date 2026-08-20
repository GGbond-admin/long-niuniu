import { RoundPhase } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({
  continueBanker: vi.fn(),
  bankerContinuationFunding: vi.fn(),
  appendSystemChatOnce: vi.fn(),
  startRound: vi.fn(),
  transition: vi.fn(),
  roundEventUpsert: vi.fn(),
  rebroadcastRoomState: vi.fn(),
  previousEvents: [] as Array<{ id: string; type: string; payload: unknown }>,
  calls: [] as string[],
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    round: {
      findUnique: vi.fn(async () => ({
        id: 'round-1',
        roomId: 'room-1',
        phase: RoundPhase.FINISHED,
        bankerId: 'banker-1',
        events: memory.previousEvents,
      })),
    },
    roundEvent: {
      upsert: memory.roundEventUpsert,
    },
  },
}));

vi.mock('../lib/redis.js', () => ({
  withRedisLock: vi.fn(async (_key: string, _ttl: number, work: () => Promise<void>) =>
    work(),
  ),
}));

vi.mock('./game.js', () => {
  class GameError extends Error {
    constructor(
      public code: string,
      public details?: Record<string, unknown>,
    ) {
      super(code);
    }
  }
  return {
    GameError,
    continueBanker: memory.continueBanker,
    bankerContinuationFunding: memory.bankerContinuationFunding,
    ensureWaitingRound: vi.fn(async () => ({
      id: 'round-2',
      roomId: 'room-1',
      phase: RoundPhase.WAITING,
    })),
    startRound: memory.startRound,
  };
});

vi.mock('./gameBus.js', () => ({
  gameBus: { transition: memory.transition },
}));

vi.mock('./roomHub.js', () => ({
  appendSystemChatOnce: memory.appendSystemChatOnce,
  rebroadcastRoomState: memory.rebroadcastRoomState,
}));

import { GameError } from './game.js';
import {
  continueBankerWithFallback,
  rejectInsufficientContinuation,
} from './bankerContinuationFlow.js';

describe('续庄余额不足降级', () => {
  beforeEach(() => {
    memory.continueBanker.mockReset();
    memory.bankerContinuationFunding.mockReset();
    memory.bankerContinuationFunding.mockResolvedValue({
      roomId: 'room-1',
      bankerId: 'banker-1',
      uid: '9001',
      nickname: '庄家甲',
      tgUsername: null,
      requiredCents: 51_600n,
      availableCents: 10_000n,
      sufficient: false,
      autoFundableVirtual: false,
    });
    memory.appendSystemChatOnce.mockReset();
    memory.startRound.mockReset();
    memory.transition.mockReset();
    memory.roundEventUpsert.mockReset();
    memory.roundEventUpsert.mockResolvedValue({ id: 'rejected' });
    memory.rebroadcastRoomState.mockReset();
    memory.rebroadcastRoomState.mockResolvedValue(undefined);
    memory.previousEvents = [
      {
        id: 'announced',
        type: 'ROOM_ANNOUNCED_FINISHED',
        payload: null,
      },
    ];
    memory.calls.length = 0;
    memory.appendSystemChatOnce.mockImplementation(async () => {
      memory.calls.push('notice');
      return { id: 'notice-1' };
    });
    memory.startRound.mockImplementation(async () => {
      memory.calls.push('start');
      return {
        id: 'round-2',
        roomId: 'room-1',
        phase: RoundPhase.BANKER_BID,
      };
    });
  });

  it('按钮点击瞬间余额不足时先提示再立即公开竞标', async () => {
    memory.continueBanker.mockRejectedValue(
      new GameError('INSUFFICIENT_BALANCE', {
        requiredCents: '51600',
        availableCents: '10000',
      }),
    );

    await expect(
      continueBankerWithFallback('round-1', 'banker-1'),
    ).resolves.toBe('BANKER_BID');

    expect(memory.calls).toEqual(['notice', 'start']);
    expect(memory.appendSystemChatOnce).toHaveBeenCalledWith(
      'room-1',
      'round:round-1:continuation:insufficient',
      '【续庄余额不足】\n庄家 @庄家甲 续庄需冻结 516.00，当前可用 100.00，下一局立即转入公开竞标。',
      { force: true },
    );
    expect(memory.transition).toHaveBeenCalledWith({
      roundId: 'round-2',
      roomId: 'room-1',
      from: RoundPhase.WAITING,
      to: RoundPhase.BANKER_BID,
    });
    expect(memory.roundEventUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          roundId: 'round-1',
          type: 'CONTINUATION_REJECTED_INSUFFICIENT',
        }),
      }),
    );
  });

  it('余额足够续庄时直接进入下注且不发送不足提示', async () => {
    memory.continueBanker.mockResolvedValue({
      id: 'round-2',
      roomId: 'room-1',
      phase: RoundPhase.BETTING,
    });

    await expect(
      continueBankerWithFallback('round-1', 'banker-1'),
    ).resolves.toBe('CONTINUED');
    expect(memory.appendSystemChatOnce).not.toHaveBeenCalled();
    expect(memory.startRound).not.toHaveBeenCalled();
    expect(memory.transition).toHaveBeenCalledWith({
      roundId: 'round-2',
      roomId: 'room-1',
      from: RoundPhase.WAITING,
      to: RoundPhase.BETTING,
    });
  });

  it('已拒绝后即使余额补足仍补发原提示，并在人数不足时广播锁定状态', async () => {
    memory.previousEvents = [
      {
        id: 'announced',
        type: 'ROOM_ANNOUNCED_FINISHED',
        payload: null,
      },
      {
        id: 'rejected',
        type: 'CONTINUATION_REJECTED_INSUFFICIENT',
        payload: {
          requiredCents: '51600',
          availableCents: '10000',
        },
      },
    ];
    memory.bankerContinuationFunding.mockResolvedValue({
      roomId: 'room-1',
      bankerId: 'banker-1',
      uid: '9001',
      nickname: '庄家甲',
      tgUsername: null,
      requiredCents: 51_600n,
      availableCents: 100_000n,
      sufficient: true,
      autoFundableVirtual: false,
    });
    memory.startRound.mockRejectedValue(new GameError('NOT_ENOUGH_PLAYERS'));

    await rejectInsufficientContinuation({ previousRoundId: 'round-1' });

    expect(memory.appendSystemChatOnce).toHaveBeenCalledWith(
      'room-1',
      'round:round-1:continuation:insufficient',
      '【续庄余额不足】\n庄家 @庄家甲 续庄需冻结 516.00，当前可用 100.00，下一局立即转入公开竞标。',
      { force: true },
    );
    expect(memory.rebroadcastRoomState).toHaveBeenCalledWith({
      roomId: 'room-1',
      roundId: 'round-2',
      phase: RoundPhase.WAITING,
    });
  });
});
