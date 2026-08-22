import { describe, expect, it, vi, beforeEach } from 'vitest';

const { tx, invalidateUserConnections } = vi.hoisted(() => {
  const user = {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  };
  const round = { count: vi.fn(), updateMany: vi.fn() };
  const bet = { count: vi.fn(), deleteMany: vi.fn() };
  const bankerBid = { count: vi.fn(), deleteMany: vi.fn() };
  const claim = { count: vi.fn(), deleteMany: vi.fn() };
  const depositOrder = { count: vi.fn(), deleteMany: vi.fn() };
  const withdrawOrder = { count: vi.fn(), deleteMany: vi.fn() };
  return {
    invalidateUserConnections: vi.fn(async () => undefined),
    tx: {
      user,
      round,
      bet,
      bankerBid,
      claim,
      depositOrder,
      withdrawOrder,
      settlement: { deleteMany: vi.fn() },
      bankerStat: { deleteMany: vi.fn() },
      rewardGrant: { deleteMany: vi.fn() },
      rebateSettlement: { deleteMany: vi.fn() },
      dailyHandProgress: { deleteMany: vi.fn() },
      turnoverDaily: { deleteMany: vi.fn() },
      pushLog: { deleteMany: vi.fn() },
      ledgerEntry: { deleteMany: vi.fn() },
      systemNoticeRead: { deleteMany: vi.fn() },
      chatMessage: { deleteMany: vi.fn() },
      groupPacket: { findMany: vi.fn(), count: vi.fn(), deleteMany: vi.fn() },
      groupPacketClaim: { deleteMany: vi.fn() },
      roomMember: { deleteMany: vi.fn() },
      withdrawAccount: { deleteMany: vi.fn() },
      agentPlayer: { deleteMany: vi.fn() },
      device: { deleteMany: vi.fn() },
      kyc: { deleteMany: vi.fn() },
      paymentPin: { deleteMany: vi.fn() },
      wallet: { deleteMany: vi.fn() },
      virtualPlayer: { deleteMany: vi.fn() },
      gameAdminActionLog: { updateMany: vi.fn() },
      room: { updateMany: vi.fn() },
      auditLog: { create: vi.fn() },
    },
  };
});

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  },
}));

vi.mock('./roomHub.js', () => ({
  invalidateUserConnections,
}));

const { purgeCustomer, CustomerPurgeError, CUSTOMER_PURGE_CONFIRM_TEXT } = await import(
  './customerPurge.js'
);

function human(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    uid: '10001',
    kind: 'HUMAN',
    nickname: '阿明',
    tgId: 99n,
    tgUsername: 'ming',
    status: 'ACTIVE',
    agentProfile: null,
    gameAdminAssignments: [],
    wallet: {
      availableCents: 0n,
      freezeBankerCents: 0n,
      freezeBetCents: 0n,
      freezeWithdrawCents: 0n,
    },
    ...overrides,
  };
}

describe('purgeCustomer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx.user.findUnique.mockResolvedValue(human());
    tx.round.count.mockResolvedValue(0);
    tx.bet.count.mockResolvedValue(0);
    tx.bankerBid.count.mockResolvedValue(0);
    tx.claim.count.mockResolvedValue(0);
    tx.depositOrder.count.mockResolvedValue(0);
    tx.withdrawOrder.count.mockResolvedValue(0);
    tx.groupPacket.count.mockResolvedValue(0);
    tx.groupPacket.findMany.mockResolvedValue([]);
    tx.user.delete.mockResolvedValue({ id: 'user-1' });
    tx.auditLog.create.mockResolvedValue({});
    for (const model of Object.values(tx)) {
      if ('deleteMany' in model && typeof model.deleteMany === 'function') {
        model.deleteMany.mockResolvedValue({ count: 0 });
      }
      if ('updateMany' in model && typeof model.updateMany === 'function') {
        model.updateMany.mockResolvedValue({ count: 0 });
      }
    }
  });

  const input = {
    userId: 'user-1',
    adminId: 'admin-1',
    confirmUid: '10001',
    confirmText: CUSTOMER_PURGE_CONFIRM_TEXT,
    reason: '客户要求注销全部资料',
  };

  it('rejects a mismatched confirmation', async () => {
    await expect(purgeCustomer({ ...input, confirmUid: '10002' })).rejects.toMatchObject({
      code: 'PURGE_CONFIRMATION_INVALID',
    });
    expect(tx.user.delete).not.toHaveBeenCalled();
  });

  it('rejects virtual players', async () => {
    tx.user.findUnique.mockResolvedValue(human({ kind: 'VIRTUAL' }));
    await expect(purgeCustomer(input)).rejects.toBeInstanceOf(CustomerPurgeError);
    await expect(purgeCustomer(input)).rejects.toMatchObject({
      code: 'VIRTUAL_USER_CANNOT_PURGE',
    });
  });

  it('rejects agents and game admins', async () => {
    tx.user.findUnique.mockResolvedValue(human({ agentProfile: { id: 'agent-1' } }));
    await expect(purgeCustomer(input)).rejects.toMatchObject({ code: 'USER_IS_AGENT' });

    tx.user.findUnique.mockResolvedValue(
      human({
        gameAdminAssignments: [{ id: 'ga-1', gameCode: 'SUPREME_NIUNIU', status: 'ACTIVE' }],
      }),
    );
    await expect(purgeCustomer(input)).rejects.toMatchObject({ code: 'USER_IS_GAME_ADMIN' });
  });

  it('rejects customers still in a live round', async () => {
    tx.bet.count.mockResolvedValue(1);
    await expect(purgeCustomer(input)).rejects.toMatchObject({ code: 'USER_IN_ACTIVE_ROUND' });
    expect(tx.user.delete).not.toHaveBeenCalled();
  });

  it('rejects customers with available balance', async () => {
    tx.user.findUnique.mockResolvedValue(
      human({
        wallet: {
          availableCents: 1_500n,
          freezeBankerCents: 0n,
          freezeBetCents: 0n,
          freezeWithdrawCents: 0n,
        },
      }),
    );
    await expect(purgeCustomer(input)).rejects.toMatchObject({
      code: 'USER_HAS_AVAILABLE_BALANCE',
    });
    expect(tx.user.delete).not.toHaveBeenCalled();
  });

  it('rejects customers with an active group packet', async () => {
    tx.groupPacket.count.mockResolvedValue(1);
    await expect(purgeCustomer(input)).rejects.toMatchObject({
      code: 'USER_HAS_ACTIVE_GROUP_PACKET',
    });
    expect(tx.user.delete).not.toHaveBeenCalled();
  });

  it('deletes owned records after both confirmations match', async () => {
    const result = await purgeCustomer(input);
    expect(result).toEqual({ id: 'user-1', uid: '10001' });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'user_purge', target: '10001' }),
      }),
    );
    expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: 'user-1' } });
    expect(invalidateUserConnections).toHaveBeenCalledWith('user-1', 'USER_PURGED');
  });
});
