import { RoundPhase } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({
  autoStart: false,
  assistantEnabled: true,
  startMode: 'AUTO' as 'MANUAL' | 'AUTO' | 'STOPPED',
  chatMutedAt: null as Date | null,
  previous: {
    id: 'round-1',
    roomId: 'room-1',
    seqNo: 1,
    phase: 'FINISHED',
    bankerId: 'banker-1',
    isContinued: false,
    continuationUsed: false,
    finishedAt: new Date('2026-08-07T07:00:00.000Z'),
    cancelReason: null as string | null,
    configSnapshot: {},
    events: [
      {
        type: 'ROOM_ANNOUNCED_FINISHED',
        createdAt: new Date('2026-08-07T07:00:00.000Z'),
      },
    ] as Array<{ type: string; createdAt: Date }>,
  },
  startRound: vi.fn(),
  appendSystemChatOnce: vi.fn(),
  ensureRoundAnnouncement: vi.fn(),
  rebroadcastRoomState: vi.fn(),
  bankerContinuationFunding: vi.fn(),
  rejectInsufficientContinuation: vi.fn(),
  scheduleVirtualContinuationForRound: vi.fn(),
  transition: vi.fn(),
  activeRounds: [] as Array<Record<string, unknown>>,
  pendingPackets: [] as Array<Record<string, unknown>>,
  cancelBankerDiceTimeout: vi.fn(),
  finalizeInternalRound: vi.fn(),
}));

vi.mock('../config.js', () => ({
  env: { tngAutoPacketUrlTemplate: '' },
}));

vi.mock('../lib/redis.js', () => ({
  redis: vi.fn(() => ({ set: vi.fn(async () => 'OK') })),
  withRedisLock: vi.fn(async (_key: string, _ttl: number, work: () => Promise<void>) =>
    work(),
  ),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    round: {
      findMany: vi.fn(async ({ where }: { where?: { phase?: string | { in?: string[] } } }) => {
        if (where?.phase === RoundPhase.SENDING_PACKET) return memory.pendingPackets;
        return typeof where?.phase === 'object' && where.phase.in
          ? memory.activeRounds
          : [];
      }),
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        'roomId_seqNo' in where
          ? memory.previous
          : {
              id: 'round-2',
              roomId: 'room-1',
              seqNo: 2,
              phase: 'BANKER_BID',
            },
      ),
    },
    room: {
      findMany: vi.fn(async () => [
        {
          id: 'room-1',
          gameCode: 'SUPREME_NIUNIU',
          roundStartMode: memory.startMode,
          chatMutedAt: memory.chatMutedAt,
        },
      ]),
    },
    tngAccount: {
      findFirst: vi.fn(async () => null),
    },
  },
}));

vi.mock('./bidAuction.js', () => ({
  advanceBidClosingCeremony: vi.fn(),
}));

vi.mock('./chatCommands.js', () => ({
  cancelBankerDiceTimeout: memory.cancelBankerDiceTimeout,
}));

vi.mock('./game.js', () => ({
  applyAutoTailClaims: vi.fn(),
  closeBetting: vi.fn(),
  ensureWaitingRound: vi.fn(async () => ({
    id: 'round-2',
    roomId: 'room-1',
    seqNo: 2,
    phase: 'WAITING',
  })),
  expirePacket: vi.fn(),
  GameError: class GameError extends Error {
    constructor(public code: string) {
      super(code);
    }
  },
  publishInternalPacket: vi.fn(),
  publishPacket: vi.fn(),
  refreshUnannouncedClaimDeadline: vi.fn(),
  bankerContinuationFunding: memory.bankerContinuationFunding,
  startRound: memory.startRound,
}));

vi.mock('./bankerContinuationFlow.js', () => ({
  rejectInsufficientContinuation: memory.rejectInsufficientContinuation,
}));

vi.mock('./internalPacket.js', () => ({
  finalizeInternalRound: memory.finalizeInternalRound,
}));

vi.mock('./gameBus.js', () => ({
  gameBus: { transition: memory.transition },
}));

vi.mock('./gameSettings.js', () => ({
  getGameSettings: vi.fn(async () => ({
    round: {
      assistantEnabled: memory.assistantEnabled,
      autoStart: memory.autoStart,
    },
  })),
  parseSettingsSnapshot: vi.fn(() => ({
    round: { continuationWindowSeconds: 15 },
  })),
}));

vi.mock('./groupPacket.js', () => ({
  expireGroupPackets: vi.fn(async () => undefined),
}));

vi.mock('./roomHub.js', () => ({
  appendGamePacketMessage: vi.fn(),
  appendSystemChatOnce: memory.appendSystemChatOnce,
  ensureRoundAnnouncement: memory.ensureRoundAnnouncement,
  rebroadcastRoomState: memory.rebroadcastRoomState,
  systemChat: vi.fn(),
}));

vi.mock('./virtualPlayerWorker.js', () => ({
  scheduleVirtualContinuationForRound: memory.scheduleVirtualContinuationForRound,
  scheduleVirtualDiceForRound: vi.fn(),
}));

import { RoundScheduler } from './roundScheduler.js';

describe('续庄窗口结束后的调度', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T07:00:20.000Z'));
    memory.autoStart = true;
    memory.assistantEnabled = true;
    memory.startMode = 'AUTO';
    memory.chatMutedAt = null;
    memory.previous.finishedAt = new Date('2026-08-07T07:00:00.000Z');
    memory.previous.events = [
      {
        type: 'ROOM_ANNOUNCED_FINISHED',
        createdAt: new Date('2026-08-07T07:00:00.000Z'),
      },
    ];
    memory.previous.phase = 'FINISHED';
    memory.previous.cancelReason = null;
    memory.previous.isContinued = false;
    memory.previous.continuationUsed = false;
    memory.startRound.mockReset();
    memory.startRound.mockResolvedValue({
      id: 'round-2',
      roomId: 'room-1',
      phase: RoundPhase.BANKER_BID,
    });
    memory.appendSystemChatOnce.mockReset();
    memory.appendSystemChatOnce.mockResolvedValue({ id: 'notice-1' });
    memory.ensureRoundAnnouncement.mockReset();
    memory.ensureRoundAnnouncement.mockResolvedValue(undefined);
    memory.rebroadcastRoomState.mockReset();
    memory.rebroadcastRoomState.mockResolvedValue(undefined);
    memory.bankerContinuationFunding.mockReset();
    memory.bankerContinuationFunding.mockResolvedValue({
      requiredCents: 50_000n,
      availableCents: 100_000n,
      sufficient: true,
      autoFundableVirtual: false,
    });
    memory.rejectInsufficientContinuation.mockReset();
    memory.rejectInsufficientContinuation.mockResolvedValue(undefined);
    memory.scheduleVirtualContinuationForRound.mockReset();
    memory.scheduleVirtualContinuationForRound.mockResolvedValue(undefined);
    memory.transition.mockReset();
    memory.activeRounds.length = 0;
    memory.pendingPackets.length = 0;
    memory.cancelBankerDiceTimeout.mockReset();
    memory.cancelBankerDiceTimeout.mockResolvedValue(false);
    memory.finalizeInternalRound.mockReset();
    memory.finalizeInternalRound.mockResolvedValue(true);
  });

  it('手动单局模式下，当前局结束后不再启动下一局', async () => {
    memory.autoStart = false;
    memory.startMode = 'MANUAL';
    const scheduler = new RoundScheduler();
    await scheduler.tick();

    expect(memory.appendSystemChatOnce).not.toHaveBeenCalled();
    expect(memory.startRound).not.toHaveBeenCalled();
    expect(memory.transition).not.toHaveBeenCalled();
  });

  it('结束游戏后当前局可收尾，但下一局保持等待', async () => {
    memory.autoStart = false;
    memory.startMode = 'STOPPED';
    const scheduler = new RoundScheduler();
    await scheduler.tick();

    expect(memory.ensureRoundAnnouncement).not.toHaveBeenCalled();
    expect(memory.startRound).not.toHaveBeenCalled();
  });

  it('全群禁言时即使保持自动模式也不会开启下一局', async () => {
    memory.chatMutedAt = new Date('2026-08-07T07:00:10.000Z');
    const scheduler = new RoundScheduler();
    await scheduler.tick();

    expect(memory.startRound).not.toHaveBeenCalled();
    expect(memory.scheduleVirtualContinuationForRound).not.toHaveBeenCalled();
  });

  it('自动连续模式下，续庄超时后进入下一局公开竞标', async () => {
    const scheduler = new RoundScheduler();
    await scheduler.tick();

    expect(memory.appendSystemChatOnce).toHaveBeenCalledWith(
      'room-1',
      'round:round-1:continuation:expired',
      '【续庄确认超时】\n庄家未在规定时间内确认，下一局转入公开竞标。',
      { force: true },
    );
    expect(memory.startRound).toHaveBeenCalledWith(
      'round-2',
      false,
      undefined,
      'AUTO',
    );
  });

  it('续庄窗口尚未结束时继续等待，不提前公开竞标', async () => {
    memory.previous.events = [
      {
        type: 'ROOM_ANNOUNCED_FINISHED',
        createdAt: new Date('2026-08-07T07:00:10.000Z'),
      },
    ];
    const scheduler = new RoundScheduler();
    await scheduler.tick();

    expect(memory.startRound).not.toHaveBeenCalled();
    expect(memory.appendSystemChatOnce).not.toHaveBeenCalled();
    expect(memory.scheduleVirtualContinuationForRound).toHaveBeenCalledWith(
      'room-1',
      'round-1',
    );
  });

  it('成绩单完成事件落库前不启动续庄计时或公开竞标', async () => {
    memory.previous.events = [];
    const scheduler = new RoundScheduler();
    await scheduler.tick();

    expect(memory.bankerContinuationFunding).not.toHaveBeenCalled();
    expect(memory.startRound).not.toHaveBeenCalled();
    expect(memory.ensureRoundAnnouncement).toHaveBeenCalledWith({
      roundId: 'round-1',
      roomId: 'room-1',
      to: RoundPhase.FINISHED,
    });
    expect(memory.rebroadcastRoomState).toHaveBeenCalledWith({
      roomId: 'room-1',
      roundId: 'round-2',
      phase: RoundPhase.WAITING,
    });
  });

  it('真人庄余额不足时发送幂等提示并立即转公开竞标', async () => {
    memory.previous.events = [
      {
        type: 'ROOM_ANNOUNCED_FINISHED',
        createdAt: new Date('2026-08-07T07:00:10.000Z'),
      },
    ];
    memory.bankerContinuationFunding.mockResolvedValue({
      requiredCents: 80_000n,
      availableCents: 10_000n,
      sufficient: false,
      autoFundableVirtual: false,
    });

    const scheduler = new RoundScheduler();
    await scheduler.tick();

    expect(memory.rejectInsufficientContinuation).toHaveBeenCalledWith({
      previousRoundId: 'round-1',
      requiredCents: 80_000n,
      availableCents: 10_000n,
    });
    expect(memory.startRound).not.toHaveBeenCalled();
  });

  it('余额不足已落拒绝事件后即使随后入账也继续公开竞标', async () => {
    memory.previous.events = [
      {
        type: 'ROOM_ANNOUNCED_FINISHED',
        createdAt: new Date('2026-08-07T07:00:10.000Z'),
      },
      {
        type: 'CONTINUATION_REJECTED_INSUFFICIENT',
        createdAt: new Date('2026-08-07T07:00:11.000Z'),
      },
    ];

    const scheduler = new RoundScheduler();
    await scheduler.tick();

    expect(memory.bankerContinuationFunding).not.toHaveBeenCalled();
    expect(memory.rejectInsufficientContinuation).toHaveBeenCalledWith({
      previousRoundId: 'round-1',
    });
    expect(memory.startRound).not.toHaveBeenCalled();
  });

  it('可自动补款的虚拟庄余额不足时保留窗口给自动续庄', async () => {
    memory.previous.events = [
      {
        type: 'ROOM_ANNOUNCED_FINISHED',
        createdAt: new Date('2026-08-07T07:00:10.000Z'),
      },
    ];
    memory.bankerContinuationFunding.mockResolvedValue({
      requiredCents: 80_000n,
      availableCents: 10_000n,
      sufficient: false,
      autoFundableVirtual: true,
    });

    const scheduler = new RoundScheduler();
    await scheduler.tick();

    expect(memory.rejectInsufficientContinuation).not.toHaveBeenCalled();
    expect(memory.scheduleVirtualContinuationForRound).toHaveBeenCalledWith(
      'room-1',
      'round-1',
    );
    expect(memory.startRound).not.toHaveBeenCalled();
  });

  it('庄家重推取消后，即使自动开局关闭也会启动替代局', async () => {
    memory.autoStart = false;
    memory.startMode = 'MANUAL';
    memory.previous.phase = 'CANCELLED';
    memory.previous.cancelReason = '庄家重推';

    const scheduler = new RoundScheduler();
    await scheduler.tick();

    expect(memory.startRound).toHaveBeenCalledWith(
      'round-2',
      false,
      undefined,
      'REPLACEMENT',
    );
    expect(memory.transition).toHaveBeenCalledWith({
      roundId: 'round-2',
      roomId: 'room-1',
      from: RoundPhase.WAITING,
      to: RoundPhase.BANKER_BID,
    });
  });

  it('庄家 15 秒未投骰时触发自动取消', async () => {
    memory.pendingPackets.push({
      id: 'round-dice-timeout',
      roomId: 'room-1',
      configSnapshot: {},
      room: { gameCode: 'SUPREME_NIUNIU' },
      packet: null,
      events: [
        {
          type: 'BANKER_REPOST_WINDOW',
          payload: { endsAt: '2026-08-07T07:00:05.000Z' },
        },
      ],
    });
    memory.cancelBankerDiceTimeout.mockResolvedValue(true);

    const scheduler = new RoundScheduler();
    await scheduler.tick();

    expect(memory.cancelBankerDiceTimeout).toHaveBeenCalledWith({
      roundId: 'round-dice-timeout',
      roomId: 'room-1',
      now: new Date('2026-08-07T07:00:20.000Z'),
    });
  });

  it('CLAIM_EXPIRED 内部局结算失败后会在后续 tick 重试', async () => {
    memory.activeRounds.push({
      id: 'round-stuck',
      roomId: 'room-1',
      phase: RoundPhase.CLAIM_EXPIRED,
      packet: { id: 'packet-stuck', channel: 'INTERNAL' },
      events: [],
    });
    memory.finalizeInternalRound
      .mockRejectedValueOnce(new Error('TRANSIENT_DB_ERROR'))
      .mockResolvedValueOnce(true);
    const scheduler = new RoundScheduler();

    await scheduler.tick();
    await scheduler.tick();

    expect(memory.finalizeInternalRound).toHaveBeenCalledTimes(2);
    expect(memory.finalizeInternalRound).toHaveBeenNthCalledWith(1, 'round-stuck');
    expect(memory.finalizeInternalRound).toHaveBeenNthCalledWith(2, 'round-stuck');
  });
});
