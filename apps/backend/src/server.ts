import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AdminRole } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { env } from './config.js';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { isRateLimitExemptPath, rateLimitKey } from './lib/rateLimitKey.js';
import { authRoutes } from './routes/auth.js';
import { onboardingRoutes } from './routes/onboarding.js';
import { walletRoutes } from './routes/wallet.js';
import { promotionRoutes } from './routes/promotion.js';
import { adminRoutes } from './routes/admin.js';
import { adminGameRoutes, gameRoutes } from './routes/game.js';
import { gameRoomRoutes } from './routes/gameRoom.js';
import { initRoomHub } from './services/roomHub.js';
import { adminOperationsRoutes, operationsRoutes } from './routes/operations.js';
import { internalTngRoutes } from './routes/internalTng.js';
import { adminProfitPoolRoutes } from './routes/profitPool.js';
import { agentRoutes } from './routes/agent.js';
import { adminVirtualPlayerRoutes } from './routes/virtualPlayers.js';
import { adminNoticeRoutes, noticeRoutes } from './routes/notices.js';
import { uploadRoutes } from './routes/uploads.js';
import { paymentRoutes } from './routes/payments.js';
import { settingsRoutes } from './routes/settings.js';
import { gameAdminRoutes } from './routes/gameAdmin.js';
import { pushService, PushService } from './services/push.js';
import { WalletError } from './services/wallet.js';
import { GameError } from './services/game.js';
import { GameAdminError } from './services/gameAdmin.js';
import { GameBudgetError } from './services/gameBudget.js';
import { TngIngestError } from './services/tngIngest.js';
import { PaymentPinError } from './services/paymentPin.js';
import {
  gameErrorMessage,
  paymentPinMessage,
  tngIngestMessage,
  walletErrorMessage,
} from './services/errorMessages.js';

declare module 'fastify' {
  interface FastifyInstance {
    authUser: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdminRoles: (
      ...roles: AdminRole[]
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireKyc: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    pushService: PushService;
  }
}

// BigInt → 字符串（Prisma 金额字段以分存储为 BigInt，JSON 无法原生序列化）
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

export async function buildServer() {
  const app = Fastify({
    logger: env.nodeEnv !== 'test',
    trustProxy:
      env.trustProxy && env.trustedProxyCidrs.length > 0
        ? env.trustedProxyCidrs
        : false,
  });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      if (body == null || body === '' || (typeof body === 'string' && body.trim() === '')) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body));
      } catch (error) {
        const err = error as Error & { statusCode?: number };
        err.statusCode = 400;
        done(err, undefined);
      }
    },
  );

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    credentials: true,
    origin(origin, callback) {
      if (!origin || env.corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('ORIGIN_NOT_ALLOWED'), false);
    },
  });
  const uploadRoot = resolve(env.uploadDir);
  await mkdir(uploadRoot, { recursive: true });
  await app.register(multipart, {
    limits: { files: 1, fileSize: 5 * 1024 * 1024, fields: 5 },
  });
  await app.register(jwt, { secret: env.adminJwtSecret });
  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    // 已登录按用户计，避免同一出口 IP / 反向代理把整桌玩家算成一个人。
    allowList: (req) => isRateLimitExemptPath(req.url),
    keyGenerator: (req) =>
      rateLimitKey({
        authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
        ip: req.ip,
        verify: (token) => app.jwt.verify(token),
      }),
  });
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });
  initRoomHub();

  app.decorate('pushService', pushService);

  app.decorate('authUser', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
      const claims = req.user as {
        sub: string;
        kind?: string;
        deviceId?: string;
        deviceVersion?: number;
      };
      if (claims.kind !== 'user') throw new Error('wrong kind');
      const user = await prisma.user.findUnique({
        where: { id: claims.sub },
        select: {
          status: true,
          kind: true,
          device: {
            select: {
              deviceId: true,
              status: true,
              authVersion: true,
            },
          },
        },
      });
      if (!user || user.status !== 'ACTIVE') {
        await reply.code(403).send({ error: 'USER_BANNED' });
        return;
      }
      // 虚拟玩家仅服务端调度，禁止 Mini App JWT 登录。
      if (user.kind === 'VIRTUAL') {
        await reply.code(403).send({ error: 'VIRTUAL_LOGIN_FORBIDDEN' });
        return;
      }
      const routeUrl = req.routeOptions.url ?? '';
      const canOnboard =
        routeUrl === '/api/me' ||
        routeUrl === '/api/onboarding/inviter' ||
        routeUrl.startsWith('/api/onboarding/inviter/') ||
        routeUrl === '/api/onboarding/device';
      if (!user.device) {
        if (!canOnboard) {
          await reply.code(403).send({ error: 'DEVICE_BINDING_REQUIRED' });
        }
        return;
      }
      if (user.device.status === 'UNBOUND') {
        if (
          claims.deviceVersion !== user.device.authVersion ||
          !claims.deviceId
        ) {
          await reply.code(403).send({ error: 'DEVICE_SESSION_EXPIRED' });
          return;
        }
        if (!canOnboard) {
          await reply.code(403).send({ error: 'DEVICE_REBIND_REQUIRED' });
        }
        return;
      }
      if (
        !claims.deviceId ||
        user.device.deviceId !== claims.deviceId ||
        claims.deviceVersion !== user.device.authVersion
      ) {
        await reply.code(403).send({ error: 'DEVICE_MISMATCH' });
        return;
      }
    } catch {
      await reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
  });

  app.decorate('authAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
      const claims = req.user as { sub: string; kind?: string; ver?: number };
      if (claims.kind !== 'admin') throw new Error('wrong kind');
      const admin = await prisma.admin.findUnique({
        where: { id: claims.sub },
        select: { status: true, role: true, tokenVersion: true },
      });
      if (!admin || admin.status !== 'ACTIVE') throw new Error('disabled admin');
      if (claims.ver !== admin.tokenVersion) throw new Error('revoked admin token');
      Object.assign(req.user as object, { role: admin.role });
    } catch {
      await reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
  });

  app.decorate('requireAdminRoles', (...roles: AdminRole[]) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const role = (req.user as { role?: AdminRole }).role;
      if (!role || !roles.includes(role)) {
        await reply.code(403).send({ error: 'FORBIDDEN' });
      }
    };
  });

  // 实名门禁：钱包/游戏相关接口须已通过审核（P-KYC-08）
  app.decorate('requireKyc', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = (req.user as { sub: string }).sub;
    const kyc = await prisma.kyc.findUnique({ where: { userId } });
    if (!kyc || kyc.status !== 'APPROVED') {
      return reply.code(403).send({ error: 'KYC_REQUIRED', status: kyc?.status ?? 'NONE' });
    }
  });

  // 玩家可见错误统一附带中文 message（前端优先展示 message，其次才是错误码）
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'VALIDATION',
        message: '提交的资料格式有误，请检查后重试',
        issues: err.issues,
      });
    }
    if (err instanceof WalletError) {
      return reply.code(400).send({ error: err.code, message: walletErrorMessage(err.code) });
    }
    if (err instanceof PaymentPinError) {
      const status =
        err.code === 'PAYMENT_PIN_LOCKED'
          ? 423
          : err.code === 'PAYMENT_PIN_REQUIRED'
            ? 409
            : 400;
      return reply
        .code(status)
        .send({ error: err.code, message: paymentPinMessage(err.code), details: err.details });
    }
    if (err instanceof TngIngestError) {
      return reply
        .code(err.status)
        .send({ error: err.code, message: tngIngestMessage(err.code), details: err.details });
    }
    if (err instanceof GameError) {
      const status = ['ROUND_NOT_FOUND', 'ROOM_NOT_FOUND', 'PACKET_NOT_FOUND'].includes(err.code)
        ? 404
        : err.code === 'PACKET_ESCROW_UNAVAILABLE'
          ? 503
        : ['INVALID_PHASE', 'PHASE_ENDED', 'BET_NOT_EDITABLE', 'CLAIM_ALREADY_RECORDED'].includes(err.code)
          ? 409
        : err.code === 'KYC_REQUIRED'
          || err.code === 'NOT_IN_ROOM'
          || err.code === 'ROOM_CHAT_MUTED'
            ? 403
            : 400;
      return reply
        .code(status)
        .send({ error: err.code, message: gameErrorMessage(err), details: err.details });
    }
    if (err instanceof GameAdminError || err instanceof GameBudgetError) {
      const notFound = [
        'GAME_NOT_FOUND',
        'GAME_ADMIN_ASSIGNMENT_NOT_FOUND',
        'GAME_BUDGET_NOT_FOUND',
        'ROOM_MEMBER_NOT_FOUND',
        'SUPPORT_HOST_USER_NOT_FOUND',
      ].includes(err.code);
      const forbidden = [
        'GAME_ADMIN_ACCESS_DENIED',
        'GAME_ADMIN_PERMISSION_DENIED',
      ].includes(err.code);
      const conflict = [
        'IDEMPOTENCY_CONFLICT',
        'INSUFFICIENT_GAME_BUDGET',
        'INSUFFICIENT_PLATFORM_RESERVE',
        'GAME_ADMIN_PACKET_SECURITY_REQUIRED',
      ].includes(err.code);
      const messages: Record<string, string> = {
        GAME_NOT_FOUND: '游戏不存在或尚未初始化',
        GAME_ADMIN_ASSIGNMENT_NOT_FOUND: '游戏管理员授权不存在',
        GAME_BUDGET_NOT_FOUND: '游戏预算账户不存在',
        GAME_ADMIN_ACCESS_DENIED: '你没有该游戏的管理员权限',
        GAME_ADMIN_PERMISSION_DENIED: '你没有执行此操作的权限',
        GAME_ADMIN_PERMISSION_REQUIRED: '请至少选择一项管理员权限',
        INVALID_GAME_ADMIN_PERMISSION: '包含系统不支持的管理员权限',
        GAME_ADMIN_USER_INELIGIBLE: '只能授权已启用的 Telegram 真人账号',
        GAME_ADMIN_PACKET_SECURITY_REQUIRED: '发预算红包前需完成实名并设置支付密码',
        SUPPORT_HOST_USER_NOT_FOUND: '要绑定的客服小妹账号不存在',
        SUPPORT_HOST_USER_INVALID: '客服小妹只能绑定启用中的真人 Telegram 用户',
        GAME_ADMIN_UPDATE_REQUIRED: '没有需要更新的管理员资料',
        ROOM_MEMBER_NOT_FOUND: '该用户不是当前游戏的活跃成员',
        CANNOT_MUTE_SELF: '不能禁言自己',
        CANNOT_MUTE_GAME_ADMIN: '不能禁言另一名游戏管理员，请先由平台停用其授权',
        INVALID_MUTE_DURATION: '禁言时长必须为 1 分钟至 30 天，或选择永久',
        INVALID_BUDGET_AMOUNT: '预算金额格式不正确',
        BUDGET_AMOUNT_TOO_LARGE: '预算金额超出系统可处理范围',
        INSUFFICIENT_GAME_BUDGET: '游戏预算余额不足',
        INSUFFICIENT_PLATFORM_RESERVE: '平台备付金余额不足',
        IDEMPOTENCY_CONFLICT: '该请求号已用于另一笔操作，请刷新后重试',
      };
      return reply
        .code(notFound ? 404 : forbidden ? 403 : conflict ? 409 : 400)
        .send({
          error: err.code,
          message: messages[err.code] ?? '游戏管理员操作失败，请稍后重试',
          details: err.details,
        });
    }
    if ((err as { statusCode?: number }).statusCode === 429) {
      return reply
        .code(429)
        .send({ error: 'RATE_LIMITED', message: '操作过于频繁，请稍后再试' });
    }
    const clientStatus = (err as { statusCode?: number }).statusCode;
    if (typeof clientStatus === 'number' && clientStatus >= 400 && clientStatus < 500) {
      return reply.code(clientStatus).send({
        error: (err as { code?: string }).code ?? 'BAD_REQUEST',
        message: '请求格式不正确，请重试',
      });
    }
    app.log.error(err);
    return reply.code(500).send({ error: 'INTERNAL', message: '服务器繁忙，请稍后重试' });
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      if (env.nodeEnv === 'production') await redis().ping();
      return {
        ok: true,
        dependencies: {
          postgres: 'ok',
          redis: env.nodeEnv === 'production' ? 'ok' : 'optional',
        },
      };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  await app.register(authRoutes);
  await app.register(onboardingRoutes);
  await app.register(settingsRoutes);
  await app.register(gameAdminRoutes);
  await app.register(walletRoutes);
  await app.register(paymentRoutes);
  await app.register(promotionRoutes);
  await app.register(adminRoutes);
  await app.register(gameRoutes);
  await app.register(gameRoomRoutes);
  await app.register(adminGameRoutes);
  await app.register(adminVirtualPlayerRoutes);
  await app.register(operationsRoutes);
  await app.register(adminOperationsRoutes);
  await app.register(internalTngRoutes);
  await app.register(adminProfitPoolRoutes);
  await app.register(agentRoutes);
  await app.register(noticeRoutes);
  await app.register(adminNoticeRoutes);
  await app.register(uploadRoutes);

  return app;
}
