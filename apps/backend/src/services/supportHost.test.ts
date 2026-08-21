import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserKind, UserStatus } from '@prisma/client';

const mocks = vi.hoisted(() => {
  const room = { findUnique: vi.fn(), update: vi.fn() };
  const user = { findUnique: vi.fn(), update: vi.fn() };
  const roomMember = { upsert: vi.fn() };
  const auditLog = { create: vi.fn() };
  const tx = { room, user, roomMember, auditLog };
  return {
    room,
    user,
    roomMember,
    auditLog,
    tx,
    isHouseUserId: vi.fn(),
    appendChatOnce: vi.fn(),
    broadcastUserProfileChanged: vi.fn(async () => undefined),
  };
});

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    room: mocks.room,
    user: mocks.user,
    roomMember: mocks.roomMember,
    auditLog: mocks.auditLog,
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg === 'function') return (arg as (tx: typeof mocks.tx) => unknown)(mocks.tx);
      if (Array.isArray(arg)) return Promise.all(arg);
      return arg;
    }),
  },
}));
vi.mock('./houseInviter.js', () => ({ isHouseUserId: mocks.isHouseUserId }));
vi.mock('./roomHub.js', () => ({
  appendChatOnce: mocks.appendChatOnce,
  broadcastUserProfileChanged: mocks.broadcastUserProfileChanged,
}));
vi.mock('./gameAdmin.js', () => ({
  GameAdminError: class GameAdminError extends Error {
    constructor(public code: string) {
      super(code);
    }
  },
}));

import {
  bindSupportHost,
  pickSupportThanksMessage,
  sendSupportHostThanks,
  SUPPORT_HOST_AVATAR_URL,
  SUPPORT_HOST_LABEL,
  SUPPORT_THANKS_MESSAGES,
  unbindSupportHost,
} from './supportHost.js';

const hostUser = {
  id: 'host-1',
  uid: '6052670417',
  nickname: 'Dev6304',
  tgUsername: 'girl',
  tgDisplayName: 'Dev',
  avatarUrl: '/avatars/nft-01.jpg',
  status: UserStatus.ACTIVE,
  kind: UserKind.HUMAN,
  tgId: 1n,
};

describe('客服小妹绑定与致谢', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.room.findUnique.mockResolvedValue({ id: 'room-1', supportHostUserId: null });
    mocks.user.findUnique.mockResolvedValue(hostUser);
    mocks.isHouseUserId.mockResolvedValue(false);
    mocks.user.update.mockResolvedValue({
      ...hostUser,
      nickname: SUPPORT_HOST_LABEL,
      avatarUrl: SUPPORT_HOST_AVATAR_URL,
    });
    mocks.room.update.mockResolvedValue({});
    mocks.roomMember.upsert.mockResolvedValue({});
    mocks.auditLog.create.mockResolvedValue({});
    mocks.appendChatOnce.mockResolvedValue({});
  });

  it('随机致谢只来自指定五句', () => {
    expect(SUPPORT_THANKS_MESSAGES).toHaveLength(5);
    expect(pickSupportThanksMessage(() => 0)).toBe(SUPPORT_THANKS_MESSAGES[0]);
    expect(pickSupportThanksMessage(() => 0.99)).toBe(SUPPORT_THANKS_MESSAGES[4]);
  });

  it('绑定后写入账号、进群并套用客服小妹外观', async () => {
    const host = await bindSupportHost({
      gameCode: 'SUPREME_NIUNIU',
      userId: 'host-1',
      platformAdminId: 'admin-1',
    });
    expect(host.nickname).toBe(SUPPORT_HOST_LABEL);
    expect(host.avatarUrl).toBe(SUPPORT_HOST_AVATAR_URL);
    expect(mocks.roomMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { roomId_userId: { roomId: 'room-1', userId: 'host-1' } },
      }),
    );
    expect(mocks.room.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { supportHostUserId: 'host-1' } }),
    );
  });

  it('拒绝绑定官方邀请号或虚拟号', async () => {
    mocks.isHouseUserId.mockResolvedValue(true);
    await expect(
      bindSupportHost({
        gameCode: 'SUPREME_NIUNIU',
        userId: 'host-1',
        platformAdminId: 'admin-1',
      }),
    ).rejects.toMatchObject({ code: 'SUPPORT_HOST_USER_INVALID' });
  });

  it('打赏后由绑定账号发同一句致谢，且幂等键稳定', async () => {
    mocks.room.findUnique.mockResolvedValue({
      supportHost: {
        id: 'host-1',
        uid: '6052670417',
        nickname: SUPPORT_HOST_LABEL,
        avatarUrl: SUPPORT_HOST_AVATAR_URL,
        status: UserStatus.ACTIVE,
      },
    });
    const sent = await sendSupportHostThanks({
      roomId: 'room-1',
      requestId: 'req-1',
      tipperUserId: 'player-1',
      message: SUPPORT_THANKS_MESSAGES[0],
    });
    expect(sent).toBe(true);
    expect(mocks.appendChatOnce).toHaveBeenCalledWith(
      'room-1',
      'support-thanks:req-1',
      expect.objectContaining({
        type: 'TEXT',
        content: SUPPORT_THANKS_MESSAGES[0],
        from: expect.objectContaining({ uid: '6052670417', nickname: SUPPORT_HOST_LABEL }),
      }),
    );
  });

  it('未绑定或自己打赏自己时不发致谢', async () => {
    mocks.room.findUnique.mockResolvedValue({ supportHost: null });
    await expect(
      sendSupportHostThanks({
        roomId: 'room-1',
        requestId: 'req-2',
        tipperUserId: 'player-1',
        message: '谢谢老板的投喂',
      }),
    ).resolves.toBe(false);
    expect(mocks.appendChatOnce).not.toHaveBeenCalled();
  });

  it('解绑只清空绑定，不删除账号', async () => {
    mocks.room.findUnique.mockResolvedValue({ id: 'room-1', supportHostUserId: 'host-1' });
    await unbindSupportHost({ gameCode: 'SUPREME_NIUNIU', platformAdminId: 'admin-1' });
    expect(mocks.room.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { supportHostUserId: null } }),
    );
  });
});
