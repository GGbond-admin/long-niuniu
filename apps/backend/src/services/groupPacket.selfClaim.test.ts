import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    user: { findUnique: vi.fn() },
    groupPacket: { findUnique: vi.fn(), update: vi.fn() },
    groupPacketClaim: { findUnique: vi.fn(), create: vi.fn() },
  };
  return {
    tx,
    transfer: vi.fn(),
  };
});

vi.mock('../lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../lib/transaction.js', () => ({
  serializable: vi.fn(async (run: (tx: typeof mocks.tx) => unknown) => run(mocks.tx)),
}));
vi.mock('./wallet.js', () => ({ transfer: mocks.transfer }));

import { claimGroupPacket, GROUP_PACKET_EXPIRE_MS } from './groupPacket.js';

describe('普通红包发送者领取', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tx.groupPacket.findUnique.mockResolvedValue({
      id: 'packet-1',
      roomId: 'room-1',
      senderId: 'sender-1',
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 60_000),
      mode: 'EQUAL',
      remainingCents: 100n,
      remainingCount: 2,
    });
    mocks.tx.user.findUnique.mockResolvedValue({
      id: 'sender-1',
      status: 'ACTIVE',
      kyc: { status: 'APPROVED' },
      wallet: {},
      roomMemberships: [{ status: 'ACTIVE' }],
    });
    mocks.tx.groupPacketClaim.findUnique.mockResolvedValue(null);
    mocks.tx.groupPacketClaim.create.mockResolvedValue({
      id: 'claim-1',
      packetId: 'packet-1',
      userId: 'sender-1',
      amountCents: 50n,
    });
    mocks.tx.groupPacket.update.mockResolvedValue({});
    mocks.transfer.mockResolvedValue(undefined);
  });

  it('允许发送者领取自己发出的普通红包并入账', async () => {
    const result = await claimGroupPacket({ packetId: 'packet-1', userId: 'sender-1' });

    expect(result).toEqual({
      amountCents: 50n,
      finished: false,
      roomId: 'room-1',
      senderId: 'sender-1',
    });
    expect(mocks.tx.groupPacketClaim.create).toHaveBeenCalledWith({
      data: { packetId: 'packet-1', userId: 'sender-1', amountCents: 50n },
    });
    expect(mocks.transfer).toHaveBeenCalledWith(
      mocks.tx,
      expect.objectContaining({
        amountCents: 50n,
        to: { userId: 'sender-1', accountType: 'USER_AVAILABLE' },
      }),
    );
  });

  it('普通红包有效期为 24 小时', () => {
    expect(GROUP_PACKET_EXPIRE_MS).toBe(24 * 60 * 60 * 1_000);
  });
});
