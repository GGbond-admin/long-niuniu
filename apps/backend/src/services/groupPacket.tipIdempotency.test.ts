import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    user: { findUnique: vi.fn() },
    ledgerEntry: { findUnique: vi.fn() },
  };
  return {
    tx,
    prismaLedgerEntry: { findUnique: vi.fn() },
    transfer: vi.fn(),
    verifyPaymentPin: vi.fn(),
    assertPaymentPinVersion: vi.fn(),
  };
});

vi.mock('../lib/prisma.js', () => ({
  prisma: { ledgerEntry: mocks.prismaLedgerEntry },
}));
vi.mock('../lib/transaction.js', () => ({
  serializable: vi.fn(async (run: (tx: typeof mocks.tx) => unknown) => run(mocks.tx)),
}));
vi.mock('./wallet.js', () => ({ transfer: mocks.transfer }));
vi.mock('./paymentPin.js', () => ({
  verifyPaymentPin: mocks.verifyPaymentPin,
  assertPaymentPinVersion: mocks.assertPaymentPinVersion,
}));

import { tipSupport } from './groupPacket.js';

describe('客服打赏幂等性', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tx.user.findUnique.mockResolvedValue({
      id: 'user-1',
      uid: 'U1001',
      nickname: '玩家甲',
      status: 'ACTIVE',
      kyc: { status: 'APPROVED' },
      wallet: {},
      roomMemberships: [{ status: 'ACTIVE' }],
    });
    mocks.prismaLedgerEntry.findUnique.mockResolvedValue(null);
    mocks.tx.ledgerEntry.findUnique.mockResolvedValue(null);
    mocks.verifyPaymentPin.mockResolvedValue(1);
    mocks.assertPaymentPinVersion.mockResolvedValue(undefined);
    mocks.transfer.mockResolvedValue(undefined);
  });

  it('同一请求号使用稳定账务键', async () => {
    const result = await tipSupport({
      roomId: 'room-1',
      userId: 'user-1',
      amountCents: 5_000n,
      requestId: '018f4a1f-7788-7abb-8c99-123456789abc',
      paymentPin: '482907',
    });

    expect(result).toEqual({ duplicate: false });
    expect(mocks.verifyPaymentPin).toHaveBeenCalledWith('user-1', '482907');
    expect(mocks.assertPaymentPinVersion).toHaveBeenCalledWith(mocks.tx, 'user-1', 1);
    expect(mocks.transfer).toHaveBeenCalledWith(
      mocks.tx,
      expect.objectContaining({
        refId: '018f4a1f-7788-7abb-8c99-123456789abc',
        idempotencyKey: 'tip:user-1:018f4a1f-7788-7abb-8c99-123456789abc',
      }),
    );
  });

  it('重放同一请求时不再扣款', async () => {
    mocks.prismaLedgerEntry.findUnique.mockResolvedValue({
      id: 'ledger-1',
      amountCents: 5_000n,
    });

    const result = await tipSupport({
      roomId: 'room-1',
      userId: 'user-1',
      amountCents: 5_000n,
      requestId: '018f4a1f-7788-7abb-8c99-123456789abc',
      paymentPin: '482907',
    });

    expect(result).toEqual({ duplicate: true });
    expect(mocks.verifyPaymentPin).not.toHaveBeenCalled();
    expect(mocks.assertPaymentPinVersion).not.toHaveBeenCalled();
    expect(mocks.transfer).not.toHaveBeenCalled();
  });

  it('拒绝用同一请求号更改打赏金额', async () => {
    mocks.prismaLedgerEntry.findUnique.mockResolvedValue({
      id: 'ledger-1',
      amountCents: 5_000n,
    });

    await expect(
      tipSupport({
        roomId: 'room-1',
        userId: 'user-1',
        amountCents: 10_000n,
        requestId: '018f4a1f-7788-7abb-8c99-123456789abc',
        paymentPin: '482907',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(mocks.verifyPaymentPin).not.toHaveBeenCalled();
    expect(mocks.transfer).not.toHaveBeenCalled();
  });

  it('支付密码错误时不进入资金事务', async () => {
    mocks.verifyPaymentPin.mockRejectedValue(
      Object.assign(new Error('PAYMENT_PIN_INVALID'), { code: 'PAYMENT_PIN_INVALID' }),
    );

    await expect(
      tipSupport({
        roomId: 'room-1',
        userId: 'user-1',
        amountCents: 5_000n,
        requestId: '018f4a1f-7788-7abb-8c99-123456789abc',
        paymentPin: '000001',
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_PIN_INVALID' });
    expect(mocks.tx.user.findUnique).not.toHaveBeenCalled();
    expect(mocks.transfer).not.toHaveBeenCalled();
  });
});
