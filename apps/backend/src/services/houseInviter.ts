/**
 * 总后台官方邀请码 8888888888。
 * 邀请关系 / 二维码走推广返水；称桶分成只在后台单独绑定，两套互不影响。
 */
import { UserKind, UserStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { PLATFORM_CONFIG_SCOPE, setGameConfig } from './gameConfig.js';

export const HOUSE_INVITER_NOTE = 'HOUSE_INVITER';
export const DEFAULT_HOUSE_INVITE_UID = '8888888888';

let cachedHouse:
  | { id: string; uid: string; nickname: string | null }
  | null
  | undefined;

export function clearHouseInviterCache() {
  cachedHouse = undefined;
}

async function persistHouseUid(uid: string) {
  await setGameConfig(PLATFORM_CONFIG_SCOPE, 'houseInvite', { houseInviteUid: uid }, 'SYSTEM');
}

export async function getHouseInviter() {
  if (cachedHouse !== undefined) return cachedHouse;
  const user =
    (await prisma.user.findUnique({
      where: { uid: DEFAULT_HOUSE_INVITE_UID },
      select: { id: true, uid: true, nickname: true, adminNote: true, kind: true },
    })) ??
    (await prisma.user.findFirst({
      where: { adminNote: HOUSE_INVITER_NOTE },
      select: { id: true, uid: true, nickname: true, adminNote: true, kind: true },
    }));
  cachedHouse = user ? { id: user.id, uid: user.uid, nickname: user.nickname } : null;
  return cachedHouse;
}

export async function isHouseUserId(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const house = await getHouseInviter();
  return Boolean(house && house.id === userId);
}

export async function ensureHouseInviter() {
  const occupant = await prisma.user.findUnique({
    where: { uid: DEFAULT_HOUSE_INVITE_UID },
    select: { id: true, uid: true, nickname: true, adminNote: true, kind: true },
  });
  const marked = await prisma.user.findFirst({
    where: { adminNote: HOUSE_INVITER_NOTE },
    select: { id: true, uid: true, nickname: true, adminNote: true, kind: true },
  });

  if (occupant && (occupant.adminNote === HOUSE_INVITER_NOTE || occupant.kind === UserKind.VIRTUAL)) {
    const updated = await prisma.user.update({
      where: { id: occupant.id },
      data: {
        nickname: occupant.nickname || '官方总后台',
        kind: UserKind.VIRTUAL,
        status: UserStatus.ACTIVE,
        adminNote: HOUSE_INVITER_NOTE,
      },
      select: { id: true, uid: true, nickname: true },
    });
    await persistHouseUid(updated.uid);
    cachedHouse = updated;
    return updated;
  }

  if (occupant && occupant.kind === UserKind.HUMAN) {
    throw new Error(
      `UID ${DEFAULT_HOUSE_INVITE_UID} 已被真实玩家占用，无法设为总后台邀请码。请先给该玩家换 UID。`,
    );
  }

  if (marked) {
    const taken = await prisma.user.findUnique({
      where: { uid: DEFAULT_HOUSE_INVITE_UID },
      select: { id: true },
    });
    if (taken && taken.id !== marked.id) {
      throw new Error(`UID ${DEFAULT_HOUSE_INVITE_UID} 已被占用，无法把官方邀请码改成 10 个 8。`);
    }
    const updated = await prisma.user.update({
      where: { id: marked.id },
      data: {
        uid: DEFAULT_HOUSE_INVITE_UID,
        nickname: marked.nickname || '官方总后台',
        kind: UserKind.VIRTUAL,
        status: UserStatus.ACTIVE,
        adminNote: HOUSE_INVITER_NOTE,
      },
      select: { id: true, uid: true, nickname: true },
    });
    await persistHouseUid(updated.uid);
    cachedHouse = updated;
    return updated;
  }

  const created = await prisma.user.create({
    data: {
      tgId: null,
      uid: DEFAULT_HOUSE_INVITE_UID,
      nickname: '官方总后台',
      kind: UserKind.VIRTUAL,
      status: UserStatus.ACTIVE,
      adminNote: HOUSE_INVITER_NOTE,
      avatarUrl: '/avatars/default.jpg',
      wallet: { create: {} },
    },
    select: { id: true, uid: true, nickname: true },
  });
  await persistHouseUid(created.uid);
  cachedHouse = created;
  return created;
}

export async function houseInviteLinks() {
  const house = await ensureHouseInviter();
  const bot =
    (await prisma.telegramBot.findFirst({
      where: { isDefault: true, status: 'ACTIVE' },
    })) ??
    (await prisma.telegramBot.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    })) ??
    (await prisma.telegramBot.findFirst({
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    }));
  const username =
    bot?.username?.trim() || process.env.DEFAULT_BOT_USERNAME?.trim() || '';
  return {
    uid: house.uid,
    nickname: house.nickname ?? '官方总后台',
    profit: false,
    rebate: true,
    deepLink: username ? `https://t.me/${username}?startapp=ref_${house.uid}` : null,
    botLink: username ? `https://t.me/${username}?start=ref_${house.uid}` : null,
  };
}
