import {
  AccountType,
  GroupPacketFundingSource,
  LedgerDirection,
} from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    groupPacket: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    gameAdminActionLog: { create: vi.fn() },
  };
  return {
    tx,
    prismaPacket: { findUnique: vi.fn(), findMany: vi.fn() },
    verifyPin: vi.fn(),
    assertPinVersion: vi.fn(),
    requireAssignment: vi.fn(),
    requireAssignmentInTx: vi.fn(),
    ensureBudget: vi.fn(),
    postBudget: vi.fn(),
    postWallet: vi.fn(),
    transfer: vi.fn(),
  };
});

vi.mock('../lib/prisma.js', () => ({
  prisma: { groupPacket: mocks.prismaPacket },
}));
vi.mock('../lib/transaction.js', () => ({
  serializable: vi.fn(async (work: (tx: typeof mocks.tx) => unknown) => work(mocks.tx)),
}));
vi.mock('./paymentPin.js', () => ({
  verifyPaymentPin: mocks.verifyPin,
  assertPaymentPinVersion: mocks.assertPinVersion,
}));
vi.mock('./gameAdmin.js', () => ({
  requireGameAdminAssignment: mocks.requireAssignment,
  requireGameAdminAssignmentInTx: mocks.requireAssignmentInTx,
}));
vi.mock('./gameBudget.js', () => ({
  ensureGameBudgetAccount: mocks.ensureBudget,
  postGameBudget: mocks.postBudget,
}));
vi.mock('./wallet.js', () => ({
  post: mocks.postWallet,
  transfer: mocks.transfer,
}));

import {
  expireGroupPackets,
  randomShare,
  sendGameBudgetPacket,
} from './groupPacket.js';

const assignment = {
  id: 'assignment-1',
  room: { id: 'room-1', gameCode: 'NIUNIU', title: '牛牛', status: 'ACTIVE' },
  user: {
    id: 'user-1',
    uid: '10001',
    nickname: '管理员',
    avatarUrl: null,
    status: 'ACTIVE',
    kind: 'HUMAN',
  },
  permissions: ['SEND_BUDGET_PACKET'],
  status: 'ACTIVE',
  gameCode: 'NIUNIU',
  userId: 'user-1',
};

const params = {
  gameCode: 'NIUNIU',
  userId: 'user-1',
  totalCents: 8_800n,
  count: 8,
  mode: 'RANDOM' as const,
  greeting: '管理员送福利',
  requestId: '018f4a1f-7788-7abb-8c99-123456789abc',
  paymentPin: '482907',
};

const packet = {
  id: 'packet-budget-1',
  roomId: 'room-1',
  senderId: 'user-1',
  requestId: params.requestId,
  totalCents: params.totalCents,
  count: params.count,
  remainingCents: params.totalCents,
  remainingCount: params.count,
  mode: params.mode,
  greeting: params.greeting,
  fundingSource: GroupPacketFundingSource.GAME_BUDGET,
  budgetAccountId: 'budget-1',
  gameAdminAssignmentId: assignment.id,
  status: 'ACTIVE',
  expiresAt: new Date(Date.now() + 60_000),
  createdAt: new Date(),
};

describe('游戏预算红包资金闭环', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prismaPacket.findUnique.mockResolvedValue(null);
    mocks.prismaPacket.findMany.mockResolvedValue([]);
    mocks.tx.groupPacket.findUnique.mockResolvedValue(null);
    mocks.tx.groupPacket.create.mockResolvedValue(packet);
    mocks.tx.groupPacket.update.mockResolvedValue(packet);
    mocks.requireAssignment.mockResolvedValue(assignment);
    mocks.requireAssignmentInTx.mockResolvedValue(assignment);
    mocks.verifyPin.mockResolvedValue(7);
    mocks.assertPinVersion.mockResolvedValue(undefined);
    mocks.ensureBudget.mockResolvedValue({
      id: 'budget-1',
      gameCode: 'NIUNIU',
      balanceCents: 20_000n,
    });
    mocks.postBudget.mockResolvedValue({ balanceCents: 11_200n, duplicate: false });
    mocks.postWallet.mockResolvedValue(undefined);
    mocks.tx.gameAdminActionLog.create.mockResolvedValue({});
  });

  it('同一事务重验授权和支付密码版本，再从游戏预算扣款并进入平台托管', async () => {
    const result = await sendGameBudgetPacket(params);

    expect(result).toMatchObject({ packet, duplicate: false });
    expect(mocks.requireAssignmentInTx).toHaveBeenCalledWith(mocks.tx, {
      userId: params.userId,
      gameCode: params.gameCode,
      permission: 'SEND_BUDGET_PACKET',
    });
    expect(mocks.assertPinVersion).toHaveBeenCalledWith(mocks.tx, params.userId, 7);
    expect(mocks.postBudget).toHaveBeenCalledWith(
      mocks.tx,
      expect.objectContaining({
        direction: LedgerDirection.DEBIT,
        amountCents: params.totalCents,
        refType: 'group_packet_create',
        gameAdminAssignmentId: assignment.id,
      }),
    );
    expect(mocks.postWallet).toHaveBeenCalledWith(
      mocks.tx,
      expect.objectContaining({
        accountType: AccountType.PLATFORM_RESERVE,
        direction: LedgerDirection.CREDIT,
        amountCents: params.totalCents,
      }),
    );
    expect(mocks.tx.gameAdminActionLog.create).toHaveBeenCalledOnce();
  });

  it('相同请求重放原红包，不再次验密或扣减预算', async () => {
    mocks.prismaPacket.findUnique.mockResolvedValue(packet);

    await expect(sendGameBudgetPacket(params)).resolves.toMatchObject({
      packet,
      duplicate: true,
    });
    expect(mocks.verifyPin).not.toHaveBeenCalled();
    expect(mocks.postBudget).not.toHaveBeenCalled();
    expect(mocks.postWallet).not.toHaveBeenCalled();
  });

  it('同一请求号改变金额时拒绝重放', async () => {
    mocks.prismaPacket.findUnique.mockResolvedValue(packet);

    await expect(
      sendGameBudgetPacket({ ...params, totalCents: 9_900n }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('预算红包过期后从平台托管原路退回游戏预算，不进入发送者钱包', async () => {
    const expired = {
      ...packet,
      remainingCents: 3_300n,
      remainingCount: 3,
      expiresAt: new Date(Date.now() - 1),
    };
    mocks.prismaPacket.findMany.mockResolvedValue([expired]);
    mocks.tx.groupPacket.findUnique.mockResolvedValue(expired);

    await expireGroupPackets();

    expect(mocks.postWallet).toHaveBeenCalledWith(
      mocks.tx,
      expect.objectContaining({
        accountType: AccountType.PLATFORM_RESERVE,
        direction: LedgerDirection.DEBIT,
        amountCents: 3_300n,
        refType: 'group_packet_refund',
      }),
    );
    expect(mocks.postBudget).toHaveBeenCalledWith(
      mocks.tx,
      expect.objectContaining({
        direction: LedgerDirection.CREDIT,
        amountCents: 3_300n,
        budgetAccountId: 'budget-1',
      }),
    );
    expect(mocks.transfer).not.toHaveBeenCalled();
  });

  it('事务内支付密码版本变化时拒绝发包且不扣预算', async () => {
    mocks.assertPinVersion.mockRejectedValue(
      Object.assign(new Error('PAYMENT_PIN_CHANGED'), { code: 'PAYMENT_PIN_CHANGED' }),
    );

    await expect(sendGameBudgetPacket(params)).rejects.toMatchObject({
      code: 'PAYMENT_PIN_CHANGED',
    });
    expect(mocks.postBudget).not.toHaveBeenCalled();
    expect(mocks.postWallet).not.toHaveBeenCalled();
    expect(mocks.tx.groupPacket.create).not.toHaveBeenCalled();
  });

  it('超出 crypto.randomInt 范围的大额拼手气红包仍能安全拆分', () => {
    const remaining = 9_000_000_000_000_000_000n;
    for (let index = 0; index < 20; index += 1) {
      const share = randomShare(remaining, 50);
      expect(share).toBeGreaterThanOrEqual(1n);
      expect(share).toBeLessThanOrEqual((remaining / 50n) * 2n);
      expect(remaining - share).toBeGreaterThanOrEqual(49n);
    }
  });
});
