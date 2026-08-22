import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import {
  MALAYSIA_BANKS,
  MALAYSIA_EWALLETS,
  isKnownInstitution,
} from '../data/malaysiaPaymentInstitutions.js';
import { serializable } from '../lib/transaction.js';
import { transfer } from '../services/wallet.js';
import {
  ensureKycWithdrawAccounts,
  serializeWithdrawAccount,
} from '../services/withdrawAccounts.js';
import {
  getGameConfig,
  PLATFORM_CONFIG_SCOPE,
} from '../services/gameConfig.js';
import { malaysiaDay } from '../services/rebates.js';
import {
  withdrawFeeCents,
  withdrawUsedFreeQuota,
  withdrawalAmounts,
} from '../services/withdrawalAccounting.js';
import {
  assertPaymentPinVersion,
  verifyPaymentPin,
} from '../services/paymentPin.js';

const DEFAULT_WITHDRAW_CONFIG = {
  minCents: 10_000, // RM 100
  freeDailyLimit: 2,
  feeRatioAfterFree: 0.03,
};

/** 资金明细筛选项 → refType 列表 */
const LEDGER_CATEGORIES: Record<string, string[]> = {
  deposit: ['deposit'],
  withdraw: ['withdraw_freeze', 'withdraw_complete', 'withdraw_fee', 'withdraw_refund'],
  rebate: ['rebate', 'rebate_revoke', 'profit_share'],
  reward: ['reward', 'leaderboard_reward'],
  game: [
    'bet',
    'bet_adjust',
    'bet_liability_reserve',
    'bet_liability_adjust',
    'bet_withdraw',
    'bid',
    'settle_win',
    'settle_lose',
    'settle_bet_return',
    'settle_tie_return',
    'settle_liability_return',
    'settle_banker_return',
  ],
  fee: ['rake', 'fee_banker_seat', 'fee_service', 'fee_packet_agent', 'tip', 'withdraw_fee'],
  packet: [
    'group_packet_create',
    'group_packet_claim',
    'group_packet_refund',
    'packet_internal_claim',
    'claim_forfeit_refund',
  ],
  refund: [
    'withdraw_refund',
    'round_cancel_refund',
    'claim_forfeit_refund',
    'group_packet_refund',
    'settle_tie_return',
    'settle_bet_return',
  ],
  adjust: ['adjust'],
};

const pageSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
  /** all=全部科目；available=仅可用余额变动（默认资金明细） */
  scope: z.enum(['all', 'available']).default('all'),
  category: z
    .enum([
      'all',
      'deposit',
      'withdraw',
      'rebate',
      'reward',
      'game',
      'fee',
      'packet',
      'refund',
      'adjust',
    ])
    .default('all'),
});

const depositSchema = z.object({
  amount: z.string().regex(/^(?!0+(?:\.0{1,2})?$)\d+(\.\d{1,2})?$/),
  requestId: z.string().uuid(),
  proofUrl: z
    .string()
    .regex(/^upload:\/\/[0-9a-f-]{36}\.(?:jpg|png|webp|pdf)$/),
  payeeAccountId: z.string().cuid().optional(),
});

const withdrawSchema = z.object({
  amount: z.string().regex(/^(?!0+(?:\.0{1,2})?$)\d+(\.\d{1,2})?$/),
  accountId: z.string().cuid(),
  requestId: z.string().uuid(),
  paymentPin: z.string().regex(/^\d{6}$/),
});

const addAccountSchema = z.object({
  type: z.enum(['BANK', 'EWALLET']),
  institution: z.string().trim().min(2).max(120),
  accountNo: z.string().trim().min(4).max(64),
  accountName: z.string().trim().min(2).max(120).optional(),
  setDefault: z.boolean().optional(),
});

function toCents(amount: string): bigint {
  const [i, d = ''] = amount.split('.');
  return BigInt(i) * 100n + BigInt((d + '00').slice(0, 2));
}

export function paginateWalletEntries<T extends { id: string }>(entries: T[], limit: number) {
  const page = entries.slice(0, limit);
  return {
    page,
    nextCursor: entries.length > limit ? page.at(-1)?.id ?? null : null,
  };
}

export type WalletOrderKind = 'deposit' | 'withdrawal';

export interface WalletOrderRef {
  id: string;
  kind: WalletOrderKind;
  createdAt: Date;
}

export interface WalletOrderCursor extends WalletOrderRef {}

const walletOrderCursorPayload = z.object({
  version: z.literal(1),
  id: z.string().min(1).max(128),
  kind: z.enum(['deposit', 'withdrawal']),
  createdAt: z.string().datetime(),
});

function compareWalletOrders(a: WalletOrderRef, b: WalletOrderRef): number {
  const byDate = b.createdAt.getTime() - a.createdAt.getTime();
  if (byDate !== 0) return byDate;
  if (a.kind !== b.kind) return a.kind === 'deposit' ? -1 : 1;
  return b.id.localeCompare(a.id);
}

function encodeWalletOrderCursor(cursor: WalletOrderRef): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      id: cursor.id,
      kind: cursor.kind,
      createdAt: cursor.createdAt.toISOString(),
    }),
  ).toString('base64url');
}

export function decodeWalletOrderCursor(value: string): WalletOrderCursor | null {
  try {
    const payload = walletOrderCursorPayload.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    return {
      id: payload.id,
      kind: payload.kind,
      createdAt: new Date(payload.createdAt),
    };
  } catch {
    return null;
  }
}

export function walletOrderIsAfterCursor(
  order: WalletOrderRef,
  cursor: WalletOrderCursor,
): boolean {
  return compareWalletOrders(order, cursor) > 0;
}

export function paginateWalletOrders<T extends WalletOrderRef>(
  candidates: T[],
  limit: number,
) {
  const ordered = [...candidates].sort(compareWalletOrders);
  const page = ordered.slice(0, limit);
  return {
    page,
    nextCursor:
      ordered.length > limit && page.length
        ? encodeWalletOrderCursor(page[page.length - 1]!)
        : null,
  };
}

async function getCurrentPayee() {
  const current = await prisma.depositPayeeAccount.findFirst({
    where: { status: 'ACTIVE', isCurrent: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  if (current) return current;
  return prisma.depositPayeeAccount.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

function publicPayee(row: {
  id: string;
  bankName: string;
  accountNo: string;
  accountName: string;
  label: string | null;
}) {
  return {
    id: row.id,
    bankName: row.bankName,
    accountNo: decryptSecret(row.accountNo),
    accountName: decryptSecret(row.accountName),
    label: row.label,
  };
}

export async function walletRoutes(app: FastifyInstance) {
  /** 余额 + 流水（支持分类筛选 / 分页） */
  app.get('/api/wallet', { preHandler: [app.authUser, app.requireKyc] }, async (req) => {
    const userId = (req.user as { sub: string }).sub;
    const { cursor, limit, scope, category } = pageSchema.parse(req.query);
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    const refTypes = category === 'all' ? null : LEDGER_CATEGORIES[category];
    const entries = await prisma.ledgerEntry.findMany({
      where: {
        userId,
        ...(scope === 'available' ? { accountType: 'USER_AVAILABLE' } : {}),
        ...(refTypes ? { refType: { in: refTypes } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    const { page, nextCursor } = paginateWalletEntries(entries, limit);
    return {
      balance: {
        availableCents: String(wallet.availableCents),
        freezeBankerCents: String(wallet.freezeBankerCents),
        freezeBetCents: String(wallet.freezeBetCents),
        freezeWithdrawCents: String(wallet.freezeWithdrawCents),
      },
      filter: { scope, category },
      entries: page.map((entry) => ({
        id: entry.id,
        accountType: entry.accountType,
        direction: entry.direction,
        amountCents: String(entry.amountCents),
        refType: entry.refType,
        refId: entry.refId,
        roundId: entry.roundId,
        memo: entry.memo,
        createdAt: entry.createdAt,
      })),
      nextCursor,
    };
  });


  /** 马来西亚银行 / 电子钱包目录 */
  app.get('/api/wallet/payment-institutions', { preHandler: [app.authUser] }, async () => ({
    banks: MALAYSIA_BANKS,
    ewallets: MALAYSIA_EWALLETS,
  }));

  /** 当前充值收款账户（玩家端展示） */
  app.get('/api/wallet/deposit-payee', { preHandler: [app.authUser, app.requireKyc] }, async (_req, reply) => {
    const payee = await getCurrentPayee();
    if (!payee) return reply.code(404).send({ error: 'NO_DEPOSIT_PAYEE' });
    return { payee: publicPayee(payee) };
  });

  /** 充值申请（人工确认，见 P-WAL-05） */
  app.post('/api/wallet/deposit', { preHandler: [app.authUser, app.requireKyc] }, async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const body = depositSchema.parse(req.body);
    const amountCents = toCents(body.amount);

    const replay = await prisma.depositOrder.findUnique({
      where: {
        userId_requestId: { userId, requestId: body.requestId },
      },
    });
    if (replay) {
      const payeeChanged =
        body.payeeAccountId !== undefined && replay.payeeAccountId !== body.payeeAccountId;
      const proofChanged = replay.proofUrl !== body.proofUrl;
      if (replay.amountCents !== amountCents || payeeChanged || proofChanged) {
        return reply.code(409).send({ error: 'IDEMPOTENCY_CONFLICT' });
      }
      return {
        ok: true,
        orderId: replay.id,
        status: replay.status,
        duplicate: true,
      };
    }

    let payee = body.payeeAccountId
      ? await prisma.depositPayeeAccount.findFirst({
          where: { id: body.payeeAccountId, status: 'ACTIVE' },
        })
      : null;
    if (!payee) payee = await getCurrentPayee();
    if (!payee) return reply.code(409).send({ error: 'NO_DEPOSIT_PAYEE' });

    const snapshot = {
      bankName: payee.bankName,
      accountNo: payee.accountNo,
      accountName: payee.accountName,
      label: payee.label,
    };

    try {
      const result = await serializable(async (tx) => {
        const existing = await tx.depositOrder.findUnique({
          where: {
            userId_requestId: { userId, requestId: body.requestId },
          },
        });
        if (existing) {
          const payeeChanged =
            body.payeeAccountId !== undefined &&
            existing.payeeAccountId !== body.payeeAccountId;
          const proofChanged = existing.proofUrl !== body.proofUrl;
          if (existing.amountCents !== amountCents || payeeChanged || proofChanged) {
            throw new Error('IDEMPOTENCY_CONFLICT');
          }
          return { order: existing, duplicate: true };
        }
        const order = await tx.depositOrder.create({
          data: {
            userId,
            requestId: body.requestId,
            amountCents,
            proofUrl: body.proofUrl,
            payeeAccountId: payee.id,
            payeeSnapshot: snapshot,
          },
        });
        return { order, duplicate: false };
      });
      return {
        ok: true,
        orderId: result.order.id,
        status: result.order.status,
        duplicate: result.duplicate,
      };
    } catch (error) {
      if ((error as Error).message === 'IDEMPOTENCY_CONFLICT') {
        return reply.code(409).send({ error: 'IDEMPOTENCY_CONFLICT' });
      }
      if ((error as { code?: string }).code === 'P2002') {
        const concurrent = await prisma.depositOrder.findUnique({
          where: {
            userId_requestId: { userId, requestId: body.requestId },
          },
        });
        if (
          concurrent
          && concurrent.channel === 'MANUAL'
          && concurrent.amountCents === amountCents
          && concurrent.payeeAccountId === payee.id
          && concurrent.proofUrl === body.proofUrl
        ) {
          return {
            ok: true,
            orderId: concurrent.id,
            status: concurrent.status,
            duplicate: true,
          };
        }
        return reply.code(409).send({ error: 'IDEMPOTENCY_CONFLICT' });
      }
      throw error;
    }
  });

  /** 玩家提现账户列表（无则从 KYC 种子） */
  app.get('/api/wallet/withdraw-accounts', { preHandler: [app.authUser, app.requireKyc] }, async (req) => {
    const userId = (req.user as { sub: string }).sub;
    await ensureKycWithdrawAccounts(userId);
    const items = await prisma.withdrawAccount.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    return { items: items.map(serializeWithdrawAccount) };
  });

  /** 新增提现账户（待审核） */
  app.post('/api/wallet/withdraw-accounts', { preHandler: [app.authUser, app.requireKyc] }, async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const body = addAccountSchema.parse(req.body);
    if (!isKnownInstitution(body.type, body.institution)) {
      return reply.code(400).send({ error: 'UNKNOWN_INSTITUTION' });
    }

    await ensureKycWithdrawAccounts(userId);
    const kyc = await prisma.kyc.findUniqueOrThrow({ where: { userId } });
    const accountName = body.accountName?.trim() || decryptSecret(kyc.realName);

    const pendingCount = await prisma.withdrawAccount.count({
      where: { userId, status: 'PENDING' },
    });
    if (pendingCount >= 5) return reply.code(429).send({ error: 'TOO_MANY_PENDING' });

    const item = await prisma.withdrawAccount.create({
      data: {
        userId,
        type: body.type,
        institution: body.institution,
        accountNo: encryptSecret(body.accountNo.replace(/\s+/g, '')),
        accountName: encryptSecret(accountName),
        isDefault: false,
        status: 'PENDING',
        source: 'user',
      },
    });
    return { ok: true, item: serializeWithdrawAccount(item) };
  });

  /** 修改提现账户（修改后回到待审核） */
  app.patch('/api/wallet/withdraw-accounts/:id', { preHandler: [app.authUser, app.requireKyc] }, async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const { id } = req.params as { id: string };
    const body = addAccountSchema.parse(req.body);
    if (!isKnownInstitution(body.type, body.institution)) {
      return reply.code(400).send({ error: 'UNKNOWN_INSTITUTION' });
    }

    const existing = await prisma.withdrawAccount.findFirst({ where: { id, userId } });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND' });

    const kyc = await prisma.kyc.findUniqueOrThrow({ where: { userId } });
    const accountName = body.accountName?.trim() || decryptSecret(kyc.realName);

    const item = await prisma.withdrawAccount.update({
      where: { id },
      data: {
        type: body.type,
        institution: body.institution,
        accountNo: encryptSecret(body.accountNo.replace(/\s+/g, '')),
        accountName: encryptSecret(accountName),
        status: 'PENDING',
        rejectReason: null,
        reviewedBy: null,
        reviewedAt: null,
        // 用户手动修改后按用户来源管理
        source: existing.source === 'kyc' ? 'kyc' : 'user',
      },
    });

    // 若改成非默认仍保留 isDefault；若当前是默认但被打回待审，取消默认并选其它已通过
    if (item.isDefault) {
      await prisma.$transaction(async (tx) => {
        await tx.withdrawAccount.update({ where: { id }, data: { isDefault: false } });
        const fallback = await tx.withdrawAccount.findFirst({
          where: { userId, status: 'APPROVED', id: { not: id } },
          orderBy: { createdAt: 'asc' },
        });
        if (fallback) {
          await tx.withdrawAccount.update({
            where: { id: fallback.id },
            data: { isDefault: true },
          });
        }
      });
    }

    const refreshed = await prisma.withdrawAccount.findUniqueOrThrow({ where: { id } });
    return { ok: true, item: serializeWithdrawAccount(refreshed) };
  });

  /** 设置默认提现账户（仅已通过） */
  app.post('/api/wallet/withdraw-accounts/:id/default', { preHandler: [app.authUser, app.requireKyc] }, async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const { id } = req.params as { id: string };
    const account = await prisma.withdrawAccount.findFirst({ where: { id, userId } });
    if (!account) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (account.status !== 'APPROVED') return reply.code(409).send({ error: 'NOT_APPROVED' });

    await prisma.$transaction([
      prisma.withdrawAccount.updateMany({ where: { userId }, data: { isDefault: false } }),
      prisma.withdrawAccount.update({ where: { id }, data: { isDefault: true } }),
    ]);
    return { ok: true };
  });

  /** 删除提现账户 */
  app.delete('/api/wallet/withdraw-accounts/:id', { preHandler: [app.authUser, app.requireKyc] }, async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const { id } = req.params as { id: string };
    const existing = await prisma.withdrawAccount.findFirst({ where: { id, userId } });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND' });

    const remaining = await prisma.withdrawAccount.count({ where: { userId, id: { not: id } } });
    if (remaining === 0) {
      return reply.code(409).send({ error: 'LAST_ACCOUNT' });
    }

    await prisma.$transaction(async (tx) => {
      await tx.withdrawOrder.updateMany({
        where: { withdrawAccountId: id },
        data: { withdrawAccountId: null },
      });
      await tx.withdrawAccount.delete({ where: { id } });
      if (existing.isDefault) {
        const fallback = await tx.withdrawAccount.findFirst({
          where: { userId, status: 'APPROVED' },
          orderBy: { createdAt: 'asc' },
        });
        if (fallback) {
          await tx.withdrawAccount.update({
            where: { id: fallback.id },
            data: { isDefault: true },
          });
        }
      }
    });

    return { ok: true };
  });

  /** 玩家查看自己的充提工单状态 */
  app.get('/api/wallet/orders', { preHandler: [app.authUser, app.requireKyc] }, async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const query = z
      .object({
        cursor: z.string().min(1).max(512).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(50),
      })
      .parse(req.query);
    const cursor = query.cursor ? decodeWalletOrderCursor(query.cursor) : null;
    if (query.cursor && !cursor) {
      return reply.code(400).send({ error: 'INVALID_ORDER_CURSOR' });
    }

    const [depositRows, withdrawalRows] = await Promise.all([
      prisma.depositOrder.findMany({
        where: {
          userId,
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  ...(cursor.kind === 'deposit'
                    ? [{ createdAt: cursor.createdAt, id: { lt: cursor.id } }]
                    : []),
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      }),
      prisma.withdrawOrder.findMany({
        where: {
          userId,
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  cursor.kind === 'withdrawal'
                    ? { createdAt: cursor.createdAt, id: { lt: cursor.id } }
                    : { createdAt: cursor.createdAt },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      }),
    ]);
    const page = paginateWalletOrders(
      [
        ...depositRows.map((order) => ({
          id: order.id,
          kind: 'deposit' as const,
          createdAt: order.createdAt,
          order,
        })),
        ...withdrawalRows.map((order) => ({
          id: order.id,
          kind: 'withdrawal' as const,
          createdAt: order.createdAt,
          order,
        })),
      ],
      query.limit,
    );
    const deposits = page.page.flatMap((item) =>
      item.kind === 'deposit' ? [item.order] : [],
    );
    const withdrawals = page.page.flatMap((item) =>
      item.kind === 'withdrawal' ? [item.order] : [],
    );
    return {
      nextCursor: page.nextCursor,
      deposits: deposits.map((order) => ({
        id: order.id,
        channel: order.channel,
        amountCents: String(order.amountCents),
        status: order.status,
        rejectReason: order.rejectReason,
        proofUrl: order.proofUrl,
        payUrl:
          order.channel === 'VPAY' && order.status === 'PENDING'
            ? order.payUrl
            : null,
        createdAt: order.createdAt,
      })),
      withdrawals: withdrawals.map((order) => {
        const { feeCents, netCents } = withdrawalAmounts(
          order.amountCents,
          order.targetSnapshot,
        );
        return {
          id: order.id,
          amountCents: String(order.amountCents),
          feeCents: String(feeCents),
          netCents: String(netCents),
          channel: order.channel,
          status: order.status,
          rejectReason: order.rejectReason,
          createdAt: order.createdAt,
        };
      }),
    };
  });

  /** 提现规则 + 今日免费次数 */
  app.get('/api/wallet/withdraw-info', { preHandler: [app.authUser, app.requireKyc] }, async (req) => {
    const userId = (req.user as { sub: string }).sub;
    const config = await getGameConfig(
      PLATFORM_CONFIG_SCOPE,
      'withdraw',
      DEFAULT_WITHDRAW_CONFIG,
    );
    const day = malaysiaDay();
    const from = new Date(`${day}T00:00:00+08:00`);
    const until = new Date(from);
    until.setUTCDate(until.getUTCDate() + 1);
    const usedToday = await prisma.withdrawOrder.count({
      where: {
        userId,
        status: { in: ['PENDING', 'COMPLETED'] },
        createdAt: { gte: from, lt: until },
      },
    });
    const freeDailyLimit = Math.max(0, Number(config.freeDailyLimit ?? DEFAULT_WITHDRAW_CONFIG.freeDailyLimit));
    const freeRemaining = Math.max(0, freeDailyLimit - usedToday);
    return {
      minCents: String(config.minCents ?? DEFAULT_WITHDRAW_CONFIG.minCents),
      freeDailyLimit,
      freeRemaining,
      usedToday,
      feeRatioAfterFree: Number(config.feeRatioAfterFree ?? DEFAULT_WITHDRAW_CONFIG.feeRatioAfterFree),
      date: day,
    };
  });

  /** 提现申请（冻结后人工审核，见 P-WAL-06） */
  app.post('/api/wallet/withdraw', { preHandler: [app.authUser, app.requireKyc] }, async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const body = withdrawSchema.parse(req.body);
    const amountCents = toCents(body.amount);

    const replay = await prisma.withdrawOrder.findUnique({
      where: {
        userId_requestId: { userId, requestId: body.requestId },
      },
    });
    if (replay) {
      if (
        replay.amountCents !== amountCents ||
        replay.withdrawAccountId !== body.accountId
      ) {
        return reply.code(409).send({ error: 'IDEMPOTENCY_CONFLICT' });
      }
      const feeCents = withdrawFeeCents(replay.targetSnapshot);
      return {
        ok: true,
        orderId: replay.id,
        status: replay.status,
        feeCents: String(feeCents),
        netCents: String(replay.amountCents - feeCents),
        freeQuota: withdrawUsedFreeQuota(replay.targetSnapshot),
        duplicate: true,
      };
    }

    const config = await getGameConfig(
      PLATFORM_CONFIG_SCOPE,
      'withdraw',
      DEFAULT_WITHDRAW_CONFIG,
    );
    const minCents = BigInt(config.minCents ?? DEFAULT_WITHDRAW_CONFIG.minCents);
    if (amountCents < minCents) {
      return reply.code(400).send({ error: 'BELOW_MIN_WITHDRAW', minCents: String(minCents) });
    }

    // 自助换绑设备后 24 小时暂停提现：盗号者即使知道支付密码也无法立即转走资金
    const device = await prisma.device.findUnique({
      where: { userId },
      select: { lastSelfRebindAt: true },
    });
    if (
      device?.lastSelfRebindAt &&
      Date.now() - device.lastSelfRebindAt.getTime() < 24 * 60 * 60 * 1000
    ) {
      const unlockedAt = new Date(device.lastSelfRebindAt.getTime() + 24 * 60 * 60 * 1000);
      return reply.code(403).send({
        error: 'WITHDRAW_LOCKED_AFTER_REBIND',
        message: '设备换绑后 24 小时内暂停提现，以保障资金安全',
        unlockedAt: unlockedAt.toISOString(),
      });
    }

    const paymentPinVersion = await verifyPaymentPin(userId, body.paymentPin);
    await ensureKycWithdrawAccounts(userId);
    const day = malaysiaDay();
    const from = new Date(`${day}T00:00:00+08:00`);
    const until = new Date(from);
    until.setUTCDate(until.getUTCDate() + 1);
    const freeDailyLimit = Math.max(0, Number(config.freeDailyLimit ?? DEFAULT_WITHDRAW_CONFIG.freeDailyLimit));
    const feeRatio = Number(config.feeRatioAfterFree ?? DEFAULT_WITHDRAW_CONFIG.feeRatioAfterFree);

    try {
      const result = await serializable(async (tx) => {
        const existing = await tx.withdrawOrder.findUnique({
          where: {
            userId_requestId: { userId, requestId: body.requestId },
          },
        });
        if (existing) {
          if (
            existing.amountCents !== amountCents ||
            existing.withdrawAccountId !== body.accountId
          ) {
            throw new Error('IDEMPOTENCY_CONFLICT');
          }
          return {
            order: existing,
            feeCents: withdrawFeeCents(existing.targetSnapshot),
            freeQuota: withdrawUsedFreeQuota(existing.targetSnapshot),
            duplicate: true,
          };
        }

        await assertPaymentPinVersion(tx, userId, paymentPinVersion);
        const account = await tx.withdrawAccount.findFirst({
          where: { id: body.accountId, userId, status: 'APPROVED' },
        });
        if (!account) throw new Error('INVALID_WITHDRAW_ACCOUNT');

        const usedToday = await tx.withdrawOrder.count({
          where: {
            userId,
            status: { in: ['PENDING', 'COMPLETED'] },
            createdAt: { gte: from, lt: until },
          },
        });
        const isFree = usedToday < freeDailyLimit;
        const feeCents = isFree
          ? 0n
          : (amountCents * BigInt(Math.round(feeRatio * 1_000_000)) + 500_000n) /
            1_000_000n;
        const targetSnapshot = {
          type: account.type,
          institution: account.institution,
          // 快照同样属于敏感资料；沿用 WithdrawAccount 的密文，后台展示时再解密。
          accountNo: account.accountNo,
          accountName: account.accountName,
          channel: account.type === 'BANK' ? 'bank' : 'ewallet',
          feeCents: String(feeCents),
          feeRatio: isFree ? 0 : feeRatio,
          freeQuota: isFree,
        };
        const created = await tx.withdrawOrder.create({
          data: {
            userId,
            requestId: body.requestId,
            amountCents,
            channel: targetSnapshot.channel,
            withdrawAccountId: account.id,
            targetSnapshot,
          },
        });
        await transfer(tx, {
          amountCents,
          from: { userId, accountType: 'USER_AVAILABLE' },
          to: { userId, accountType: 'USER_FREEZE_WITHDRAW' },
          refType: 'withdraw_freeze',
          refId: created.id,
          idempotencyKey: `withdraw:${created.id}`,
        });
        return { order: created, feeCents, freeQuota: isFree, duplicate: false };
      });
      return {
        ok: true,
        orderId: result.order.id,
        status: result.order.status,
        feeCents: String(result.feeCents),
        netCents: String(result.order.amountCents - result.feeCents),
        freeQuota: result.freeQuota,
        duplicate: result.duplicate,
      };
    } catch (e) {
      const code = (e as Error & { code?: string }).code ?? (e as Error).message;
      if (code === 'INSUFFICIENT_BALANCE') {
        return reply.code(400).send({ error: 'INSUFFICIENT_BALANCE' });
      }
      if (code === 'INVALID_WITHDRAW_ACCOUNT') {
        return reply.code(400).send({ error: 'INVALID_WITHDRAW_ACCOUNT' });
      }
      if (code === 'IDEMPOTENCY_CONFLICT') {
        return reply.code(409).send({ error: 'IDEMPOTENCY_CONFLICT' });
      }
      if (code === 'P2002') {
        const concurrent = await prisma.withdrawOrder.findUnique({
          where: {
            userId_requestId: { userId, requestId: body.requestId },
          },
        });
        if (
          concurrent
          && concurrent.amountCents === amountCents
          && concurrent.withdrawAccountId === body.accountId
        ) {
          const feeCents = withdrawFeeCents(concurrent.targetSnapshot);
          return {
            ok: true,
            orderId: concurrent.id,
            status: concurrent.status,
            feeCents: String(feeCents),
            netCents: String(concurrent.amountCents - feeCents),
            freeQuota: withdrawUsedFreeQuota(concurrent.targetSnapshot),
            duplicate: true,
          };
        }
        return reply.code(409).send({ error: 'IDEMPOTENCY_CONFLICT' });
      }
      throw e;
    }
  });
}
