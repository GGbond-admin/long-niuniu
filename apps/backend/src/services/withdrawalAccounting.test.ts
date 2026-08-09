import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transfer: vi.fn(),
}));

vi.mock('./wallet.js', () => ({ transfer: mocks.transfer }));

import { completeWithdrawalAccounting } from './withdrawalAccounting.js';

describe('提现完成账务', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transfer.mockResolvedValue(undefined);
  });

  it('将实际到账金额与手续费分别入账', async () => {
    const tx = {} as never;
    await completeWithdrawalAccounting(tx, {
      id: 'withdraw-1',
      userId: 'user-1',
      amountCents: 10_000n,
      targetSnapshot: { feeCents: '300' },
      operatorId: 'admin-1',
    });

    expect(mocks.transfer).toHaveBeenNthCalledWith(
      1,
      tx,
      expect.objectContaining({
        amountCents: 9_700n,
        from: { userId: 'user-1', accountType: 'USER_FREEZE_WITHDRAW' },
        to: { accountType: 'ADJUST_CLEARING' },
        refType: 'withdraw_complete',
        idempotencyKey: 'withdraw-complete:withdraw-1',
      }),
    );
    expect(mocks.transfer).toHaveBeenNthCalledWith(
      2,
      tx,
      expect.objectContaining({
        amountCents: 300n,
        from: { userId: 'user-1', accountType: 'USER_FREEZE_WITHDRAW' },
        to: { accountType: 'PLATFORM_FEES' },
        refType: 'withdraw_fee',
        idempotencyKey: 'withdraw-fee:withdraw-1',
      }),
    );
  });

  it('兼容没有手续费快照的历史订单', async () => {
    const tx = {} as never;
    await completeWithdrawalAccounting(tx, {
      id: 'withdraw-2',
      userId: 'user-1',
      amountCents: 10_000n,
      targetSnapshot: {},
      operatorId: 'admin-1',
    });

    expect(mocks.transfer).toHaveBeenCalledTimes(1);
    expect(mocks.transfer).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ amountCents: 10_000n, refType: 'withdraw_complete' }),
    );
  });

  it('拒绝手续费大于提现金额的异常快照', async () => {
    await expect(
      completeWithdrawalAccounting({} as never, {
        id: 'withdraw-3',
        userId: 'user-1',
        amountCents: 10_000n,
        targetSnapshot: { feeCents: '10001' },
        operatorId: 'admin-1',
      }),
    ).rejects.toThrow('INVALID_WITHDRAW_FEE');
    expect(mocks.transfer).not.toHaveBeenCalled();
  });
});
