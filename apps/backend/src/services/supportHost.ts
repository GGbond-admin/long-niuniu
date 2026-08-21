import { UserKind, UserStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { isHouseUserId } from './houseInviter.js';
import { GameAdminError } from './gameAdmin.js';
import { appendChatOnce, broadcastUserProfileChanged } from './roomHub.js';

export const SUPPORT_HOST_LABEL = '客服小妹';
export const SUPPORT_HOST_AVATAR_URL = '/avatars/support-girl.jpg';

export const SUPPORT_THANKS_MESSAGES = [
  '谢谢老板的投喂',
  '谢谢老板疼爱～红包收到啦🥰',
  '打赏收到啦～🥰🫶🏻 谢谢老板，祝老板今晚玩得开心❤️',
  '嘻嘻～谢谢老板的红包🫣❤️ 今天也是被老板宠爱的一天～',
  '老板一出手就知道不一样🤣❤️ 谢谢红包～',
] as const;

const supportHostUserSelect = {
  id: true,
  uid: true,
  nickname: true,
  tgUsername: true,
  tgDisplayName: true,
  avatarUrl: true,
  status: true,
} as const;

export function pickSupportThanksMessage(random = Math.random): string {
  const index = Math.min(
    SUPPORT_THANKS_MESSAGES.length - 1,
    Math.floor(random() * SUPPORT_THANKS_MESSAGES.length),
  );
  return SUPPORT_THANKS_MESSAGES[index]!;
}

export type SupportHostUser = {
  id: string;
  uid: string;
  nickname: string | null;
  tgUsername: string | null;
  tgDisplayName: string | null;
  avatarUrl: string | null;
  status: UserStatus;
};

export async function getSupportHostByGameCode(gameCode: string) {
  const room = await prisma.room.findUnique({
    where: { gameCode },
    select: {
      id: true,
      supportHost: { select: supportHostUserSelect },
    },
  });
  if (!room) throw new GameAdminError('GAME_NOT_FOUND');
  return { roomId: room.id, host: room.supportHost };
}

export async function bindSupportHost(input: {
  gameCode: string;
  userId: string;
  platformAdminId: string;
  ip?: string;
}): Promise<SupportHostUser> {
  const room = await prisma.room.findUnique({
    where: { gameCode: input.gameCode },
    select: { id: true, supportHostUserId: true },
  });
  if (!room) throw new GameAdminError('GAME_NOT_FOUND');

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: {
      ...supportHostUserSelect,
      kind: true,
      tgId: true,
    },
  });
  if (!user) throw new GameAdminError('SUPPORT_HOST_USER_NOT_FOUND');
  if (
    user.status !== UserStatus.ACTIVE
    || user.kind !== UserKind.HUMAN
    || !user.tgId
    || (await isHouseUserId(user.id))
  ) {
    throw new GameAdminError('SUPPORT_HOST_USER_INVALID');
  }

  const identity = {
    nickname: SUPPORT_HOST_LABEL,
    avatarUrl: SUPPORT_HOST_AVATAR_URL,
  };
  const host = await prisma.$transaction(async (tx) => {
    await tx.roomMember.upsert({
      where: { roomId_userId: { roomId: room.id, userId: user.id } },
      create: { roomId: room.id, userId: user.id, status: 'ACTIVE' },
      update: { status: 'ACTIVE' },
    });
    const updated = await tx.user.update({
      where: { id: user.id },
      data: identity,
      select: supportHostUserSelect,
    });
    await tx.room.update({
      where: { id: room.id },
      data: { supportHostUserId: user.id },
    });
    await tx.auditLog.create({
      data: {
        adminId: input.platformAdminId,
        action: 'support_host_bind',
        target: room.id,
        before: { supportHostUserId: room.supportHostUserId },
        after: { supportHostUserId: user.id, uid: user.uid, ...identity },
        ip: input.ip,
      },
    });
    return updated;
  });
  void broadcastUserProfileChanged({
    id: host.id,
    uid: host.uid,
    nickname: host.nickname,
    avatarUrl: host.avatarUrl,
  }).catch(() => undefined);
  return host;
}

export async function unbindSupportHost(input: {
  gameCode: string;
  platformAdminId: string;
  ip?: string;
}) {
  const room = await prisma.room.findUnique({
    where: { gameCode: input.gameCode },
    select: { id: true, supportHostUserId: true },
  });
  if (!room) throw new GameAdminError('GAME_NOT_FOUND');
  if (!room.supportHostUserId) return { host: null };
  await prisma.$transaction([
    prisma.room.update({
      where: { id: room.id },
      data: { supportHostUserId: null },
    }),
    prisma.auditLog.create({
      data: {
        adminId: input.platformAdminId,
        action: 'support_host_unbind',
        target: room.id,
        before: { supportHostUserId: room.supportHostUserId },
        after: { supportHostUserId: null },
        ip: input.ip,
      },
    }),
  ]);
  return { host: null };
}

export async function sendSupportHostThanks(input: {
  roomId: string;
  requestId: string;
  tipperUserId: string;
  message: string;
}): Promise<boolean> {
  const room = await prisma.room.findUnique({
    where: { id: input.roomId },
    select: {
      supportHost: {
        select: {
          id: true,
          uid: true,
          nickname: true,
          avatarUrl: true,
          status: true,
        },
      },
    },
  });
  const host = room?.supportHost;
  if (!host || host.status !== UserStatus.ACTIVE || host.id === input.tipperUserId) {
    return false;
  }
  await appendChatOnce(input.roomId, `support-thanks:${input.requestId}`, {
    type: 'TEXT',
    content: input.message,
    from: {
      uid: host.uid,
      nickname: host.nickname || SUPPORT_HOST_LABEL,
      avatarUrl: host.avatarUrl || SUPPORT_HOST_AVATAR_URL,
    },
  });
  return true;
}
