import type { FastifyInstance } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { compare, hash } from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { setGameConfig } from '../services/gameConfig.js';
import {
  decryptSecret,
  encryptSecret,
  maskPlaintext,
  maskSecret,
  safeDecryptSecret,
  safeMaskSecret,
} from '../lib/crypto.js';
import { serializable } from '../lib/transaction.js';
import { transfer } from '../services/wallet.js';
import { type GameConfigKey, validateGameConfig } from '../services/gameSettings.js';
import { reloadBots, validateBotCredentials } from '../bot/index.js';
import { ensureKycWithdrawAccounts, serializeWithdrawAccountAdmin } from '../services/withdrawAccounts.js';
import {
  completeWithdrawalAccounting,
  withdrawalAmounts,
} from '../services/withdrawalAccounting.js';
import { invalidateUserConnections } from '../services/roomHub.js';
import {
  isSupportedGameCode,
  SUPREME_NIUNIU_GAME_CODE,
} from '../services/gameCatalog.js';
import {
  getVpayConfig,
  isVpayReady,
  resolveCallbackUrl,
  resolveNotifyUrl,
  saveVpayConfig,
  VPAY_TRADE_CODE_CATALOG,
} from '../services/paymentProviders.js';
import { queryVpayBalance } from '../services/vpay.js';

export function hashPassword(pw: string): Promise<string> {
  return hash(pw, 12);
}

function legacyHashPassword(pw: string): string {
  return createHash('sha256').update(`niuniu:${pw}`).digest('hex');
}

function formatCents(amount: bigint): string {
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;
}

const loginSchema = z.object({ username: z.string().min(1).max(64), password: z.string().min(8).max(256) });
const reviewSchema = z
  .object({
    action: z.enum(['approve', 'reject']),
    reason: z.string().trim().min(2).max(500).optional(),
  })
  .refine((value) => value.action !== 'reject' || !!value.reason, {
    message: '驳回必须填写原因',
    path: ['reason'],
  });
const configSchema = z.object({
  key: z.enum([
    'hand',
    'betting',
    'fees',
    'rebate',
    'round',
    'rewards',
    'leaderboard',
    'messages',
  ]),
  value: z.unknown(),
});
const gameCodeSchema = z.string().refine(isSupportedGameCode, {
  message: 'GAME_NOT_SUPPORTED',
});
const orderReviewSchema = z
  .object({
    action: z.enum(['complete', 'reject']),
    reason: z.string().trim().min(2).max(500).optional(),
  })
  .refine((value) => value.action !== 'reject' || !!value.reason, {
    message: '驳回必须填写原因',
    path: ['reason'],
  });
const adminRoleSchema = z.enum(['SUPER', 'OPERATOR', 'REVIEWER', 'FINANCE']);

function revealTargetSnapshot(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const snapshot = { ...(value as Record<string, unknown>) };
  for (const field of ['duitnowId', 'name', 'bankAccount', 'holder']) {
    if (typeof snapshot[field] === 'string') snapshot[field] = safeDecryptSecret(snapshot[field]);
  }
  return snapshot;
}

export async function adminRoutes(app: FastifyInstance) {
  app.post('/api/admin/login', { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const { username, password } = loginSchema.parse(req.body);
    const admin = await prisma.admin.findUnique({ where: { username } });
    if (!admin || admin.status !== 'ACTIVE') return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    const isBcrypt = admin.passwordHash.startsWith('$2');
    const valid = isBcrypt
      ? await compare(password, admin.passwordHash)
      : (() => {
          const given = Buffer.from(legacyHashPassword(password));
          const stored = Buffer.from(admin.passwordHash);
          return given.length === stored.length && timingSafeEqual(given, stored);
        })();
    if (!valid) {
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    }
    if (!isBcrypt) {
      await prisma.admin.update({
        where: { id: admin.id },
        data: { passwordHash: await hashPassword(password) },
      });
    }
    const token = app.jwt.sign({ sub: admin.id, role: admin.role, kind: 'admin' }, { expiresIn: '8h' });
    return { token, admin: { id: admin.id, username: admin.username, role: admin.role } };
  });

  app.get(
    '/api/admin/admins',
    { preHandler: [app.authAdmin, app.requireAdminRoles('SUPER')] },
    async () => ({
      items: await prisma.admin.findMany({
        select: {
          id: true,
          username: true,
          role: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    }),
  );

  app.post(
    '/api/admin/admins',
    { preHandler: [app.authAdmin, app.requireAdminRoles('SUPER')] },
    async (req, reply) => {
      const adminId = (req.user as { sub: string }).sub;
      const body = z
        .object({
          username: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9_.-]+$/),
          password: z.string().min(8).max(256),
          role: adminRoleSchema,
        })
        .parse(req.body);
      const exists = await prisma.admin.findUnique({ where: { username: body.username } });
      if (exists) return reply.code(409).send({ error: 'USERNAME_EXISTS' });
      const created = await prisma.admin.create({
        data: {
          username: body.username,
          passwordHash: await hashPassword(body.password),
          role: body.role,
        },
        select: { id: true, username: true, role: true, status: true, createdAt: true },
      });
      await prisma.auditLog.create({
        data: {
          adminId,
          action: 'admin_create',
          target: created.id,
          after: { username: created.username, role: created.role },
          ip: req.ip,
        },
      });
      return { ok: true, item: created };
    },
  );

  app.patch(
    '/api/admin/admins/:id',
    { preHandler: [app.authAdmin, app.requireAdminRoles('SUPER')] },
    async (req, reply) => {
      const actorId = (req.user as { sub: string }).sub;
      const { id } = z.object({ id: z.string().cuid() }).parse(req.params);
      const body = z
        .object({
          role: adminRoleSchema.optional(),
          status: z.enum(['ACTIVE', 'DISABLED']).optional(),
          password: z.string().min(8).max(256).optional(),
        })
        .refine((value) => Object.keys(value).length > 0)
        .parse(req.body);
      const target = await prisma.admin.findUnique({ where: { id } });
      if (!target) return reply.code(404).send({ error: 'ADMIN_NOT_FOUND' });
      if (id === actorId && body.status === 'DISABLED') {
        return reply.code(409).send({ error: 'CANNOT_DISABLE_SELF' });
      }
      const removesActiveSuper =
        target.role === 'SUPER' &&
        target.status === 'ACTIVE' &&
        (body.role !== undefined && body.role !== 'SUPER' || body.status === 'DISABLED');
      if (removesActiveSuper) {
        const activeSupers = await prisma.admin.count({
          where: { role: 'SUPER', status: 'ACTIVE' },
        });
        if (activeSupers <= 1) {
          return reply.code(409).send({ error: 'LAST_ACTIVE_SUPER' });
        }
      }
      const updated = await prisma.admin.update({
        where: { id },
        data: {
          role: body.role,
          status: body.status,
          passwordHash: body.password ? await hashPassword(body.password) : undefined,
        },
        select: { id: true, username: true, role: true, status: true, createdAt: true },
      });
      await prisma.auditLog.create({
        data: {
          adminId: actorId,
          action: 'admin_update',
          target: id,
          before: { role: target.role, status: target.status },
          after: {
            role: updated.role,
            status: updated.status,
            passwordChanged: !!body.password,
          },
          ip: req.ip,
        },
      });
      return { ok: true, item: updated };
    },
  );

  // ── 实名审核 ──
  app.get(
    '/api/admin/kyc',
    { preHandler: [app.authAdmin, app.requireAdminRoles('SUPER', 'OPERATOR', 'REVIEWER')] },
    async (req) => {
    const { status } = z
      .object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).default('PENDING') })
      .parse(req.query);
    const list = await prisma.kyc.findMany({
      where: { status },
      include: {
        user: {
          select: { uid: true, nickname: true, avatarUrl: true, tgId: true },
        },
      },
      orderBy: { submittedAt: 'asc' },
      take: 100,
    });
    return {
      items: list.map((k) => ({
        id: k.id,
        userId: k.userId,
        uid: k.user.uid,
        nickname: k.user.nickname,
        avatarUrl: k.user.avatarUrl,
        realName: safeDecryptSecret(k.realName),
        duitnowId: safeDecryptSecret(k.duitnowId),
        bankName: k.bankName,
        bankAccount: safeDecryptSecret(k.bankAccount),
        accountHolder: safeDecryptSecret(k.accountHolder),
        status: k.status,
        submittedAt: k.submittedAt,
      })),
    };
    },
  );

  app.post('/api/admin/kyc/:id/review', {
    preHandler: [app.authAdmin, app.requireAdminRoles('SUPER', 'OPERATOR', 'REVIEWER')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const adminId = (req.user as { sub: string }).sub;
    const body = reviewSchema.parse(req.body);

    const kyc = await prisma.kyc.findUnique({ where: { id } });
    if (!kyc) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (kyc.status !== 'PENDING') return reply.code(409).send({ error: 'ALREADY_REVIEWED' });

    const status = body.action === 'approve' ? 'APPROVED' : 'REJECTED';
    const reviewed = await serializable(async (tx) => {
      const updated = await tx.kyc.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status,
          rejectReason: body.reason ?? null,
          reviewedBy: adminId,
          reviewedAt: new Date(),
        },
      });
      if (updated.count !== 1) return false;
      await tx.auditLog.create({
        data: {
          adminId,
          action: `kyc_${body.action}`,
          target: kyc.userId,
          after: { reason: body.reason ?? null },
          ip: req.ip,
        },
      });
      return true;
    });
    if (!reviewed) return reply.code(409).send({ error: 'ALREADY_REVIEWED' });

    if (body.action === 'approve') {
      await ensureKycWithdrawAccounts(kyc.userId).catch(() => undefined);
      app.pushService?.notifyKycApproved(kyc.userId).catch(() => {});
    } else {
      app.pushService?.notifyKycRejected(kyc.userId, body.reason ?? '资料不符').catch(() => {});
    }
    return { ok: true, status };
  });

  // ── 提现账户审核（银行 / 电子钱包绑定） ──
  app.get('/api/admin/withdraw-accounts', {
    preHandler: [app.authAdmin, app.requireAdminRoles('SUPER', 'OPERATOR', 'REVIEWER', 'FINANCE')],
  }, async (req) => {
    const { status } = z
      .object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).default('PENDING') })
      .parse(req.query);
    const items = await prisma.withdrawAccount.findMany({
      where: { status, source: 'user' },
      include: { user: { select: { uid: true, nickname: true } } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    return { items: items.map(serializeWithdrawAccountAdmin) };
  });

  app.post('/api/admin/withdraw-accounts/:id/review', {
    preHandler: [app.authAdmin, app.requireAdminRoles('SUPER', 'OPERATOR', 'REVIEWER', 'FINANCE')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const adminId = (req.user as { sub: string }).sub;
    const body = reviewSchema.parse(req.body);
    const account = await prisma.withdrawAccount.findUnique({ where: { id } });
    if (!account) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (account.status !== 'PENDING') return reply.code(409).send({ error: 'ALREADY_REVIEWED' });

    const status = body.action === 'approve' ? 'APPROVED' : 'REJECTED';
    await prisma.$transaction(async (tx) => {
      await tx.withdrawAccount.update({
        where: { id },
        data: {
          status,
          rejectReason: body.reason ?? null,
          reviewedBy: adminId,
          reviewedAt: new Date(),
        },
      });
      await tx.auditLog.create({
        data: {
          adminId,
          action: `withdraw_account_${body.action}`,
          target: id,
          after: { reason: body.reason ?? null, userId: account.userId },
        },
      });
    });
    return { ok: true, status };
  });

  // ── 游戏配置（06 文档 §11 配置清单） ──
  app.get('/api/admin/games/:gameCode/config', {
    preHandler: [app.authAdmin, app.requireAdminRoles('SUPER', 'OPERATOR')],
  }, async (req) => {
    const { gameCode } = z.object({ gameCode: gameCodeSchema }).parse(req.params);
    const rows = await prisma.gameConfig.findMany({
      where: { gameCode },
      orderBy: { key: 'asc' },
    });
    return {
      gameCode,
      items: rows.map((row) => ({
        key: row.key,
        value: row.value,
        updatedAt: row.updatedAt,
      })),
    };
  });

  app.put('/api/admin/games/:gameCode/config', {
    preHandler: [app.authAdmin, app.requireAdminRoles('SUPER', 'OPERATOR')],
  }, async (req) => {
    const adminId = (req.user as { sub: string }).sub;
    const { gameCode } = z.object({ gameCode: gameCodeSchema }).parse(req.params);
    const { key, value } = configSchema.parse(req.body);
    const validated = validateGameConfig(key as GameConfigKey, value);
    const before = await prisma.gameConfig.findUnique({
      where: { gameCode_key: { gameCode, key } },
    });
    await setGameConfig(gameCode, key, validated, adminId);
    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'game_config_update',
        target: `game:${gameCode}:config:${key}`,
        before: before ? { value: before.value } : undefined,
        after: validated,
        ip: req.ip,
      },
    });
    return { ok: true, gameCode, key };
  });

  /** @deprecated 管理端旧入口；固定映射至尊牛牛，避免无游戏上下文写入。 */
  app.get('/api/admin/config', {
    preHandler: [app.authAdmin, app.requireAdminRoles('SUPER', 'OPERATOR')],
  }, async () => {
    const rows = await prisma.gameConfig.findMany({
      where: { gameCode: SUPREME_NIUNIU_GAME_CODE },
    });
    return { items: rows.map((r) => ({ key: r.key, value: r.value, updatedAt: r.updatedAt })) };
  });

  app.put('/api/admin/config', {
    preHandler: [app.authAdmin, app.requireAdminRoles('SUPER', 'OPERATOR')],
  }, async (req, reply) => {
    const adminId = (req.user as { sub: string }).sub;
    const { key, value } = configSchema.parse(req.body);
    const validated = validateGameConfig(key as GameConfigKey, value);
    await setGameConfig(SUPREME_NIUNIU_GAME_CODE, key, validated, adminId);
    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'config_update',
        target: `game:${SUPREME_NIUNIU_GAME_CODE}:config:${key}`,
        after: validated,
      },
    });
    return { ok: true };
  });

  // ── 充值/提现工单（人工确认） ──
  app.get('/api/admin/orders/:type', {
    preHandler: [app.authAdmin, app.requireAdminRoles('SUPER', 'FINANCE')],
  }, async (req) => {
    const { type } = z.object({ type: z.enum(['deposit', 'withdraw']) }).parse(req.params);
    const { status } = z
      .object({ status: z.enum(['PENDING', 'COMPLETED', 'REJECTED']).default('PENDING') })
      .parse(req.query);
    if (type === 'deposit') {
      const items = await prisma.depositOrder.findMany({
        where: { status },
        include: { user: { select: { uid: true, nickname: true } } },
        orderBy: { createdAt: 'asc' },
        take: 100,
      });
      return {
        items: items.map(({ payeeSnapshot, ...item }) => ({
          ...item,
          payeeSnapshot,
        })),
      };
    }
    const items = await prisma.withdrawOrder.findMany({
      where: { status },
      include: { user: { select: { uid: true, nickname: true } } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    return { items: items.map((item) => ({ ...item, targetSnapshot: revealTargetSnapshot(item.targetSnapshot) })) };
  });

  app.post('/api/admin/orders/deposit/:id/review', {
    preHandler: [app.authAdmin, app.requireAdminRoles('SUPER', 'FINANCE')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const adminId = (req.user as { sub: string }).sub;
    const body = orderReviewSchema.parse(req.body);
    const order = await prisma.depositOrder.findUnique({ where: { id } });
    if (!order || order.status !== 'PENDING') return reply.code(409).send({ error: 'INVALID_ORDER' });

    if (body.action === 'complete') {
      const completed = await serializable(async (tx) => {
        const updated = await tx.depositOrder.updateMany({
          where: { id, status: 'PENDING' },
          data: { status: 'COMPLETED', reviewedBy: adminId, reviewedAt: new Date(), rejectReason: null },
        });
        if (updated.count !== 1) return false;
        await transfer(tx, {
          amountCents: order.amountCents,
          from: { accountType: 'ADJUST_CLEARING' },
          to: { userId: order.userId, accountType: 'USER_AVAILABLE' },
          refType: 'deposit',
          refId: id,
          idempotencyKey: `deposit:${id}`,
          operatorId: adminId,
        });
        await tx.auditLog.create({ data: { adminId, action: 'deposit_complete', target: id } });
        return true;
      });
      if (!completed) return reply.code(409).send({ error: 'INVALID_ORDER' });
    } else {
      const rejected = await serializable(async (tx) => {
        const updated = await tx.depositOrder.updateMany({
          where: { id, status: 'PENDING' },
          data: { status: 'REJECTED', rejectReason: body.reason, reviewedBy: adminId, reviewedAt: new Date() },
        });
        if (updated.count !== 1) return false;
        await tx.auditLog.create({ data: { adminId, action: 'deposit_reject', target: id } });
        return true;
      });
      if (!rejected) return reply.code(409).send({ error: 'INVALID_ORDER' });
    }
    const amount = formatCents(order.amountCents);
    if (body.action === 'complete') {
      app.pushService?.notifyDepositCompleted(order.userId, amount).catch(() => undefined);
    } else {
      app.pushService
        ?.notifyOrderRejected(order.userId, '充值', amount, body.reason!)
        .catch(() => undefined);
    }
    return { ok: true };
  });

  app.post('/api/admin/orders/withdraw/:id/review', {
    preHandler: [app.authAdmin, app.requireAdminRoles('SUPER', 'FINANCE')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const adminId = (req.user as { sub: string }).sub;
    const body = orderReviewSchema.parse(req.body);
    const order = await prisma.withdrawOrder.findUnique({ where: { id } });
    if (!order || order.status !== 'PENDING') return reply.code(409).send({ error: 'INVALID_ORDER' });

    const processed = await serializable(async (tx) => {
      const updated = await tx.withdrawOrder.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: body.action === 'complete' ? 'COMPLETED' : 'REJECTED',
          rejectReason: body.action === 'reject' ? body.reason : null,
          reviewedBy: adminId,
          reviewedAt: new Date(),
        },
      });
      if (updated.count !== 1) return false;
      if (body.action === 'reject') {
        await transfer(tx, {
          amountCents: order.amountCents,
          from: { userId: order.userId, accountType: 'USER_FREEZE_WITHDRAW' },
          to: { userId: order.userId, accountType: 'USER_AVAILABLE' },
          refType: 'withdraw_refund',
          refId: id,
          idempotencyKey: `withdraw-refund:${id}`,
          operatorId: adminId,
        });
      } else {
        await completeWithdrawalAccounting(tx, {
          id,
          userId: order.userId,
          amountCents: order.amountCents,
          targetSnapshot: order.targetSnapshot,
          operatorId: adminId,
        });
      }
      await tx.auditLog.create({ data: { adminId, action: `withdraw_${body.action}`, target: id } });
      return true;
    });
    if (!processed) return reply.code(409).send({ error: 'INVALID_ORDER' });
    const amount = formatCents(order.amountCents);
    if (body.action === 'complete') {
      const { netCents } = withdrawalAmounts(order.amountCents, order.targetSnapshot);
      app.pushService
        ?.notifyWithdrawCompleted(order.userId, formatCents(netCents))
        .catch(() => undefined);
    } else {
      app.pushService
        ?.notifyOrderRejected(order.userId, '提现', amount, body.reason!)
        .catch(() => undefined);
    }
    return { ok: true };
  });

  // ── 设备解绑 ──
  app.post('/api/admin/users/:userId/unbind-device', {
    preHandler: [app.authAdmin, app.requireAdminRoles('SUPER', 'OPERATOR', 'REVIEWER')],
  }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const adminId = (req.user as { sub: string }).sub;
    const device = await prisma.device.findUnique({ where: { userId } });
    if (!device) return reply.code(404).send({ error: 'NO_DEVICE' });
    await prisma.$transaction([
      prisma.device.update({
        where: { userId },
        data: {
          status: 'UNBOUND',
          authVersion: { increment: 1 },
        },
      }),
      prisma.auditLog.create({ data: { adminId, action: 'device_unbind', target: userId } }),
    ]);
    await invalidateUserConnections(userId);
    return { ok: true };
  });

  // ── 支付密码重置（客服核验身份后执行，同时让旧设备会话失效） ──
  app.post('/api/admin/users/:userId/reset-payment-pin', {
    preHandler: [app.authAdmin, app.requireAdminRoles('SUPER', 'REVIEWER')],
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const adminId = (req.user as { sub: string }).sub;
    const { reason } = z
      .object({ reason: z.string().trim().min(4).max(200) })
      .parse(req.body);

    const result = await serializable(async (tx) => {
      await tx.$queryRaw`
        SELECT "user_id"
        FROM "payment_pins"
        WHERE "user_id" = ${userId}
        FOR UPDATE
      `;
      const credential = await tx.paymentPin.findUnique({
        where: { userId },
        select: { userId: true, isSet: true, version: true },
      });
      if (!credential?.isSet) return null;
      await tx.paymentPin.update({
        where: { userId },
        data: {
          isSet: false,
          failedAttempts: 0,
          lockedUntil: null,
          version: { increment: 1 },
        },
      });
      const device = await tx.device.updateMany({
        where: { userId },
        data: {
          status: 'UNBOUND',
          authVersion: { increment: 1 },
        },
      });
      await tx.auditLog.create({
        data: {
          adminId,
          action: 'payment_pin_reset',
          target: userId,
          before: { paymentPinSet: true, version: credential.version },
          after: {
            paymentPinSet: false,
            version: credential.version + 1,
            deviceUnbound: device.count === 1,
            reason,
          },
        },
      });
      return { deviceUnbound: device.count === 1 };
    });
    if (!result) return reply.code(409).send({ error: 'PAYMENT_PIN_NOT_SET' });
    await invalidateUserConnections(userId);
    return { ok: true, ...result };
  });

  // ── Bot 管理（多机器人） ──
  app.get('/api/admin/bots', {
    preHandler: [app.authAdmin, app.requireAdminRoles('SUPER')],
  }, async () => {
    const bots = await prisma.telegramBot.findMany({ orderBy: { createdAt: 'asc' } });
    return {
      items: bots.map((b) => ({
        id: b.id,
        name: b.name,
        username: b.username,
        status: b.status,
        isDefault: b.isDefault,
        tokenMasked: safeMaskSecret(b.token, 6),
      })),
    };
  });

  app.post('/api/admin/bots', {
    preHandler: [app.authAdmin, app.requireAdminRoles('SUPER')],
  }, async (req, reply) => {
    const adminId = (req.user as { sub: string }).sub;
    const body = z
      .object({
        name: z.string().min(1).max(64),
        username: z.string().trim().regex(/^[A-Za-z0-9_]{5,64}$/),
        token: z.string().min(30).max(256),
        isDefault: z.boolean().default(false),
      })
      .parse(req.body);
    try {
      await validateBotCredentials(body.token, body.username);
    } catch (error) {
      const code = error instanceof Error && error.message === 'BOT_USERNAME_MISMATCH'
        ? error.message
        : 'INVALID_BOT_TOKEN';
      return reply.code(400).send({ error: code });
    }
    const bot = await prisma.$transaction(async (tx) => {
      if (body.isDefault) {
        await tx.telegramBot.updateMany({ data: { isDefault: false } });
      }
      return tx.telegramBot.create({ data: { ...body, token: encryptSecret(body.token) } });
    });
    await prisma.auditLog.create({ data: { adminId, action: 'bot_create', target: bot.id } });
    setImmediate(() => void reloadBots().catch((error) => console.error('[bot] reload failed', error)));
    return { ok: true, id: bot.id };
  });

  // ── 充值收款账户（可多账户，切换当前展示） ──
  const payeeManagers = [app.authAdmin, app.requireAdminRoles('SUPER', 'FINANCE', 'OPERATOR')];

  const payeeBodySchema = z.object({
    bankName: z.string().trim().min(1).max(80),
    accountNo: z.string().trim().min(4).max(64),
    accountName: z.string().trim().min(2).max(120),
    label: z.string().trim().max(80).optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    isCurrent: z.boolean().optional(),
  });

  function serializePayee(row: {
    id: string;
    bankName: string;
    accountNo: string;
    accountName: string;
    label: string | null;
    isCurrent: boolean;
    status: string;
    sortOrder: number;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: row.id,
      bankName: row.bankName,
      accountNo: safeDecryptSecret(row.accountNo),
      accountName: safeDecryptSecret(row.accountName),
      label: row.label,
      isCurrent: row.isCurrent,
      status: row.status,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  app.get('/api/admin/deposit-payees', { preHandler: payeeManagers }, async () => {
    const items = await prisma.depositPayeeAccount.findMany({
      orderBy: [{ isCurrent: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return { items: items.map(serializePayee) };
  });

  app.post('/api/admin/deposit-payees', { preHandler: payeeManagers }, async (req) => {
    const adminId = (req.user as { sub: string }).sub;
    const body = payeeBodySchema.parse(req.body);
    const item = await prisma.$transaction(async (tx) => {
      if (body.isCurrent) {
        await tx.depositPayeeAccount.updateMany({ data: { isCurrent: false } });
      }
      const created = await tx.depositPayeeAccount.create({
        data: {
          bankName: body.bankName,
          accountNo: encryptSecret(body.accountNo.replace(/\s+/g, '')),
          accountName: encryptSecret(body.accountName),
          label: body.label,
          sortOrder: body.sortOrder ?? 0,
          status: body.status ?? 'ACTIVE',
          isCurrent: body.isCurrent ?? false,
        },
      });
      const activeCount = await tx.depositPayeeAccount.count({
        where: { status: 'ACTIVE', isCurrent: true },
      });
      if (activeCount === 0 && created.status === 'ACTIVE') {
        return tx.depositPayeeAccount.update({
          where: { id: created.id },
          data: { isCurrent: true },
        });
      }
      return created;
    });
    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'deposit_payee_create',
        target: item.id,
        after: { bankName: body.bankName, label: body.label, isCurrent: item.isCurrent },
      },
    });
    return { ok: true, item: serializePayee(item) };
  });

  app.patch('/api/admin/deposit-payees/:id', { preHandler: payeeManagers }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const adminId = (req.user as { sub: string }).sub;
    const body = payeeBodySchema.partial().parse(req.body);
    const existing = await prisma.depositPayeeAccount.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND' });

    const item = await prisma.$transaction(async (tx) => {
      if (body.isCurrent) {
        await tx.depositPayeeAccount.updateMany({ data: { isCurrent: false } });
      }
      const updated = await tx.depositPayeeAccount.update({
        where: { id },
        data: {
          bankName: body.bankName,
          accountNo: body.accountNo
            ? encryptSecret(body.accountNo.replace(/\s+/g, ''))
            : undefined,
          accountName: body.accountName ? encryptSecret(body.accountName) : undefined,
          label: body.label === undefined ? undefined : body.label || null,
          sortOrder: body.sortOrder,
          status: body.status,
          isCurrent: body.isCurrent,
        },
      });
      if (updated.status === 'DISABLED' && updated.isCurrent) {
        await tx.depositPayeeAccount.update({
          where: { id },
          data: { isCurrent: false },
        });
        const fallback = await tx.depositPayeeAccount.findFirst({
          where: { status: 'ACTIVE', id: { not: id } },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        });
        if (fallback) {
          await tx.depositPayeeAccount.update({
            where: { id: fallback.id },
            data: { isCurrent: true },
          });
        }
        return tx.depositPayeeAccount.findUniqueOrThrow({ where: { id } });
      }
      return updated;
    });

    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'deposit_payee_update',
        target: id,
        after: { ...body, accountNo: body.accountNo ? '[REDACTED]' : undefined },
      },
    });
    return { ok: true, item: serializePayee(item) };
  });

  app.post('/api/admin/deposit-payees/:id/activate', { preHandler: payeeManagers }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const adminId = (req.user as { sub: string }).sub;
    const existing = await prisma.depositPayeeAccount.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (existing.status !== 'ACTIVE') {
      return reply.code(409).send({ error: 'PAYEE_DISABLED' });
    }
    const item = await prisma.$transaction(async (tx) => {
      await tx.depositPayeeAccount.updateMany({ data: { isCurrent: false } });
      return tx.depositPayeeAccount.update({
        where: { id },
        data: { isCurrent: true },
      });
    });
    await prisma.auditLog.create({
      data: { adminId, action: 'deposit_payee_activate', target: id },
    });
    return { ok: true, item: serializePayee(item) };
  });

  app.delete('/api/admin/deposit-payees/:id', { preHandler: payeeManagers }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const adminId = (req.user as { sub: string }).sub;
    const existing = await prisma.depositPayeeAccount.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND' });

    await prisma.$transaction(async (tx) => {
      await tx.depositOrder.updateMany({
        where: { payeeAccountId: id },
        data: { payeeAccountId: null },
      });
      await tx.depositPayeeAccount.delete({ where: { id } });
      if (existing.isCurrent) {
        const fallback = await tx.depositPayeeAccount.findFirst({
          where: { status: 'ACTIVE' },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        });
        if (fallback) {
          await tx.depositPayeeAccount.update({
            where: { id: fallback.id },
            data: { isCurrent: true },
          });
        }
      }
    });
    await prisma.auditLog.create({
      data: { adminId, action: 'deposit_payee_delete', target: id },
    });
    return { ok: true };
  });

  // ── 第三方支付通道（VPay）商户设置 ──
  const gatewayManagers = [app.authAdmin, app.requireAdminRoles('SUPER', 'FINANCE')];

  const amountPattern = /^\d+(\.\d{1,2})?$/;
  const vpayConfigSchema = z.object({
    enabled: z.boolean().optional(),
    baseUrl: z.string().trim().max(200).optional(),
    traderId: z.string().trim().max(10).optional(),
    /** 省略即保留原密钥；掩码原样回传亦视为未修改 */
    apiToken: z.string().trim().max(256).optional(),
    tradeCodes: z
      .array(z.object({ code: z.string().trim().min(1).max(30), enabled: z.boolean() }))
      .max(20)
      .optional(),
    notifyIps: z.array(z.string().trim().max(64)).max(50).optional(),
    timezoneOffsetMinutes: z.number().int().min(-720).max(840).optional(),
    notifyUrl: z.string().trim().max(500).optional(),
    callbackUrl: z.string().trim().max(500).optional(),
    orderTitle: z.string().trim().max(100).optional(),
    minAmount: z.string().trim().regex(amountPattern).optional(),
    maxAmount: z.string().trim().regex(amountPattern).optional(),
  });

  function parseAmountCents(amount: string): bigint {
    const [integer, decimal = ''] = amount.split('.');
    return BigInt(integer) * 100n + BigInt((decimal + '00').slice(0, 2));
  }

  async function serializeVpayConfig() {
    const config = await getVpayConfig();
    return {
      enabled: config.enabled,
      baseUrl: config.baseUrl,
      traderId: config.traderId,
      apiTokenMasked: config.apiToken ? maskPlaintext(config.apiToken) : '',
      apiTokenSet: config.apiToken.length > 0,
      tradeCodes: config.tradeCodes,
      notifyIps: config.notifyIps,
      timezoneOffsetMinutes: config.timezoneOffsetMinutes,
      notifyUrl: config.notifyUrl,
      callbackUrl: config.callbackUrl,
      orderTitle: config.orderTitle,
      minAmount: formatCents(config.minAmountCents),
      maxAmount: formatCents(config.maxAmountCents),
      /** 留空时实际生效的地址，直接复制给通道商配置 */
      effectiveNotifyUrl: resolveNotifyUrl(config),
      effectiveCallbackUrl: resolveCallbackUrl(config),
      ready: isVpayReady(config),
      catalog: VPAY_TRADE_CODE_CATALOG,
    };
  }

  app.get('/api/admin/payment-providers/vpay', { preHandler: gatewayManagers }, async () =>
    serializeVpayConfig(),
  );

  app.put('/api/admin/payment-providers/vpay', { preHandler: gatewayManagers }, async (req, reply) => {
    const adminId = (req.user as { sub: string }).sub;
    const body = vpayConfigSchema.parse(req.body);

    if (body.baseUrl && !/^https?:\/\//i.test(body.baseUrl)) {
      return reply.code(400).send({ error: 'INVALID_BASE_URL' });
    }
    // VPay 要求通知地址可直连且不得带查询参数
    for (const field of ['notifyUrl', 'callbackUrl'] as const) {
      const value = body[field];
      if (value && !/^https?:\/\//i.test(value)) {
        return reply.code(400).send({ error: 'INVALID_URL', field });
      }
    }
    if (body.notifyUrl && body.notifyUrl.includes('?')) {
      return reply.code(400).send({ error: 'NOTIFY_URL_HAS_QUERY' });
    }
    const minCents = body.minAmount === undefined ? undefined : parseAmountCents(body.minAmount);
    const maxCents = body.maxAmount === undefined ? undefined : parseAmountCents(body.maxAmount);
    if (minCents !== undefined && maxCents !== undefined && maxCents > 0n && maxCents < minCents) {
      return reply.code(400).send({ error: 'AMOUNT_RANGE_INVALID' });
    }

    const apiToken =
      body.apiToken === undefined || body.apiToken.includes('*') ? undefined : body.apiToken;

    const saved = await saveVpayConfig(
      {
        enabled: body.enabled,
        baseUrl: body.baseUrl,
        traderId: body.traderId,
        apiToken,
        tradeCodes: body.tradeCodes,
        notifyIps: body.notifyIps,
        timezoneOffsetMinutes: body.timezoneOffsetMinutes,
        notifyUrl: body.notifyUrl,
        callbackUrl: body.callbackUrl,
        orderTitle: body.orderTitle,
        minAmountCents: minCents,
        maxAmountCents: maxCents,
      },
      adminId,
    );

    if (saved.enabled && !isVpayReady(saved)) {
      await saveVpayConfig({ enabled: false }, adminId);
      await prisma.auditLog.create({
        data: { adminId, action: 'vpay_config_update', target: 'VPAY', after: { enabled: false } },
      });
      return reply.code(400).send({ error: 'VPAY_CONFIG_INCOMPLETE' });
    }

    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'vpay_config_update',
        target: 'VPAY',
        after: {
          enabled: saved.enabled,
          baseUrl: saved.baseUrl,
          traderId: saved.traderId,
          apiToken: apiToken === undefined ? '[UNCHANGED]' : '[REDACTED]',
          notifyIps: saved.notifyIps,
          tradeCodes: saved.tradeCodes.filter((item) => item.enabled).map((item) => item.code),
        },
      },
    });
    return { ok: true, config: await serializeVpayConfig() };
  });

  /** 用余额查询探活：签名、时区与商户号有任何一项配错都会在这里暴露 */
  app.post('/api/admin/payment-providers/vpay/test', { preHandler: gatewayManagers }, async (req, reply) => {
    const adminId = (req.user as { sub: string }).sub;
    const config = await getVpayConfig();
    if (!config.baseUrl || !config.traderId || !config.apiToken) {
      return reply.code(400).send({ error: 'VPAY_CONFIG_INCOMPLETE' });
    }
    try {
      const result = await queryVpayBalance(config);
      await prisma.auditLog.create({
        data: { adminId, action: 'vpay_config_test', target: 'VPAY', after: { code: result.code } },
      });
      if (result.code !== 0) {
        return reply.code(502).send({ error: 'VPAY_REJECTED', code: result.code, message: result.msg });
      }
      return { ok: true, balance: result.data ?? {} };
    } catch (error) {
      return reply.code(502).send({ error: 'VPAY_UNREACHABLE', message: (error as Error).message });
    }
  });
}
