import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env, tngIngestEnabled } from '../config.js';
import { prisma } from '../lib/prisma.js';
import {
  ingestClaims,
  ingestPacketLink,
  listPendingJobs,
  TngIngestError,
} from '../services/tngIngest.js';

/** 时间戳窗口：手机端与服务器时钟偏差超过该值即拒绝，防重放。 */
const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

/** 采集设备轮询派单 + 推送明细，频率远高于普通接口，单独放宽限流。 */
const INGEST_RATE_LIMIT = { max: 1_200, timeWindow: '1 minute' } as const;

declare module 'fastify' {
  interface FastifyRequest {
    ingestRawBody?: string;
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 金额统一按「分」处理；同时接受数字与数字字符串，避免手机端大整数精度问题。 */
const centsSchema = z
  .union([z.number().int().nonnegative(), z.string().regex(/^\d{1,18}$/)])
  .transform((value) => BigInt(value));

const deviceIdSchema = z.string().min(1).max(64);
const correlationSchema = z.string().min(4).max(32);

function bearerToken(req: FastifyRequest): string {
  const header = req.headers.authorization ?? '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
}

/**
 * 鉴权：Bearer Token 证明身份，HMAC 签名证明请求未被篡改。
 * 签名串 = `${timestamp}\n${METHOD}\n${路径含查询串}\n${请求体原文}`
 */
async function verifyIngest(req: FastifyRequest, reply: FastifyReply) {
  const token = bearerToken(req);
  if (!token || !safeEqual(token, env.tngIngestToken)) {
    return reply.code(401).send({ error: 'UNAUTHORIZED', message: '回调凭证无效' });
  }

  const timestamp = String(req.headers['x-timestamp'] ?? '');
  if (!/^\d{10,16}$/.test(timestamp)) {
    return reply
      .code(401)
      .send({ error: 'TIMESTAMP_OUT_OF_RANGE', message: '缺少或非法的 X-Timestamp' });
  }
  if (Math.abs(Date.now() - Number(timestamp)) > TIMESTAMP_WINDOW_MS) {
    return reply
      .code(401)
      .send({ error: 'TIMESTAMP_OUT_OF_RANGE', message: '请求时间戳超出允许窗口，请同步系统时间' });
  }

  const provided = String(req.headers['x-signature'] ?? '');
  if (!provided) {
    return reply.code(401).send({ error: 'INVALID_SIGNATURE', message: '缺少 X-Signature' });
  }
  const signBase = [timestamp, req.method.toUpperCase(), req.url, req.ingestRawBody ?? ''].join(
    '\n',
  );
  const expected = createHmac('sha256', env.tngIngestSecret).update(signBase).digest('hex');
  if (!safeEqual(provided.toLowerCase(), expected)) {
    return reply.code(401).send({ error: 'INVALID_SIGNATURE', message: '签名校验失败' });
  }
}

async function auditIngest(input: {
  action: string;
  target?: string;
  after: Record<string, unknown>;
  ip?: string;
}) {
  await prisma.auditLog.create({
    data: {
      adminId: 'TNG_INGEST',
      action: input.action,
      target: input.target,
      after: input.after as never,
      ip: input.ip,
    },
  });
}

export async function internalTngRoutes(app: FastifyInstance) {
  // 未配置 Token/签名密钥时整套接口不注册，避免默认开放。
  if (!tngIngestEnabled) {
    app.log.warn('[tng-ingest] TNG_INGEST_TOKEN/SECRET not configured; ingest routes disabled');
    return;
  }

  // 签名针对请求体原文，必须拿到未经序列化还原的字符串。
  // 内容解析器在插件作用域内生效，不影响其它路由。
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      const raw = typeof body === 'string' ? body : body.toString('utf8');
      req.ingestRawBody = raw;
      if (!raw) return done(null, {});
      try {
        done(null, JSON.parse(raw));
      } catch {
        done(Object.assign(new Error('INVALID_JSON'), { statusCode: 400 }));
      }
    },
  );

  app.get(
    '/api/internal/tng/jobs/pending',
    { preHandler: verifyIngest, config: { rateLimit: INGEST_RATE_LIMIT } },
    async (req) => {
      const query = z
        .object({
          deviceId: deviceIdSchema,
          limit: z.coerce.number().int().min(1).max(5).optional(),
        })
        .parse(req.query);
      const jobs = await listPendingJobs(query);
      return { ok: true, jobs };
    },
  );

  app.post(
    '/api/internal/tng/packet-link',
    { preHandler: verifyIngest, config: { rateLimit: INGEST_RATE_LIMIT } },
    async (req) => {
      const body = z
        .object({
          deviceId: deviceIdSchema,
          correlation: correlationSchema,
          shareUrl: z.string().min(12).max(2_000).optional(),
          deepLink: z.string().min(12).max(2_000).optional(),
          totalCents: centsSchema,
          packetCount: z.number().int().min(1).max(1_000),
          createdAt: z.string().datetime({ offset: true }).optional(),
        })
        .refine((value) => !!(value.shareUrl || value.deepLink), {
          message: 'shareUrl 与 deepLink 至少提供一个',
          path: ['shareUrl'],
        })
        .parse(req.body);

      const result = await ingestPacketLink(body);
      await auditIngest({
        action: 'tng_ingest_packet_link',
        target: result.packetId,
        after: {
          deviceId: body.deviceId,
          correlation: body.correlation,
          roundId: result.roundId,
          hasShareUrl: !!body.shareUrl,
          hasDeepLink: !!body.deepLink,
          duplicate: result.duplicate,
        },
        ip: req.ip,
      });
      return { ok: true, ...result };
    },
  );

  app.post(
    '/api/internal/tng/claims',
    { preHandler: verifyIngest, config: { rateLimit: INGEST_RATE_LIMIT } },
    async (req) => {
      const body = z
        .object({
          deviceId: deviceIdSchema,
          correlation: correlationSchema.optional(),
          packetId: z.string().min(1).max(64).optional(),
          claims: z
            .array(
              z.object({
                tngName: z.string().min(2).max(100),
                amountCents: centsSchema,
                claimedAt: z.string().datetime({ offset: true }),
              }),
            )
            .min(1)
            .max(100),
        })
        .refine((value) => !!(value.correlation || value.packetId), {
          message: 'correlation 与 packetId 至少提供一个',
          path: ['correlation'],
        })
        .parse(req.body);

      const { results, complete } = await ingestClaims({
        deviceId: body.deviceId,
        correlation: body.correlation,
        packetId: body.packetId,
        claims: body.claims.map((row) => ({
          tngName: row.tngName,
          amountCents: row.amountCents,
          claimedAt: new Date(row.claimedAt),
        })),
      });

      const tally = results.reduce(
        (acc, row) => {
          if (row.status === 'recorded') acc.recorded += 1;
          else if (row.status === 'duplicate') acc.duplicate += 1;
          else acc.pending += 1;
          return acc;
        },
        { recorded: 0, duplicate: 0, pending: 0 },
      );

      if (tally.recorded > 0 || tally.pending > 0) {
        await auditIngest({
          action: 'tng_ingest_claims',
          target: body.correlation ?? body.packetId,
          after: { deviceId: body.deviceId, ...tally, complete },
          ip: req.ip,
        });
      }

      return { ok: true, results, complete, ...tally };
    },
  );
}

export { TngIngestError };
