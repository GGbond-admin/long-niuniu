import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { serializable } from '../lib/transaction.js';
import { transfer } from './wallet.js';
import { pushService } from './push.js';
import {
  amountToCents,
  describeOrderState,
  mapOrderState,
  queryVpayOrder,
} from './vpay.js';
import { getVpayConfig } from './paymentProviders.js';

/** 系统自动处理的工单在审计日志里的操作人标识。 */
export const VPAY_SYSTEM_OPERATOR = 'system:vpay';

const SENSITIVE_PROVIDER_KEY =
  /(^|_)(api_?token|token|sign|signature|acc_?(no|name)|account_?(no|name)?|bank_?account|card_?no|holder|real_?name|phone|mobile|email)(_|$)/i;

/** 网关原文只保留对账字段，密钥、签名及收款人资料不得明文落库。 */
export function sanitizeVpayPayload(value: unknown, depth = 0): Prisma.InputJsonValue {
  if (depth > 8) return '[TRUNCATED]';
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeVpayPayload(item, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [
          key,
          SENSITIVE_PROVIDER_KEY.test(key)
            ? '[REDACTED]'
            : sanitizeVpayPayload(item, depth + 1),
        ]),
    );
  }
  return String(value);
}

function formatCents(amount: bigint): string {
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;
}

export function resolveDepositCreditCents(order: {
  channel: string;
  amountCents: bigint;
  paidAmountCents?: bigint | null;
}): bigint {
  return order.channel === 'VPAY' && order.paidAmountCents !== null
    && order.paidAmountCents !== undefined
    ? order.paidAmountCents
    : order.amountCents;
}

export function resolveDepositCreditedCents(order: {
  channel: string;
  amountCents: bigint;
  paidAmountCents?: bigint | null;
  creditedAmountCents?: bigint | null;
}): bigint {
  return order.creditedAmountCents ?? resolveDepositCreditCents(order);
}

export type VpaySettleOutcome =
  | 'CREDITED'
  | 'REJECTED'
  | 'PENDING'
  | 'AMOUNT_MISMATCH'
  | 'CHARGEBACK_REVERSED'
  | 'CHARGEBACK_REVIEW_REQUIRED'
  | 'ALREADY_SETTLED'
  | 'NOT_VPAY';

/**
 * 落地一次网关状态变更。回调与对账补扫共用此入口，靠 `deposit:{orderId}`
 * 幂等键与人工确认路径共享同一条账本轨道，重复通知不会重复加钱。
 */
export async function applyVpayOrderState(input: {
  orderId: string;
  state: unknown;
  paidAmount?: unknown;
  providerTradeNo?: string | null;
  payload: unknown;
  source: 'notify' | 'reconcile';
}): Promise<{ outcome: VpaySettleOutcome; orderId: string }> {
  const order = await prisma.depositOrder.findUnique({ where: { id: input.orderId } });
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.channel !== 'VPAY') return { outcome: 'NOT_VPAY', orderId: order.id };

  const paidCents = input.paidAmount === undefined ? null : amountToCents(input.paidAmount);
  // 无论后续是否入账，先留档可对账字段；敏感字段在落库前剔除。
  await prisma.depositOrder.update({
    where: { id: order.id },
    data: {
      providerPayload: sanitizeVpayPayload(input.payload),
      ...(paidCents !== null ? { paidAmountCents: paidCents } : {}),
      ...(input.providerTradeNo ? { providerTradeNo: input.providerTradeNo } : {}),
    },
  });

  const mapped = mapOrderState(input.state);
  const isChargeback = Number(input.state) === 4;
  if (order.status === 'COMPLETED' && isChargeback) {
    const creditedCents = resolveDepositCreditedCents(order);
    const reversedReason = 'VPay 网关已冲正，充值金额已撤销';
    try {
      const reversed = await serializable(async (tx) => {
        const changed = await tx.depositOrder.updateMany({
          where: { id: order.id, status: 'COMPLETED' },
          data: {
            status: 'REJECTED',
            rejectReason: reversedReason,
            reviewedAt: new Date(),
          },
        });
        if (changed.count !== 1) return false;
        await transfer(tx, {
          amountCents: creditedCents,
          from: { userId: order.userId, accountType: 'USER_AVAILABLE' },
          to: { accountType: 'ADJUST_CLEARING' },
          refType: 'vpay_chargeback',
          refId: order.id,
          idempotencyKey: `vpay-chargeback:${order.id}`,
          memo: `VPay ${input.source} chargeback`,
        });
        await tx.auditLog.create({
          data: {
            adminId: VPAY_SYSTEM_OPERATOR,
            action: 'vpay_deposit_chargeback',
            target: order.id,
            before: { status: 'COMPLETED', creditedCents: creditedCents.toString() },
            after: {
              status: 'REJECTED',
              recoveredCents: creditedCents.toString(),
              source: input.source,
            },
          },
        });
        return true;
      });
      if (!reversed) return { outcome: 'ALREADY_SETTLED', orderId: order.id };
      pushService
        .notifyOrderRejected(
          order.userId,
          '充值',
          formatCents(creditedCents),
          reversedReason,
        )
        .catch(() => undefined);
      return { outcome: 'CHARGEBACK_REVERSED', orderId: order.id };
    } catch (error) {
      if ((error as { code?: string }).code !== 'INSUFFICIENT_BALANCE') throw error;

      const reviewReason = 'VPay 网关已冲正，但可用余额不足；账号已冻结，等待财务复核';
      const flagged = await serializable(async (tx) => {
        const changed = await tx.depositOrder.updateMany({
          where: { id: order.id, status: 'COMPLETED' },
          data: {
            status: 'REJECTED',
            rejectReason: reviewReason,
            reviewedAt: new Date(),
          },
        });
        if (changed.count !== 1) return false;
        await tx.user.updateMany({
          where: { id: order.userId, status: 'ACTIVE' },
          data: { status: 'BANNED' },
        });
        await tx.auditLog.create({
          data: {
            adminId: VPAY_SYSTEM_OPERATOR,
            action: 'vpay_deposit_chargeback_unrecovered',
            target: order.id,
            before: { status: 'COMPLETED', creditedCents: creditedCents.toString() },
            after: {
              status: 'REJECTED',
              recoveredCents: '0',
              outstandingCents: creditedCents.toString(),
              userStatus: 'BANNED',
              source: input.source,
            },
          },
        });
        return true;
      });
      if (!flagged) return { outcome: 'ALREADY_SETTLED', orderId: order.id };
      pushService
        .notifyOrderRejected(
          order.userId,
          '充值',
          formatCents(creditedCents),
          reviewReason,
        )
        .catch(() => undefined);
      return { outcome: 'CHARGEBACK_REVIEW_REQUIRED', orderId: order.id };
    }
  }

  if (order.status !== 'PENDING') return { outcome: 'ALREADY_SETTLED', orderId: order.id };

  if (mapped === 'PENDING' || mapped === 'UNKNOWN') {
    return { outcome: 'PENDING', orderId: order.id };
  }

  if (mapped === 'REJECTED') {
    const reason = `网关支付未完成：${describeOrderState(input.state)}`;
    const changed = await prisma.depositOrder.updateMany({
      where: { id: order.id, status: 'PENDING' },
      data: { status: 'REJECTED', rejectReason: reason, reviewedAt: new Date() },
    });
    if (changed.count === 1) {
      await prisma.auditLog.create({
        data: {
          adminId: VPAY_SYSTEM_OPERATOR,
          action: 'vpay_deposit_reject',
          target: order.id,
          after: { state: String(input.state), source: input.source },
        },
      });
      pushService
        .notifyOrderRejected(order.userId, '充值', formatCents(order.amountCents), reason)
        .catch(() => undefined);
    }
    return { outcome: 'REJECTED', orderId: order.id };
  }

  // 实付与下单金额不符时不自动入账，留给财务人工判断
  if (paidCents === null || paidCents !== order.amountCents) {
    await prisma.auditLog.create({
      data: {
        adminId: VPAY_SYSTEM_OPERATOR,
        action: 'vpay_deposit_amount_mismatch',
        target: order.id,
        before: { expected: order.amountCents.toString() },
        after: { paid: paidCents === null ? String(input.paidAmount) : paidCents.toString() },
      },
    });
    return { outcome: 'AMOUNT_MISMATCH', orderId: order.id };
  }

  const credited = await serializable(async (tx) => {
    const changed = await tx.depositOrder.updateMany({
      where: { id: order.id, status: 'PENDING' },
      data: {
        status: 'COMPLETED',
        reviewedAt: new Date(),
        rejectReason: null,
        creditedAmountCents: order.amountCents,
      },
    });
    if (changed.count !== 1) return false;
    await transfer(tx, {
      amountCents: order.amountCents,
      from: { accountType: 'ADJUST_CLEARING' },
      to: { userId: order.userId, accountType: 'USER_AVAILABLE' },
      refType: 'deposit',
      refId: order.id,
      idempotencyKey: `deposit:${order.id}`,
      memo: `VPay ${input.source}`,
    });
    await tx.auditLog.create({
      data: {
        adminId: VPAY_SYSTEM_OPERATOR,
        action: 'vpay_deposit_complete',
        target: order.id,
        after: { source: input.source, tradeNo: input.providerTradeNo ?? null },
      },
    });
    return true;
  });

  if (!credited) return { outcome: 'ALREADY_SETTLED', orderId: order.id };
  pushService
    .notifyDepositCompleted(order.userId, formatCents(order.amountCents))
    .catch(() => undefined);
  return { outcome: 'CREDITED', orderId: order.id };
}

const RECONCILE_AFTER_MS = 3 * 60_000;
const RECONCILE_BATCH = 20;
const COMPLETED_RECHECK_AFTER_MS = 6 * 60 * 60_000;
const COMPLETED_RECHECK_LOOKBACK_MS = 30 * 24 * 60 * 60_000;

/**
 * 回调只在 10 分钟内重试 7 次，超时即放弃；这里主动查单兜底，
 * 避免玩家已付款但订单永远停在待处理。
 */
export async function reconcileVpayDeposits(now = new Date()): Promise<number> {
  const config = await getVpayConfig();
  if (!config.enabled || !config.baseUrl || !config.traderId || !config.apiToken) return 0;

  const [pending, completed] = await Promise.all([
    prisma.depositOrder.findMany({
      where: {
        channel: 'VPAY',
        status: 'PENDING',
        createdAt: { lt: new Date(now.getTime() - RECONCILE_AFTER_MS) },
        OR: [
          { providerCheckedAt: null },
          { providerCheckedAt: { lt: new Date(now.getTime() - RECONCILE_AFTER_MS) } },
        ],
      },
      orderBy: [
        { providerCheckedAt: { sort: 'asc', nulls: 'first' } },
        { createdAt: 'asc' },
      ],
      take: RECONCILE_BATCH,
    }),
    // 已到账订单仍可能在之后被网关冲正；定期复查最近 30 天，回调丢失也能止损。
    prisma.depositOrder.findMany({
      where: {
        channel: 'VPAY',
        status: 'COMPLETED',
        createdAt: { gte: new Date(now.getTime() - COMPLETED_RECHECK_LOOKBACK_MS) },
        OR: [
          { providerCheckedAt: null },
          {
            providerCheckedAt: {
              lt: new Date(now.getTime() - COMPLETED_RECHECK_AFTER_MS),
            },
          },
        ],
      },
      orderBy: [
        { providerCheckedAt: { sort: 'asc', nulls: 'first' } },
        { createdAt: 'asc' },
      ],
      take: RECONCILE_BATCH,
    }),
  ]);
  const stale = [...pending, ...completed];

  let settled = 0;
  for (const order of stale) {
    try {
      const result = await queryVpayOrder(config, order.id);
      if (result.code !== 0 || !result.data) continue;
      const outcome = await applyVpayOrderState({
        orderId: order.id,
        state: result.data.state,
        paidAmount: result.data.amount,
        providerTradeNo: result.data.trade_no ?? null,
        payload: result as unknown,
        source: 'reconcile',
      });
      if (
        outcome.outcome === 'CREDITED'
        || outcome.outcome === 'REJECTED'
        || outcome.outcome === 'CHARGEBACK_REVERSED'
        || outcome.outcome === 'CHARGEBACK_REVIEW_REQUIRED'
      ) {
        settled += 1;
      }
    } catch (error) {
      console.error('[vpay] reconcile failed', order.id, (error as Error).message);
    } finally {
      await prisma.depositOrder
        .updateMany({
          where: { id: order.id },
          data: { providerCheckedAt: now },
        })
        .catch((error) => {
          console.error('[vpay] reconcile cursor update failed', order.id, error);
        });
    }
  }
  return settled;
}
