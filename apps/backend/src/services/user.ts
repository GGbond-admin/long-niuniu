import { prisma } from '../lib/prisma.js';
import type { TelegramInitUser } from '../lib/telegram.js';
import { pickRandomPresetAvatar } from '../data/presetAvatars.js';

/** 生成 10 位数字 UID（唯一） */
export async function generateUid(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const uid = String(Math.floor(1_000_000_000 + Math.random() * 9_000_000_000));
    const exists = await prisma.user.findUnique({ where: { uid } });
    if (!exists) return uid;
  }
  throw new Error('uid generation failed');
}

/** 按 Telegram 用户登录/注册（幂等） */
export async function upsertUserFromTelegram(tgUser: TelegramInitUser, botId?: string) {
  const tgId = BigInt(tgUser.id);
  const existing = await prisma.user.findUnique({
    where: { tgId },
    include: { device: true, kyc: true, wallet: true, paymentPin: true },
  });
  const tgDisplayName =
    [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ').trim() ||
    tgUser.username ||
    null;

  if (existing) {
    // 头像一经设置即保持；历史空头像在登录时自动补齐系统随机头像。
    const avatarUrl = existing.avatarUrl || pickRandomPresetAvatar();
    // 昵称允许玩家自行修改，登录只同步 Telegram 资料字段，不覆盖 nickname
    return prisma.user.update({
      where: { id: existing.id },
      data: {
        tgUsername: tgUser.username ?? null,
        tgDisplayName,
        avatarUrl,
        ...(botId ? { lastBotId: botId } : {}),
      },
      include: { device: true, kyc: true, wallet: true, paymentPin: true },
    });
  }
  const uid = await generateUid();
  try {
    return await prisma.user.create({
      data: {
        tgId,
        uid,
        nickname: tgDisplayName || `player${uid.slice(-6)}`,
        tgUsername: tgUser.username ?? null,
        tgDisplayName,
        avatarUrl: pickRandomPresetAvatar(),
        lastBotId: botId,
        wallet: { create: {} },
      },
      include: { device: true, kyc: true, wallet: true, paymentPin: true },
    });
  } catch (e) {
    // 并发登录竞态：另一个请求已创建同 tgId，重查返回
    if ((e as { code?: string }).code === 'P2002') {
      return prisma.user.findUniqueOrThrow({
        where: { tgId },
        include: { device: true, kyc: true, wallet: true, paymentPin: true },
      });
    }
    throw e;
  }
}

/** 启动时为历史 HUMAN 用户补齐头像；幂等且不会覆盖用户已选择的头像。 */
export async function ensureMissingUserAvatars(): Promise<number> {
  const [missing, occupied] = await Promise.all([
    prisma.user.findMany({
      where: { kind: 'HUMAN', avatarUrl: null },
      select: { id: true },
    }),
    prisma.user.findMany({
      where: { avatarUrl: { not: null } },
      select: { avatarUrl: true },
    }),
  ]);
  if (!missing.length) return 0;

  const used = new Set<string>(
    occupied
      .map((row: { avatarUrl: string | null }) => row.avatarUrl)
      .filter((url: string | null): url is string => typeof url === 'string' && url.length > 0),
  );
  let updated = 0;
  for (const row of missing) {
    const avatarUrl = pickRandomPresetAvatar(used);
    const result = await prisma.user.updateMany({
      where: { id: row.id, avatarUrl: null },
      data: { avatarUrl },
    });
    if (result.count === 1) {
      updated += 1;
      used.add(avatarUrl);
    }
  }
  return updated;
}

export interface OnboardingState {
  inviterBound: boolean;
  deviceBound: boolean;
  kycStatus: 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED';
}

export function onboardingStateOf(user: {
  inviterId: string | null;
  device: { status: string } | null;
  kyc: { status: string } | null;
}): OnboardingState {
  return {
    inviterBound: !!user.inviterId,
    deviceBound: user.device?.status === 'ACTIVE',
    kycStatus: (user.kyc?.status as OnboardingState['kycStatus']) ?? 'NONE',
  };
}
