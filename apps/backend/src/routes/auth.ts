import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { parseRefParam, verifyInitData } from '../lib/telegram.js';
import { onboardingStateOf, upsertUserFromTelegram } from '../services/user.js';
import { env } from '../config.js';
import { decryptSecret, safeDecryptSecret, safeMaskSecret } from '../lib/crypto.js';
import { isPresetAvatarUrl, PRESET_AVATAR_URLS } from '../data/presetAvatars.js';
import {
  isPublicAvatarUrl,
  parsePublicAvatarFilename,
  resolvePublicAvatarFile,
  resolvePublicAvatarOwnerFile,
} from '../lib/publicAvatars.js';
import { readFile, stat } from 'node:fs/promises';
import {
  broadcastUserProfileChanged,
  invalidateUserConnections,
} from '../services/roomHub.js';
import { verifyPaymentPin } from '../services/paymentPin.js';
import { pushService } from '../services/push.js';

const loginSchema = z.object({
  initData: z.string().min(1),
  botUsername: z.string().regex(/^[A-Za-z0-9_]{5,64}$/).optional(),
  deviceId: z.string().min(8).max(256),
});

const deviceRebindSchema = loginSchema.extend({
  paymentPin: z.string().regex(/^\d{6}$/),
});

/** 自助换绑频率：7 天内限一次；换绑后 24 小时暂停提现（钱包侧校验） */
const SELF_REBIND_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

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

  /**
   * 自助换绑设备：被 DEVICE_MISMATCH 挡在登录外的用户，凭 Telegram 身份（initData）
   * + 支付密码把账号换绑到当前设备。7 天限一次；换绑后 24 小时暂停提现（钱包侧校验）。
   * 未设支付密码的账号没有第二凭证，仍需走客服人工核验。
   */
  app.post('/api/auth/device-rebind', async (req, reply) => {
    const body = deviceRebindSchema.parse(req.body);

    let tgUser: { id: number } | null = null;
    const devMatch =
      env.nodeEnv === 'development' ? /^dev:(\d+)(?::(.+))?$/.exec(body.initData) : null;
    if (devMatch) {
      tgUser = { id: parseInt(devMatch[1], 10) };
    } else {
      const botInfo = await resolveBotToken(body.botUsername);
      if (!botInfo) return reply.code(503).send({ error: 'NO_BOT_CONFIGURED' });
      const verified = verifyInitData(body.initData, botInfo.token);
      if (!verified) return reply.code(401).send({ error: 'INVALID_INIT_DATA' });
      tgUser = verified.user;
    }

    const user = await prisma.user.findUnique({
      where: { tgId: BigInt(tgUser.id) },
      include: { device: true, paymentPin: true },
    });
    if (!user || user.status !== 'ACTIVE') {
      return reply.code(403).send({ error: 'USER_BANNED' });
    }
    if (!user.device || user.device.status !== 'ACTIVE') {
      // 没有生效中的绑定：走正常登录 + 绑定流程即可
      return reply.code(409).send({
        error: 'NO_ACTIVE_DEVICE',
        message: '当前无需换绑，请重新打开小程序登录',
      });
    }
    if (user.device.deviceId === body.deviceId) {
      return { ok: true, alreadyBound: true };
    }
    if (!user.paymentPin?.isSet) {
      return reply.code(409).send({
        error: 'PAYMENT_PIN_NOT_SET',
        message: '该账号未设置支付密码，无法自助换绑，请联系客服核验身份',
      });
    }
    const lastRebindAt = user.device.lastSelfRebindAt?.getTime() ?? 0;
    if (Date.now() - lastRebindAt < SELF_REBIND_COOLDOWN_MS) {
      const nextAllowedAt = new Date(lastRebindAt + SELF_REBIND_COOLDOWN_MS);
      return reply.code(429).send({
        error: 'REBIND_COOLDOWN',
        message: `自助换绑 7 天内限一次，${nextAllowedAt.toLocaleDateString('zh-MY', { timeZone: 'Asia/Kuala_Lumpur' })} 后可再次操作；急需请联系客服`,
        nextAllowedAt: nextAllowedAt.toISOString(),
      });
    }

    // 支付密码校验：沿用统一的失败计数与锁定机制（连错锁定，全局错误处理器返回码）
    await verifyPaymentPin(user.id, body.paymentPin);

    const reboundAt = new Date();
    const changed = await prisma.device.updateMany({
      where: {
        id: user.device.id,
        status: 'ACTIVE',
        deviceId: user.device.deviceId,
        OR: [
          { lastSelfRebindAt: null },
          {
            lastSelfRebindAt: {
              lte: new Date(reboundAt.getTime() - SELF_REBIND_COOLDOWN_MS),
            },
          },
        ],
      },
      data: {
        deviceId: body.deviceId,
        status: 'ACTIVE',
        boundAt: reboundAt,
        lastSelfRebindAt: reboundAt,
        // 作废旧设备上的所有登录态
        authVersion: { increment: 1 },
      },
    });
    if (changed.count !== 1) {
      const current = await prisma.device.findUnique({
        where: { id: user.device.id },
        select: { deviceId: true, lastSelfRebindAt: true },
      });
      if (current?.deviceId === body.deviceId) {
        return { ok: true, alreadyBound: true };
      }
      const nextAllowedAt = new Date(
        (current?.lastSelfRebindAt?.getTime() ?? reboundAt.getTime())
          + SELF_REBIND_COOLDOWN_MS,
      );
      return reply.code(429).send({
        error: 'REBIND_COOLDOWN',
        message: '另一台设备刚完成换绑，本次请求未生效',
        nextAllowedAt: nextAllowedAt.toISOString(),
      });
    }
    await invalidateUserConnections(user.id);
    await prisma.auditLog.create({
      data: {
        adminId: 'self-service',
        action: 'device_self_rebind',
        target: user.id,
        before: { deviceIdSuffix: user.device.deviceId.slice(-6) },
        after: { deviceIdSuffix: body.deviceId.slice(-6) },
        ip: req.ip,
      },
    });
    // 通知用户：如非本人操作可立即挂失
    void pushService
      .sendCustom(
        user.id,
        '🔐 设备已更换\n\n您的账号刚完成设备换绑，旧设备已退出登录。\n为保障资金安全，换绑后 24 小时内暂停提现。\n如非本人操作，请立即联系客服冻结账号。',
      )
      .catch(() => undefined);

    return { ok: true };
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

  /** 更换头像：系统内置库，或玩家自己上传的公开头像 */
  app.post('/api/me/avatar', { preHandler: [app.authUser] }, async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const body = z
      .object({
        avatarUrl: z.string().min(1).max(200),
      })
      .parse(req.body);
    const nextUrl = body.avatarUrl.trim();
    if (isPublicAvatarUrl(nextUrl)) {
      const filename = parsePublicAvatarFilename(nextUrl);
      const path = filename ? resolvePublicAvatarFile(env.uploadDir, filename) : null;
      try {
        if (!path || !(await stat(path)).isFile()) throw new Error('MISSING');
      } catch {
        return reply.code(400).send({
          error: 'INVALID_AVATAR',
          message: '请先上传自定义头像，或改选系统头像',
        });
      }
      const current = await prisma.user.findUnique({
        where: { id: userId },
        select: { avatarUrl: true },
      });
      if (current?.avatarUrl !== nextUrl) {
        const ownerPath = filename
          ? resolvePublicAvatarOwnerFile(env.uploadDir, filename)
          : null;
        const owner = ownerPath
          ? (await readFile(ownerPath, 'utf8').catch(() => '')).trim()
          : '';
        if (owner !== userId) {
          return reply.code(400).send({
            error: 'INVALID_AVATAR',
            message: '只能使用自己刚上传的头像',
          });
        }
      }
    } else if (!isPresetAvatarUrl(nextUrl)) {
      return reply.code(400).send({
        error: 'INVALID_AVATAR',
        message: '请选择系统头像或上传自己的照片',
      });
    }
    const user = await prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: nextUrl },
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
