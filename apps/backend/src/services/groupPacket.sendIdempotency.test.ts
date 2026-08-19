import { GroupPacketFundingSource } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    user: { findUnique: vi.fn() },
    groupPacket: { findUnique: vi.fn(), create: vi.fn() },
  };
  return {
    tx,
    prismaGroupPacket: { findUnique: vi.fn() },
    transfer: vi.fn(),
    verifyPaymentPin: vi.fn(),
    assertPaymentPinVersion: vi.fn(),
  };
});

vi.mock('../lib/prisma.js', () => ({
  prisma: { groupPacket: mocks.prismaGroupPacket },
}));
vi.mock('../lib/transaction.js', () => ({
  serializable: vi.fn(async (run: (tx: typeof mocks.tx) => unknown) => run(mocks.tx)),
}));
vi.mock('./wallet.js', () => ({ transfer: mocks.transfer }));
vi.mock('./paymentPin.js', () => ({
  verifyPaymentPin: mocks.verifyPaymentPin,
  assertPaymentPinVersion: mocks.assertPaymentPinVersion,
}));

import { sendGroupPacket } from './groupPacket.js';

const params = {
  roomId: 'room-1',
  userId: 'user-1',
  totalCents: 5_000n,
  count: 5,
  mode: 'RANDOM' as const,
  greeting: '恭喜发财',
  requestId: '018f4a1f-7788-7abb-8c99-123456789abc',
  paymentPin: '482907',
};

const packet = {
  id: 'packet-1',
  roomId: params.roomId,
  senderId: params.userId,
  requestId: params.requestId,
  totalCents: params.totalCents,
  count: params.count,
  remainingCents: params.totalCents,
  remainingCount: params.count,
  mode: params.mode,
  greeting: params.greeting,
  fundingSource: GroupPacketFundingSource.USER_WALLET,
  budgetAccountId: null,
  gameAdminAssignmentId: null,
  status: 'ACTIVE',
  expiresAt: new Date(Date.now() + 60_000),
  createdAt: new Date(),
};

describe('发群红包支付验证与幂等', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prismaGroupPacket.findUnique.mockResolvedValue(null);
    mocks.tx.groupPacket.findUnique.mockResolvedValue(null);
    mocks.tx.groupPacket.create.mockResolvedValue(packet);
    mocks.tx.user.findUnique.mockResolvedValue({
      id: params.userId,
      status: 'ACTIVE',
      kyc: { status: 'APPROVED' },
      wallet: {},
      roomMemberships: [{ status: 'ACTIVE' }],
    });
    mocks.verifyPaymentPin.mockResolvedValue(1);
    mocks.assertPaymentPinVersion.mockResolvedValue(undefined);
    mocks.transfer.mockResolvedValue(undefined);
  });

  it('新红包先验证支付密码并只扣款一次', async () => {
    const result = await sendGroupPacket(params);

    expect(result).toEqual({ packet, duplicate: false });
    expect(mocks.verifyPaymentPin).toHaveBeenCalledWith(params.userId, params.paymentPin);
    expect(mocks.assertPaymentPinVersion).toHaveBeenCalledWith(
      mocks.tx,
      params.userId,
      1,
    );
    expect(mocks.tx.groupPacket.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        senderId: params.userId,
        requestId: params.requestId,
      }),
    });
    expect(mocks.transfer).toHaveBeenCalledTimes(1);
  });

  it('相同请求重放直接返回原红包且不再次验密扣款', async () => {
    mocks.prismaGroupPacket.findUnique.mockResolvedValue(packet);

    const result = await sendGroupPacket(params);

    expect(result).toEqual({ packet, duplicate: true });
    expect(mocks.verifyPaymentPin).not.toHaveBeenCalled();
    expect(mocks.assertPaymentPinVersion).not.toHaveBeenCalled();
    expect(mocks.transfer).not.toHaveBeenCalled();
  });

  it('拒绝用相同请求号更改红包金额', async () => {
    mocks.prismaGroupPacket.findUnique.mockResolvedValue(packet);

    await expect(
      sendGroupPacket({ ...params, totalCents: 10_000n }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(mocks.verifyPaymentPin).not.toHaveBeenCalled();
    expect(mocks.transfer).not.toHaveBeenCalled();
  });

  it('被管理员禁言时拒绝个人红包且不扣款', async () => {
    mocks.tx.user.findUnique.mockResolvedValue({
      id: params.userId,
      status: 'ACTIVE',
      kyc: { status: 'APPROVED' },
      wallet: {},
      roomMemberships: [{
        status: 'ACTIVE',
        chatMutedAt: new Date(),
        chatMutedUntil: new Date(Date.now() + 60_000),
        chatMuteReason: '刷屏',
      }],
    });

    await expect(sendGroupPacket(params)).rejects.toMatchObject({
      code: 'ROOM_CHAT_MUTED',
    });
    expect(mocks.verifyPaymentPin).toHaveBeenCalledOnce();
    expect(mocks.assertPaymentPinVersion).toHaveBeenCalledOnce();
    expect(mocks.transfer).not.toHaveBeenCalled();
  });

  it('全群禁言时拒绝个人红包且不扣款', async () => {
    mocks.tx.user.findUnique.mockResolvedValue({
      id: params.userId,
      status: 'ACTIVE',
      kyc: { status: 'APPROVED' },
      wallet: {},
      roomMemberships: [{
        status: 'ACTIVE',
        room: {
          chatMutedAt: new Date(),
          chatMuteReason: '运营维护',
        },
      }],
    });

    await expect(sendGroupPacket(params)).rejects.toMatchObject({
      code: 'ROOM_GLOBAL_MUTED',
    });
    expect(mocks.verifyPaymentPin).toHaveBeenCalledOnce();
    expect(mocks.assertPaymentPinVersion).toHaveBeenCalledOnce();
    expect(mocks.transfer).not.toHaveBeenCalled();
  });
});
