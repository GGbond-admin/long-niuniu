import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const gameAdminAssignment = {
    findUnique: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  };
  const roomMember = {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findMany: vi.fn(),
  };
  const gameAdminActionLog = { findUnique: vi.fn(), create: vi.fn(), findMany: vi.fn() };
  const room = { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() };
  const user = { findUnique: vi.fn() };
  const auditLog = { create: vi.fn() };
  const tx = {
    gameAdminAssignment,
    roomMember,
    gameAdminActionLog,
    room,
    user,
    auditLog,
  };
  return {
    gameAdminAssignment,
    roomMember,
    gameAdminActionLog,
    room,
    user,
    auditLog,
    tx,
    broadcast: vi.fn(),
    systemChat: vi.fn(),
  };
});

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    gameAdminAssignment: mocks.gameAdminAssignment,
    roomMember: mocks.roomMember,
    gameAdminActionLog: mocks.gameAdminActionLog,
    room: mocks.room,
    user: mocks.user,
    auditLog: mocks.auditLog,
  },
}));
vi.mock('../lib/transaction.js', () => ({
  serializable: vi.fn(async (work: (tx: typeof mocks.tx) => unknown) => work(mocks.tx)),
}));
vi.mock('./gameBudget.js', () => ({
  getGameBudgetOverview: vi.fn(),
}));
vi.mock('./roomHub.js', () => ({
  broadcastRoomMemberModeration: mocks.broadcast,
  systemChat: mocks.systemChat,
}));

import {
  createGameAdminAssignment,
  listGameAdminMembers,
  muteGameAdminMember,
  requireGameAdminAssignment,
} from './gameAdmin.js';

const activeAssignment = {
  id: 'assignment-1',
  gameCode: 'NIUNIU',
  userId: 'admin-user',
  permissions: ['SEND_BUDGET_PACKET', 'MUTE_MEMBERS'],
  status: 'ACTIVE',
  user: {
    id: 'admin-user',
    uid: '10001',
    nickname: '管理员',
    avatarUrl: null,
    status: 'ACTIVE',
    kind: 'HUMAN',
  },
  room: {
    id: 'room-1',
    gameCode: 'NIUNIU',
    title: '牛牛互动群',
    status: 'ACTIVE',
  },
};

describe('游戏管理员实时授权边界', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gameAdminAssignment.findUnique.mockResolvedValue(activeAssignment);
    mocks.room.findUnique.mockResolvedValue({ id: 'room-1' });
    mocks.user.findUnique.mockResolvedValue({
      id: 'admin-user',
      uid: '10001',
      status: 'ACTIVE',
      kind: 'HUMAN',
      tgId: 10001n,
      kyc: { status: 'APPROVED' },
      paymentPin: { isSet: true },
    });
    mocks.gameAdminAssignment.update.mockResolvedValue(activeAssignment);
    mocks.roomMember.updateMany.mockResolvedValue({ count: 1 });
    mocks.auditLog.create.mockResolvedValue({});
    mocks.broadcast.mockResolvedValue(undefined);
  });

  it('按 userId + gameCode 精确校验，不能拿一个游戏的授权跨游戏操作', async () => {
    mocks.gameAdminAssignment.findUnique.mockImplementation(
      async ({ where }: { where: { gameCode_userId: { gameCode: string } } }) =>
        where.gameCode_userId.gameCode === 'NIUNIU' ? activeAssignment : null,
    );

    await expect(
      requireGameAdminAssignment({
        userId: 'admin-user',
        gameCode: 'BACCARAT',
        permission: 'MUTE_MEMBERS',
      }),
    ).rejects.toMatchObject({ code: 'GAME_ADMIN_ACCESS_DENIED' });
  });

  it('授权被停用后下一次请求立即失效', async () => {
    mocks.gameAdminAssignment.findUnique.mockResolvedValue({
      ...activeAssignment,
      status: 'DISABLED',
    });

    await expect(
      requireGameAdminAssignment({
        userId: 'admin-user',
        gameCode: 'NIUNIU',
      }),
    ).rejects.toMatchObject({ code: 'GAME_ADMIN_ACCESS_DENIED' });
  });

  it('缺少单项权限时拒绝对应操作', async () => {
    mocks.gameAdminAssignment.findUnique.mockResolvedValue({
      ...activeAssignment,
      permissions: ['MUTE_MEMBERS'],
    });

    await expect(
      requireGameAdminAssignment({
        userId: 'admin-user',
        gameCode: 'NIUNIU',
        permission: 'SEND_BUDGET_PACKET',
      }),
    ).rejects.toMatchObject({
      code: 'GAME_ADMIN_PERMISSION_DENIED',
      details: { permission: 'SEND_BUDGET_PACKET' },
    });
  });

  it('禁止游戏管理员禁言同游戏的另一名有效管理员', async () => {
    mocks.gameAdminAssignment.findUnique.mockImplementation(
      async ({ where }: {
        where: { gameCode_userId?: { userId: string } };
      }) =>
        where.gameCode_userId?.userId === 'target-admin'
          ? { status: 'ACTIVE' }
          : activeAssignment,
    );
    mocks.roomMember.findUnique.mockResolvedValue({
      id: 'member-2',
      status: 'ACTIVE',
      user: {
        id: 'target-admin',
        uid: '10002',
        nickname: '另一管理员',
        status: 'ACTIVE',
        kind: 'HUMAN',
      },
    });

    await expect(
      muteGameAdminMember({
        actorUserId: 'admin-user',
        gameCode: 'NIUNIU',
        targetUserId: 'target-admin',
        durationMinutes: 60,
        reason: '测试原因',
        requestId: '018f4a1f-7788-7abb-8c99-123456789abc',
      }),
    ).rejects.toMatchObject({ code: 'CANNOT_MUTE_GAME_ADMIN' });
    expect(mocks.roomMember.update).not.toHaveBeenCalled();
    expect(mocks.gameAdminActionLog.create).not.toHaveBeenCalled();
  });

  it('禁言到期后列表自动恢复，无需后台清理任务', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T08:00:00.000Z'));
    mocks.roomMember.findMany.mockResolvedValue([
      {
        id: 'member-expired',
        lastSeenAt: new Date(),
        chatMutedAt: new Date('2026-08-19T06:00:00.000Z'),
        chatMutedUntil: new Date('2026-08-19T07:00:00.000Z'),
        chatMuteReason: '已到期',
        user: {
          id: 'user-expired',
          uid: '20001',
          nickname: '玩家甲',
          tgUsername: null,
          avatarUrl: null,
          gameAdminAssignments: [],
        },
      },
      {
        id: 'member-active',
        lastSeenAt: new Date(),
        chatMutedAt: new Date('2026-08-19T07:30:00.000Z'),
        chatMutedUntil: new Date('2026-08-19T09:00:00.000Z'),
        chatMuteReason: '仍在禁言',
        user: {
          id: 'user-active',
          uid: '20002',
          nickname: '玩家乙',
          tgUsername: null,
          avatarUrl: null,
          gameAdminAssignments: [],
        },
      },
    ]);

    const result = await listGameAdminMembers({
      actorUserId: 'admin-user',
      gameCode: 'NIUNIU',
    });

    expect(result.items[0]?.mute).toMatchObject({ active: false, reason: null });
    expect(result.items[1]?.mute).toMatchObject({
      active: true,
      reason: '仍在禁言',
    });
    vi.useRealTimers();
  });

  it('启用管理员授权时原子清除其历史禁言并实时通知客户端', async () => {
    mocks.gameAdminAssignment.findUnique.mockResolvedValue({
      ...activeAssignment,
      status: 'DISABLED',
    });

    await createGameAdminAssignment({
      gameCode: 'NIUNIU',
      userId: 'admin-user',
      permissions: ['MUTE_MEMBERS'],
      platformAdminId: 'platform-super',
    });

    expect(mocks.roomMember.updateMany).toHaveBeenCalledWith({
      where: { roomId: 'room-1', userId: 'admin-user' },
      data: {
        chatMutedAt: null,
        chatMutedUntil: null,
        chatMuteReason: null,
        chatMutedByAssignmentId: null,
      },
    });
    await vi.waitFor(() =>
      expect(mocks.broadcast).toHaveBeenCalledWith({
        roomId: 'room-1',
        userId: 'admin-user',
        moderation: {
          muted: false,
          mutedAt: null,
          mutedUntil: null,
          reason: null,
        },
      }),
    );
  });
});
