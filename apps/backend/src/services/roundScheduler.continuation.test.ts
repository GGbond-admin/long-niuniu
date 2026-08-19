import { RoundPhase } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({
  autoStart: false,
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
  },
  startRound: vi.fn(),
  appendSystemChatOnce: vi.fn(),
  transition: vi.fn(),
  activeRounds: [] as Array<Record<string, unknown>>,
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
      findMany: vi.fn(async ({ where }: { where?: { phase?: { in?: string[] } } }) =>
        where?.phase?.in ? memory.activeRounds : [],
      ),
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
        { id: 'room-1', gameCode: 'SUPREME_NIUNIU' },
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
  startRound: memory.startRound,
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
      assistantEnabled: true,
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
  ensureRoundAnnouncement: vi.fn(),
  rebroadcastRoomState: vi.fn(),
  systemChat: vi.fn(),
}));

vi.mock('./virtualPlayerWorker.js', () => ({
  scheduleVirtualDiceForRound: vi.fn(),
}));

import { RoundScheduler } from './roundScheduler.js';

describe('续庄窗口结束后的调度', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T07:00:20.000Z'));
    memory.autoStart = false;
    memory.previous.finishedAt = new Date('2026-08-07T07:00:00.000Z');
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
    memory.transition.mockReset();
    memory.activeRounds.length = 0;
    memory.finalizeInternalRound.mockReset();
    memory.finalizeInternalRound.mockResolvedValue(true);
  });

  it('自动开局关闭时，15 秒续庄超时仍转入公开竞标', async () => {
    const scheduler = new RoundScheduler();
    await scheduler.tick();

    expect(memory.appendSystemChatOnce).toHaveBeenCalledWith(
      'room-1',
      'round:round-1:continuation:expired',
      '【续庄确认超时】\n庄家未在规定时间内确认，下一局转入公开竞标。',
    );
    expect(memory.startRound).toHaveBeenCalledWith('round-2');
    expect(memory.transition).toHaveBeenCalledWith({
      roundId: 'round-2',
      roomId: 'room-1',
      from: RoundPhase.WAITING,
      to: RoundPhase.BANKER_BID,
    });
  });

  it('续庄窗口尚未结束时继续等待，不提前公开竞标', async () => {
    memory.previous.finishedAt = new Date('2026-08-07T07:00:10.000Z');
    const scheduler = new RoundScheduler();
    await scheduler.tick();

    expect(memory.startRound).not.toHaveBeenCalled();
    expect(memory.appendSystemChatOnce).not.toHaveBeenCalled();
  });

  it('庄家重推取消后，即使自动开局关闭也会启动替代局', async () => {
    memory.previous.phase = 'CANCELLED';
    memory.previous.cancelReason = '庄家重推';

    const scheduler = new RoundScheduler();
    await scheduler.tick();

    expect(memory.startRound).toHaveBeenCalledWith('round-2');
    expect(memory.transition).toHaveBeenCalledWith({
      roundId: 'round-2',
      roomId: 'room-1',
      from: RoundPhase.WAITING,
      to: RoundPhase.BANKER_BID,
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
