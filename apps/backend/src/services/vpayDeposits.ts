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

function formatCents(amount: bigint): string {
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;
}

export type VpaySettleOutcome =
  | 'CREDITED'
  | 'REJECTED'
  | 'PENDING'
  | 'AMOUNT_MISMATCH'
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
  // 无论后续是否入账，先留档网关原文，便于财务复核异常单
  await prisma.depositOrder.update({
    where: { id: order.id },
    data: {
      providerPayload: input.payload as Prisma.InputJsonValue,
      ...(paidCents !== null ? { paidAmountCents: paidCents } : {}),
      ...(input.providerTradeNo ? { providerTradeNo: input.providerTradeNo } : {}),
    },
  });

  if (order.status !== 'PENDING') return { outcome: 'ALREADY_SETTLED', orderId: order.id };

  const mapped = mapOrderState(input.state);
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
      data: { status: 'COMPLETED', reviewedAt: new Date(), rejectReason: null },
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

/**
 * 回调只在 10 分钟内重试 7 次，超时即放弃；这里主动查单兜底，
 * 避免玩家已付款但订单永远停在待处理。
 */
export async function reconcileVpayDeposits(now = new Date()): Promise<number> {
  const config = await getVpayConfig();
  if (!config.enabled || !config.baseUrl || !config.traderId || !config.apiToken) return 0;

  const stale = await prisma.depositOrder.findMany({
    where: {
      channel: 'VPAY',
      status: 'PENDING',
      createdAt: { lt: new Date(now.getTime() - RECONCILE_AFTER_MS) },
    },
    orderBy: { createdAt: 'asc' },
    take: RECONCILE_BATCH,
  });

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
      if (outcome.outcome === 'CREDITED' || outcome.outcome === 'REJECTED') settled += 1;
    } catch (error) {
      console.error('[vpay] reconcile failed', order.id, (error as Error).message);
    }
  }
  return settled;
}
