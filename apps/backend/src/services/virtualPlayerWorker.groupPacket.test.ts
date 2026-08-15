import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    virtualPlayer: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    groupPacket: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    round: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    room: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
  },
  claimGroupPacket: vi.fn(),
  appendChat: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({ prisma: mocks.prisma }));
vi.mock('./groupPacket.js', () => ({ claimGroupPacket: mocks.claimGroupPacket }));
vi.mock('./roomHub.js', () => ({ appendChat: mocks.appendChat }));
vi.mock('./gameBus.js', () => ({ gameBus: { on: vi.fn(), transition: vi.fn() } }));
vi.mock('./gameSettings.js', () => ({
  getGameSettings: vi.fn(),
  parseSettingsSnapshot: vi.fn(),
}));
vi.mock('./bidAuction.js', () => ({ announceBidPlaced: vi.fn() }));
vi.mock('./chatCommands.js', () => ({ runBankerDiceCeremony: vi.fn() }));
vi.mock('./virtualPlayers.js', () => ({
  listEnabledVirtualsForRoom: vi.fn(async () =>
    mocks.prisma.virtualPlayer.findMany(),
  ),
  topUpVirtualIfNeeded: vi.fn(),
}));

import { scheduleVirtualGroupPacketClaims } from './virtualPlayerWorker.js';

function virtualProfile(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    userId,
    canClaimGroupPacket: true,
    canChat: false,
    user: {
      id: userId,
      uid: `uid-${userId}`,
      nickname: userId,
      avatarUrl: null,
      roomMemberships: [{ roomId: 'room-1', status: 'ACTIVE' }],
    },
    ...overrides,
  };
}

describe('虚拟玩家抢群红包', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.99); // 不触发“跳过”和“感谢发言”
    mocks.prisma.groupPacket.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      remainingCount: 5,
      expiresAt: new Date(Date.now() + 60_000),
    });
    mocks.prisma.virtualPlayer.findUnique.mockResolvedValue({
      enabled: true,
      canClaimGroupPacket: true,
      canChat: false,
    });
    mocks.claimGroupPacket.mockResolvedValue({ amountCents: 10n });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('为具备能力的虚拟玩家排队抢包，发送者除外', async () => {
    mocks.prisma.virtualPlayer.findMany.mockResolvedValue([
      virtualProfile('vp-1'),
      virtualProfile('vp-2'),
      virtualProfile('sender'),
    ]);

    scheduleVirtualGroupPacketClaims({
      roomId: 'room-1',
      packetId: 'packet-1',
      senderId: 'sender',
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mocks.claimGroupPacket).toHaveBeenCalledTimes(2);
    const claimedBy = mocks.claimGroupPacket.mock.calls.map(
      (call) => (call[0] as { userId: string }).userId,
    );
    expect(claimedBy).not.toContain('sender');
  });

  it('跳过未开启抢包能力或不在群内的虚拟玩家', async () => {
    mocks.prisma.virtualPlayer.findMany.mockResolvedValue([
      virtualProfile('vp-off', { canClaimGroupPacket: false }),
      virtualProfile('vp-out', {
        user: {
          id: 'vp-out',
          uid: 'uid-vp-out',
          nickname: 'vp-out',
          avatarUrl: null,
          roomMemberships: [],
        },
      }),
    ]);

    scheduleVirtualGroupPacketClaims({
      roomId: 'room-1',
      packetId: 'packet-2',
      senderId: 'sender',
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mocks.claimGroupPacket).not.toHaveBeenCalled();
  });

  it('红包已抢完或玩家被停用时放弃领取', async () => {
    mocks.prisma.virtualPlayer.findMany.mockResolvedValue([
      virtualProfile('vp-1'),
      virtualProfile('vp-2'),
    ]);
    // vp 复查：第一次返回已停用，第二次正常
    mocks.prisma.virtualPlayer.findUnique
      .mockResolvedValueOnce({ enabled: false, canClaimGroupPacket: true, canChat: false })
      .mockResolvedValueOnce({ enabled: true, canClaimGroupPacket: true, canChat: false });
    // 红包状态：第一次正常，第二次已抢完
    mocks.prisma.groupPacket.findUnique
      .mockResolvedValueOnce({
        status: 'ACTIVE',
        remainingCount: 1,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .mockResolvedValueOnce({
        status: 'FINISHED',
        remainingCount: 0,
        expiresAt: new Date(Date.now() + 60_000),
      });

    scheduleVirtualGroupPacketClaims({
      roomId: 'room-1',
      packetId: 'packet-3',
      senderId: 'sender',
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mocks.claimGroupPacket).not.toHaveBeenCalled();
  });
});
