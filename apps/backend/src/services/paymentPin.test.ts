import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const paymentPin = {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  };
  const queryRaw = vi.fn();
  const transaction = vi.fn(
    async (
      run: (tx: {
        paymentPin: typeof paymentPin;
        $queryRaw: typeof queryRaw;
      }) => unknown,
    ) => run({ paymentPin, $queryRaw: queryRaw }),
  );
  return {
    paymentPin,
    queryRaw,
    transaction,
    hash: vi.fn(),
    compare: vi.fn(),
  };
});

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    paymentPin: mocks.paymentPin,
    $transaction: mocks.transaction,
  },
}));
vi.mock('bcryptjs', () => ({
  hash: mocks.hash,
  compare: mocks.compare,
}));

import {
  PAYMENT_PIN_MAX_FAILURES,
  PaymentPinError,
  assertPaymentPinVersion,
  hashPaymentPin,
  isWeakPaymentPin,
  setPaymentPin,
  verifyPaymentPin,
} from './paymentPin.js';

const credential = {
  userId: 'user-1',
  hash: '$2b$12$stored',
  isSet: true,
  failedAttempts: 0,
  lockedUntil: null,
  version: 1,
  setAt: new Date('2026-08-07T00:00:00Z'),
  updatedAt: new Date('2026-08-07T00:00:00Z'),
};

describe('支付密码安全服务', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.paymentPin.findUnique.mockResolvedValue(credential);
    mocks.paymentPin.updateMany.mockResolvedValue({ count: 1 });
    mocks.queryRaw.mockResolvedValue([{ user_id: 'user-1' }]);
    mocks.paymentPin.update.mockImplementation(async ({ data }: { data: object }) => ({
      ...credential,
      ...data,
    }));
    mocks.paymentPin.create.mockResolvedValue(credential);
    mocks.hash.mockResolvedValue('$2b$12$new');
    mocks.compare.mockResolvedValue(true);
  });

  it('拒绝重复数字和常见顺序密码', () => {
    for (const pin of ['000000', '111111', '123456', '654321', '012345', '987654']) {
      expect(isWeakPaymentPin(pin)).toBe(true);
    }
    expect(isWeakPaymentPin('482907')).toBe(false);
  });

  it('使用用户隔离后的摘要材料进行 bcrypt 哈希', async () => {
    await expect(hashPaymentPin('user-1', '482907')).resolves.toBe('$2b$12$new');
    expect(mocks.hash).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{64}$/), 12);
  });

  it('实名用户首次设置强支付密码', async () => {
    mocks.paymentPin.findUnique.mockResolvedValue(null);
    await setPaymentPin('user-1', '482907');
    expect(mocks.paymentPin.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        hash: '$2b$12$new',
        isSet: true,
        failedAttempts: 0,
        lockedUntil: null,
      }),
    });
  });

  it('重置后重设沿用凭证行并递增版本', async () => {
    mocks.paymentPin.findUnique.mockResolvedValue({
      ...credential,
      isSet: false,
      version: 2,
    });

    await setPaymentPin('user-1', '482907');

    expect(mocks.paymentPin.create).not.toHaveBeenCalled();
    expect(mocks.paymentPin.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: expect.objectContaining({
        hash: '$2b$12$new',
        isSet: true,
        version: { increment: 1 },
      }),
    });
  });

  it('正确密码会清除历史失败次数', async () => {
    mocks.paymentPin.findUnique.mockResolvedValue({
      ...credential,
      failedAttempts: 2,
    });
    mocks.compare.mockResolvedValue(true);

    await expect(verifyPaymentPin('user-1', '482907')).resolves.toBe(1);
    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.compare.mock.invocationCallOrder[0]!,
    );
    expect(mocks.paymentPin.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { failedAttempts: 0, lockedUntil: null },
    });
  });

  it('第五次失败后锁定十五分钟', async () => {
    mocks.paymentPin.findUnique.mockResolvedValue({
      ...credential,
      failedAttempts: PAYMENT_PIN_MAX_FAILURES - 1,
    });
    mocks.compare.mockResolvedValue(false);

    await expect(verifyPaymentPin('user-1', '000001')).rejects.toMatchObject<
      Partial<PaymentPinError>
    >({
      code: 'PAYMENT_PIN_LOCKED',
    });
    expect(mocks.paymentPin.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: {
        failedAttempts: PAYMENT_PIN_MAX_FAILURES,
        lockedUntil: expect.any(Date),
      },
    });
  });

  it('锁定期结束后重新计算失败次数', async () => {
    mocks.paymentPin.findUnique.mockResolvedValue({
      ...credential,
      failedAttempts: PAYMENT_PIN_MAX_FAILURES,
      lockedUntil: new Date(Date.now() - 1_000),
    });
    mocks.compare.mockResolvedValue(false);

    await expect(verifyPaymentPin('user-1', '000001')).rejects.toMatchObject({
      code: 'PAYMENT_PIN_INVALID',
      details: { remainingAttempts: PAYMENT_PIN_MAX_FAILURES - 1 },
    });
    expect(mocks.paymentPin.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { failedAttempts: 1, lockedUntil: null },
    });
  });

  it('资金事务拒绝已经变化的支付密码版本', async () => {
    mocks.paymentPin.findUnique.mockResolvedValue({
      ...credential,
      version: 2,
    });

    await expect(
      assertPaymentPinVersion(
        {
          paymentPin: mocks.paymentPin,
          $queryRaw: mocks.queryRaw,
        } as never,
        'user-1',
        1,
      ),
    ).rejects.toMatchObject({
      code: 'PAYMENT_PIN_CHANGED',
    });
  });
});
