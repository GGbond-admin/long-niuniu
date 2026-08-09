import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { parseRefParam, verifyInitData } from '../lib/telegram.js';
import { onboardingStateOf, upsertUserFromTelegram } from '../services/user.js';
import { env } from '../config.js';
import { decryptSecret, safeDecryptSecret, safeMaskSecret } from '../lib/crypto.js';
import { isPresetAvatarUrl, PRESET_AVATAR_URLS } from '../data/presetAvatars.js';
import { broadcastUserProfileChanged } from '../services/roomHub.js';

const loginSchema = z.object({
  initData: z.string().min(1),
  botUsername: z.string().regex(/^[A-Za-z0-9_]{5,64}$/).optional(),
  deviceId: z.string().min(8).max(256),
});

async function resolveBotToken(botUsername?: string): Promise<{ token: string; botId?: string } | null> {
  if (botUsername) {
    const bot = await prisma.telegramBot.findUnique({ where: { username: botUsername } });
    if (bot && bot.status === 'ACTIVE') return { token: decryptSecret(bot.token), botId: bot.id };
  }
  const defaultBot = await prisma.telegramBot.findFirst({ where: { isDefault: true, status: 'ACTIVE' } });
  if (defaultBot) return { token: decryptSecret(defaultBot.token), botId: defaultBot.id };
  if (env.defaultBotToken) return { token: env.defaultBotToken };
  return null;
}

export async function authRoutes(app: FastifyInstance) {
  /**
   * Mini App 登录：校验 initData → 登录/注册 → 返回准入状态 + 会话 token
   */
  app.post('/api/auth/login', async (req, reply) => {
    const body = loginSchema.parse(req.body);

    // 开发模式模拟登录：initData = "dev:<tgId>:<昵称>"（仅 development 生效）
    let tgUser: { id: number; first_name?: string } | null = null;
    let startParam: string | undefined;
    let botId: string | undefined;

    const devMatch = env.nodeEnv === 'development' ? /^dev:(\d+)(?::(.+))?$/.exec(body.initData) : null;
    if (devMatch) {
      tgUser = { id: parseInt(devMatch[1], 10), first_name: devMatch[2] ?? `Dev${devMatch[1]}` };
    } else {
      const botInfo = await resolveBotToken(body.botUsername);
      if (!botInfo) return reply.code(503).send({ error: 'NO_BOT_CONFIGURED' });
      const verified = verifyInitData(body.initData, botInfo.token);
      if (!verified) return reply.code(401).send({ error: 'INVALID_INIT_DATA' });
      tgUser = verified.user;
      startParam = verified.startParam;
      botId = botInfo.botId;
    }

    const user = await upsertUserFromTelegram(tgUser, botId);
    if (user.status !== 'ACTIVE') return reply.code(403).send({ error: 'USER_BANNED' });
    if (user.device?.status === 'ACTIVE' && user.device.deviceId !== body.deviceId) {
      return reply.code(403).send({ error: 'DEVICE_MISMATCH' });
    }
    const refUid = parseRefParam(startParam);

    const token = app.jwt.sign(
      {
        sub: user.id,
        tgId: String(user.tgId),
        kind: 'user',
        deviceId: body.deviceId,
        deviceVersion: user.device?.authVersion ?? 1,
      },
      { expiresIn: '12h' },
    );

    return {
      token,
      user: {
        id: user.id,
        uid: user.uid,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
      },
      onboarding: onboardingStateOf(user),
      security: {
        paymentPinSet: Boolean(user.paymentPin?.isSet),
        paymentPinLockedUntil:
          user.paymentPin?.isSet &&
          user.paymentPin.lockedUntil &&
          user.paymentPin.lockedUntil > new Date()
            ? user.paymentPin.lockedUntil
            : null,
      },
      pendingInviterUid: user.inviterId ? null : refUid,
    };
  });

  /** 当前用户与准入状态 */
  app.get('/api/me', { preHandler: [app.authUser] }, async (req) => {
    const userId = (req.user as { sub: string }).sub;
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        device: true,
        kyc: true,
        wallet: true,
        paymentPin: true,
        inviter: { select: { uid: true, nickname: true } },
      },
    });
    const [playerGames, bankerGames] = await Promise.all([
      prisma.settlement.count({ where: { userId } }),
      prisma.round.count({ where: { bankerId: userId, phase: 'FINISHED' } }),
    ]);
    const malaysiaDay = (value: Date) =>
      value.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kuala_Lumpur' });
    const joinDay = new Date(`${malaysiaDay(user.createdAt)}T00:00:00+08:00`);
    const today = new Date(`${malaysiaDay(new Date())}T00:00:00+08:00`);
    const joinedDays = Math.max(1, Math.floor((today.getTime() - joinDay.getTime()) / 86_400_000) + 1);

    return {
      user: {
        id: user.id,
        uid: user.uid,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        inviteCode: user.uid,
        tgId: String(user.tgId),
        tgUsername: user.tgUsername,
        tgDisplayName: user.tgDisplayName,
        inviter: user.inviter,
        createdAt: user.createdAt,
      },
      stats: {
        joinedDays,
        gamesPlayed: playerGames + bankerGames,
      },
      onboarding: onboardingStateOf(user),
      security: {
        paymentPinSet: Boolean(user.paymentPin?.isSet),
        paymentPinLockedUntil:
          user.paymentPin?.isSet &&
          user.paymentPin.lockedUntil &&
          user.paymentPin.lockedUntil > new Date()
            ? user.paymentPin.lockedUntil
            : null,
      },
      device: user.device
        ? {
            status: user.device.status,
            maskedId:
              user.device.deviceId.length > 8
                ? `•••• ${user.device.deviceId.slice(-8)}`
                : '•••• ••••',
            boundAt: user.device.boundAt,
          }
        : null,
      kyc: user.kyc
        ? {
            status: user.kyc.status,
            realName: safeDecryptSecret(user.kyc.realName),
            duitnowIdMasked: safeMaskSecret(user.kyc.duitnowId),
            bankName: user.kyc.bankName,
            bankAccountMasked: safeMaskSecret(user.kyc.bankAccount),
            rejectReason: user.kyc.rejectReason,
          }
        : null,
      wallet: user.wallet
        ? {
            availableCents: String(user.wallet.availableCents),
            freezeBankerCents: String(user.wallet.freezeBankerCents),
            freezeBetCents: String(user.wallet.freezeBetCents),
            freezeWithdrawCents: String(user.wallet.freezeWithdrawCents),
          }
        : null,
    };
  });

  /** 系统内置头像列表 */
  app.get('/api/me/avatars', { preHandler: [app.authUser] }, async () => ({
    items: PRESET_AVATAR_URLS.map((url) => ({
      id: url.replace('/avatars/', '').replace(/\.jpg$/, ''),
      url,
    })),
  }));

  /** 更换为系统内置头像（禁止任意外链） */
  app.post('/api/me/avatar', { preHandler: [app.authUser] }, async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const body = z
      .object({
        avatarUrl: z.string().min(1).max(120),
      })
      .parse(req.body);
    if (!isPresetAvatarUrl(body.avatarUrl)) {
      return reply.code(400).send({ error: 'INVALID_AVATAR' });
    }
    const user = await prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: body.avatarUrl },
      select: { id: true, uid: true, nickname: true, avatarUrl: true },
    });
    void broadcastUserProfileChanged(user).catch(() => undefined);
    const { id: _id, ...publicUser } = user;
    return { ok: true, user: publicUser };
  });

  /** 修改展示昵称（不影响 Telegram 原始资料） */
  app.patch('/api/me/nickname', { preHandler: [app.authUser] }, async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const body = z
      .object({
        nickname: z.string().trim().min(1).max(24),
      })
      .parse(req.body);
    if (/[\u0000-\u001f\u007f]/.test(body.nickname)) {
      return reply.code(400).send({ error: 'INVALID_NICKNAME' });
    }
    const user = await prisma.user.update({
      where: { id: userId },
      data: { nickname: body.nickname },
      select: {
        id: true,
        uid: true,
        nickname: true,
        avatarUrl: true,
        tgId: true,
        tgUsername: true,
        tgDisplayName: true,
      },
    });
    void broadcastUserProfileChanged(user).catch(() => undefined);
    const { id: _id, ...publicUser } = user;
    return {
      ok: true,
      user: {
        ...publicUser,
        tgId: String(user.tgId),
        inviteCode: user.uid,
      },
    };
  });
}
