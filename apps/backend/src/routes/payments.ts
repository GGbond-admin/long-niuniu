import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import {
  enabledTradeCodes,
  getVpayConfig,
  isVpayReady,
  resolveCallbackUrl,
  resolveNotifyUrl,
} from '../services/paymentProviders.js';
import { createVpayOrder, queryVpayOrder, verifyNotifySign, VpayError } from '../services/vpay.js';
import { applyVpayOrderState, sanitizeVpayPayload } from '../services/vpayDeposits.js';

const createSchema = z.object({
  amount: z.string().regex(/^(?!0+(?:\.0{1,2})?$)\d+(\.\d{1,2})?$/),
  requestId: z.string().uuid(),
  tradeCode: z.string().min(1).max(30),
});

function toCents(amount: string): bigint {
  const [integer, decimal = ''] = amount.split('.');
  return BigInt(integer) * 100n + BigInt((decimal + '00').slice(0, 2));
}

/** 支持精确 IP 与 `203.0.113.*` 形式的前缀通配。 */
export function ipAllowed(ip: string, whitelist: string[]): boolean {
  if (whitelist.length === 0) return false;
  const candidate = ip.replace(/^::ffff:/, '');
  return whitelist.some((entry) => {
    const rule = entry.replace(/^::ffff:/, '');
    if (rule.endsWith('*')) return candidate.startsWith(rule.slice(0, -1));
    return rule === candidate;
  });
}

function parseExpiredTime(value: unknown, offsetMinutes: number): Date | null {
  const text = String(value ?? '').trim();
  const matched = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!matched) return null;
  const [, y, mo, d, h, mi, s] = matched.map(Number) as unknown as number[];
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s) - offsetMinutes * 60_000);
}

const statusRefreshedAt = new Map<string, number>();
const STATUS_REFRESH_THROTTLE_MS = 5_000;
const STATUS_REFRESH_ENTRY_TTL_MS = 60 * 60_000;

function rememberStatusRefresh(orderId: string, now = Date.now()) {
  statusRefreshedAt.set(orderId, now);
  if (statusRefreshedAt.size < 5_000) return;
  for (const [id, refreshedAt] of statusRefreshedAt) {
    if (now - refreshedAt > STATUS_REFRESH_ENTRY_TTL_MS) statusRefreshedAt.delete(id);
  }
  while (statusRefreshedAt.size > 10_000) {
    const oldest = statusRefreshedAt.keys().next().value as string | undefined;
    if (!oldest) break;
    statusRefreshedAt.delete(oldest);
  }
}

export async function paymentRoutes(app: FastifyInstance) {
  /** 玩家端可用充值渠道：人工转账恒在，VPay 视后台配置而定 */
  app.get(
    '/api/wallet/deposit/channels',
    { preHandler: [app.authUser, app.requireKyc] },
    async () => {
      const config = await getVpayConfig();
      const ready = isVpayReady(config);
      return {
        manual: { available: true },
        vpay: {
          available: ready,
          minCents: String(config.minAmountCents),
          maxCents: String(config.maxAmountCents),
          tradeCodes: ready
            ? enabledTradeCodes(config).map((item) => ({ code: item.code, label: item.label }))
            : [],
        },
      };
    },
  );

  /** VPay 下单：先落 PENDING 工单，网关下单失败则回滚，保证 requestId 可重试 */
  app.post(
    '/api/wallet/deposit/vpay',
    { preHandler: [app.authUser, app.requireKyc] },
    async (req, reply) => {
      const userId = (req.user as { sub: string }).sub;
      const body = createSchema.parse(req.body);
      const amountCents = toCents(body.amount);
      const config = await getVpayConfig();

      if (!isVpayReady(config)) return reply.code(409).send({ error: 'VPAY_UNAVAILABLE' });
      if (!enabledTradeCodes(config).some((item) => item.code === body.tradeCode)) {
        return reply.code(400).send({ error: 'TRADE_CODE_UNAVAILABLE' });
      }
      if (amountCents < config.minAmountCents) {
        return reply.code(400).send({ error: 'AMOUNT_BELOW_MIN', minCents: String(config.minAmountCents) });
      }
      if (config.maxAmountCents > 0n && amountCents > config.maxAmountCents) {
        return reply.code(400).send({ error: 'AMOUNT_ABOVE_MAX', maxCents: String(config.maxAmountCents) });
      }

      let replay = await prisma.depositOrder.findUnique({
        where: { userId_requestId: { userId, requestId: body.requestId } },
      });
      if (replay) {
        if (
          replay.amountCents !== amountCents
          || replay.channel !== 'VPAY'
          || replay.providerCode !== body.tradeCode
        ) {
          return reply.code(409).send({ error: 'IDEMPOTENCY_CONFLICT' });
        }
        if (replay.status === 'PENDING' && !replay.payUrl) {
          try {
            const remote = await queryVpayOrder(config, replay.id);
            if (remote.code === 0 && remote.data) {
              await prisma.depositOrder.update({
                where: { id: replay.id },
                data: {
                  payUrl: remote.data.pay_url ?? null,
                  providerTradeNo: remote.data.trade_no ?? null,
                  expiredAt: parseExpiredTime(
                    remote.data.expired_time,
                    config.timezoneOffsetMinutes,
                  ),
                  providerPayload: sanitizeVpayPayload(remote),
                },
              });
              if (remote.data.state !== undefined) {
                await applyVpayOrderState({
                  orderId: replay.id,
                  state: remote.data.state,
                  paidAmount: remote.data.amount,
                  providerTradeNo: remote.data.trade_no ?? null,
                  payload: remote as unknown,
                  source: 'reconcile',
                });
              }
              replay =
                (await prisma.depositOrder.findUnique({ where: { id: replay.id } }))
                ?? replay;
            }
          } catch (error) {
            req.log.warn({ err: error, orderId: replay.id }, '[vpay] recover accepted order failed');
          }
          if (replay.status === 'PENDING' && !replay.payUrl) {
            return reply.code(503).send({
              error: 'VPAY_ORDER_RECOVERY_PENDING',
              orderId: replay.id,
            });
          }
        }
        return {
          ok: true,
          orderId: replay.id,
          status: replay.status,
          payUrl: replay.payUrl,
          expiredAt: replay.expiredAt,
          duplicate: true,
        };
      }

      let order;
      try {
        order = await prisma.depositOrder.create({
          data: {
            userId,
            requestId: body.requestId,
            amountCents,
            channel: 'VPAY',
            providerCode: body.tradeCode,
          },
        });
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') {
          const concurrent = await prisma.depositOrder.findUnique({
            where: { userId_requestId: { userId, requestId: body.requestId } },
          });
          if (
            concurrent
            && concurrent.channel === 'VPAY'
            && concurrent.amountCents === amountCents
            && concurrent.providerCode === body.tradeCode
          ) {
            if (concurrent.status === 'PENDING' && !concurrent.payUrl) {
              return reply.code(503).send({
                error: 'VPAY_ORDER_RECOVERY_PENDING',
                orderId: concurrent.id,
              });
            }
            return {
              ok: true,
              orderId: concurrent.id,
              status: concurrent.status,
              payUrl: concurrent.payUrl,
              expiredAt: concurrent.expiredAt,
              duplicate: true,
            };
          }
          return reply.code(409).send({ error: 'IDEMPOTENCY_CONFLICT' });
        }
        throw error;
      }

      let result: Awaited<ReturnType<typeof createVpayOrder>>;
      try {
        result = await createVpayOrder(config, {
          outTradeNo: order.id,
          title: config.orderTitle.slice(0, 100),
          amountCents,
          tradeCode: body.tradeCode,
          notifyUrl: resolveNotifyUrl(config),
          callbackUrl: resolveCallbackUrl(config),
        });
      } catch (error) {
        // 超时、断线或无效响应都无法证明网关未受理；保留本地单并按平台单号查单恢复。
        // 删除占位会让稍后到达的成功回调失去归属，造成用户已付款却无法入账。
        req.log.error({ err: error }, '[vpay] create order request failed');
        return reply.code(503).send({
          error: 'VPAY_ORDER_RECOVERY_PENDING',
          orderId: order.id,
          message: error instanceof VpayError ? error.message : 'GATEWAY_ERROR',
        });
      }
      if (result.code !== 0 || !result.data?.pay_url) {
        await prisma.depositOrder
          .deleteMany({ where: { id: order.id, status: 'PENDING' } })
          .catch(() => undefined);
        return reply.code(502).send({
          error: 'VPAY_ORDER_FAILED',
          message: result.msg || 'VPAY_ORDER_FAILED',
        });
      }

      try {
        const updated = await prisma.depositOrder.update({
          where: { id: order.id },
          data: {
            payUrl: result.data.pay_url,
            providerTradeNo: result.data.trade_no ?? null,
            expiredAt: parseExpiredTime(result.data.expired_time, config.timezoneOffsetMinutes),
            providerPayload: sanitizeVpayPayload(result),
          },
        });
        return {
          ok: true,
          orderId: updated.id,
          status: updated.status,
          payUrl: updated.payUrl,
          expiredAt: updated.expiredAt,
          duplicate: false,
        };
      } catch (error) {
        // 网关已明确受理后绝不能删除本地单，否则远端付款会失去归属。
        // 保留 PENDING 占位；相同 requestId 重试时通过 ORDER_GET 恢复支付链接。
        req.log.error({ err: error, orderId: order.id }, '[vpay] persist accepted order failed');
        return reply.code(503).send({
          error: 'VPAY_ORDER_RECOVERY_PENDING',
          orderId: order.id,
        });
      }
    },
  );

  /** 支付页返回后轮询工单状态；顺带按节流主动查一次网关 */
  app.get(
    '/api/wallet/deposit/:id/status',
    { preHandler: [app.authUser, app.requireKyc] },
    async (req, reply) => {
      const userId = (req.user as { sub: string }).sub;
      const { id } = z.object({ id: z.string().cuid() }).parse(req.params);
      let order = await prisma.depositOrder.findFirst({ where: { id, userId } });
      if (!order) return reply.code(404).send({ error: 'ORDER_NOT_FOUND' });

      if (order.channel === 'VPAY' && order.status === 'PENDING') {
        const last = statusRefreshedAt.get(id) ?? 0;
        if (Date.now() - last > STATUS_REFRESH_THROTTLE_MS) {
          rememberStatusRefresh(id);
          try {
            const config = await getVpayConfig();
            if (isVpayReady(config)) {
              const result = await queryVpayOrder(config, id);
              if (result.code === 0 && result.data) {
                await applyVpayOrderState({
                  orderId: id,
                  state: result.data.state,
                  paidAmount: result.data.amount,
                  providerTradeNo: result.data.trade_no ?? null,
                  payload: result as unknown,
                  source: 'reconcile',
                });
                order = (await prisma.depositOrder.findFirst({ where: { id, userId } })) ?? order;
                if (order.status !== 'PENDING') statusRefreshedAt.delete(id);
              }
            }
          } catch (error) {
            req.log.warn({ err: error }, '[vpay] status refresh failed');
          }
        }
      }

      return {
        id: order.id,
        status: order.status,
        channel: order.channel,
        amountCents: String(order.amountCents),
        payUrl: order.payUrl,
        expiredAt: order.expiredAt,
        rejectReason: order.rejectReason,
        createdAt: order.createdAt,
      };
    },
  );

  /**
   * VPay 异步通知。必须返回不带任何多余字符的大写 SUCCESS，否则平台
   * 会在 10 分钟内重试 7 次。限流在此关闭，避免正常重试被拦。
   */
  app.post(
    '/api/payments/vpay/notify',
    { config: { rateLimit: false } },
    async (req, reply) => {
      const config = await getVpayConfig();
      const succeed = () => reply.type('text/plain; charset=utf-8').send('SUCCESS');

      if (!config.enabled || !config.apiToken) {
        req.log.warn('[vpay] notify received while provider disabled');
        return reply.code(503).send('DISABLED');
      }
      if (!ipAllowed(req.ip, config.notifyIps)) {
        req.log.warn({ ip: req.ip }, '[vpay] notify rejected by ip whitelist');
        return reply.code(403).send('FORBIDDEN');
      }

      const payload = req.body;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return reply.code(400).send('BAD_REQUEST');
      }
      const params = payload as Record<string, unknown>;
      const sign = String(params.sign ?? '');
      if (!verifyNotifySign(params, sign, config.apiToken)) {
        req.log.warn({ ip: req.ip }, '[vpay] notify signature mismatch');
        return reply.code(403).send('SIGN_ERROR');
      }
      if (config.traderId && String(params.trader_id ?? '') !== config.traderId) {
        req.log.warn('[vpay] notify trader mismatch');
        return reply.code(403).send('TRADER_ERROR');
      }

      const outTradeNo = String(params.out_trade_no ?? '').trim();
      if (!outTradeNo) return reply.code(400).send('BAD_REQUEST');

      try {
        const result = await applyVpayOrderState({
          orderId: outTradeNo,
          state: params.state,
          paidAmount: params.amount,
          providerTradeNo: String(params.trade_no ?? '') || null,
          payload: params,
          source: 'notify',
        });
        req.log.info({ orderId: outTradeNo, outcome: result.outcome }, '[vpay] notify handled');
        return succeed();
      } catch (error) {
        if ((error as Error).message === 'ORDER_NOT_FOUND') {
          req.log.warn({ outTradeNo }, '[vpay] notify for unknown order');
          return reply.code(404).send('ORDER_NOT_FOUND');
        }
        req.log.error({ err: error }, '[vpay] notify handling failed');
        // 不返回 SUCCESS，等待平台重试
        return reply.code(500).send('RETRY');
      }
    },
  );
}
