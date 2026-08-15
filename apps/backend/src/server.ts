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
import { authRoutes } from './routes/auth.js';
import { onboardingRoutes } from './routes/onboarding.js';
import { walletRoutes } from './routes/wallet.js';
import { promotionRoutes } from './routes/promotion.js';
import { adminRoutes } from './routes/admin.js';
import { adminGameRoutes, gameRoutes } from './routes/game.js';
import { gameRoomRoutes } from './routes/gameRoom.js';
import { initRoomHub } from './services/roomHub.js';
import { adminOperationsRoutes, operationsRoutes } from './routes/operations.js';
import { adminProfitPoolRoutes } from './routes/profitPool.js';
import { adminVirtualPlayerRoutes } from './routes/virtualPlayers.js';
import { adminNoticeRoutes, noticeRoutes } from './routes/notices.js';
import { uploadRoutes } from './routes/uploads.js';
import { paymentRoutes } from './routes/payments.js';
import { settingsRoutes } from './routes/settings.js';
import { pushService, PushService } from './services/push.js';
import { WalletError } from './services/wallet.js';
import { GameError } from './services/game.js';
import { PaymentPinError } from './services/paymentPin.js';
import {
  gameErrorMessage,
  paymentPinMessage,
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
  const app = Fastify({ logger: env.nodeEnv !== 'test', trustProxy: env.trustProxy });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    credentials: true,
    origin(origin, callback) {
      if (!origin || env.corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('ORIGIN_NOT_ALLOWED'), false);
    },
  });
  await app.register(rateLimit, {
    max: 240,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/healthz' || req.url === '/readyz',
  });
  const uploadRoot = resolve(env.uploadDir);
  await mkdir(uploadRoot, { recursive: true });
  await app.register(multipart, {
    limits: { files: 1, fileSize: 5 * 1024 * 1024, fields: 5 },
  });
  await app.register(jwt, { secret: env.adminJwtSecret });
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
      const claims = req.user as { sub: string; kind?: string };
      if (claims.kind !== 'admin') throw new Error('wrong kind');
      const admin = await prisma.admin.findUnique({
        where: { id: claims.sub },
        select: { status: true, role: true },
      });
      if (!admin || admin.status !== 'ACTIVE') throw new Error('disabled admin');
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
    if (err instanceof GameError) {
      const status = ['ROUND_NOT_FOUND', 'ROOM_NOT_FOUND', 'PACKET_NOT_FOUND'].includes(err.code)
        ? 404
        : ['INVALID_PHASE', 'PHASE_ENDED', 'BET_NOT_EDITABLE', 'CLAIM_ALREADY_RECORDED'].includes(err.code)
          ? 409
          : err.code === 'KYC_REQUIRED' || err.code === 'NOT_IN_ROOM'
            ? 403
            : 400;
      return reply
        .code(status)
        .send({ error: err.code, message: gameErrorMessage(err), details: err.details });
    }
    if ((err as { statusCode?: number }).statusCode === 429) {
      return reply
        .code(429)
        .send({ error: 'RATE_LIMITED', message: '操作过于频繁，请稍后再试' });
    }
    app.log.error(err);
    return reply.code(500).send({ error: 'INTERNAL', message: '服务器繁忙，请稍后重试' });
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  await app.register(authRoutes);
  await app.register(onboardingRoutes);
  await app.register(settingsRoutes);
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
  await app.register(adminProfitPoolRoutes);
  await app.register(noticeRoutes);
  await app.register(adminNoticeRoutes);
  await app.register(uploadRoutes);

  return app;
}
