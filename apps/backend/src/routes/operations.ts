import { AccountType, ClaimSource, MessageType, Prisma, RewardTab } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  blindIndex,
  decryptSecret,
  encryptSecret,
  kycSearchHashes,
  maskPlaintext,
  safeDecryptSecret,
  safeMaskSecret,
  UNREADABLE_SECRET,
} from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';
import { serializable } from '../lib/transaction.js';
import {
  distributeLeaderboardRewards,
  generateAllLeaderboards,
  leaderboardDashboard,
} from '../services/leaderboards.js';
import { pushService } from '../services/push.js';
import { estimatedCommission, malaysiaDay, settleRebates } from '../services/rebates.js';
import { grantReward, rewardDashboard } from '../services/rewards.js';
import {
  ensureSupportWelcome,
  handleUserSupportMessage,
  resolveAvatarUrl,
} from '../services/supportAutoReply.js';
import { transfer } from '../services/wallet.js';
import { recordClaim } from '../services/game.js';
import { gameBus } from '../services/gameBus.js';
import { reloadBots, validateBotCredentials } from '../bot/index.js';
import { broadcastUserProfileChanged } from '../services/roomHub.js';
import {
  isSupportedGameCode,
  SUPREME_NIUNIU_GAME_CODE,
} from '../services/gameCatalog.js';

const cuid = z.string().cuid();
const compatibleId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const positiveCents = z.string().regex(/^[1-9]\d*$/);
const gameCode = z.string().refine(isSupportedGameCode, {
  message: 'GAME_NOT_SUPPORTED',
});
const profileUpdateSchema = z
  .object({
    nickname: z.string().trim().min(1).max(80).nullable().optional(),
    tgUsername: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_]{5,64}$/)
      .nullable()
      .optional(),
    tgDisplayName: z.string().trim().min(1).max(160).nullable().optional(),
    avatarUrl: z
      .string()
      .trim()
      .max(2_048)
      .refine((value) => value.startsWith('/') || /^https?:\/\//i.test(value), {
        message: 'INVALID_AVATAR_URL',
      })
      .nullable()
      .optional(),
    reason: z.string().trim().min(4).max(500),
  })
  .strict()
  .refine(
    (value) =>
      value.nickname !== undefined ||
      value.tgUsername !== undefined ||
      value.tgDisplayName !== undefined ||
      value.avatarUrl !== undefined,
    { message: 'NO_PROFILE_CHANGES' },
  );
const kycUpdateSchema = z
  .object({
    realName: z.string().trim().min(1).max(100),
    duitnowId: z.string().trim().min(3).max(100),
    /** 兼容旧后台表单；新流程银行卡请走提现账户管理。 */
    bankName: z.string().trim().max(100).optional().default(''),
    bankAccount: z.string().trim().max(100).optional().default(''),
    accountHolder: z.string().trim().max(100).optional().default(''),
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
    rejectReason: z.string().trim().min(2).max(500).nullable().optional(),
    reason: z.string().trim().min(4).max(500),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === 'REJECTED' && !value.rejectReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'REJECT_REASON_REQUIRED',
        path: ['rejectReason'],
      });
    }
  });
const withdrawAccountUpdateSchema = z
  .object({
    type: z.enum(['BANK', 'EWALLET']),
    institution: z.string().trim().min(2).max(120),
    accountNo: z.string().trim().min(3).max(100),
    accountName: z.string().trim().min(1).max(100),
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
    rejectReason: z.string().trim().min(2).max(500).nullable().optional(),
    isDefault: z.boolean().optional(),
    reason: z.string().trim().min(4).max(500),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === 'REJECTED' && !value.rejectReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'REJECT_REASON_REQUIRED',
        path: ['rejectReason'],
      });
    }
    if (value.isDefault === true && value.status !== 'APPROVED') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DEFAULT_REQUIRES_APPROVED',
        path: ['isDefault'],
      });
    }
  });

function revealOrderSnapshot(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const snapshot = { ...(value as Record<string, unknown>) };
  for (const field of ['accountNo', 'accountName', 'duitnowId', 'name', 'bankAccount', 'holder']) {
    if (typeof snapshot[field] === 'string') snapshot[field] = safeDecryptSecret(snapshot[field]);
  }
  return snapshot;
}

export async function operationsRoutes(app: FastifyInstance) {
  app.get('/api/rewards', { preHandler: [app.authUser] }, async (req) => {
    const userId = (req.user as { sub: string }).sub;
    const query = z
      .object({
        gameCode: gameCode.default(SUPREME_NIUNIU_GAME_CODE),
        date: date.optional(),
      })
      .parse(req.query);
    return rewardDashboard(query.gameCode, userId, query.date);
  });

  app.get('/api/leaderboards', { preHandler: [app.authUser] }, async (req) => {
    const { gameCode: scopedGameCode, period } = z
      .object({
        gameCode: gameCode.default(SUPREME_NIUNIU_GAME_CODE),
        period: z.enum(['daily', 'weekly', 'monthly']).default('daily'),
      })
      .parse(req.query);
    return leaderboardDashboard(scopedGameCode, period);
  });

  app.get('/api/chat/stickers', { preHandler: [app.authUser] }, async () => ({
    items: await prisma.stickerAsset.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
  }));

  /** 消息中心预览：未读数 + 最新一条，不标记已读 */
  app.get('/api/chat/preview', { preHandler: [app.authUser] }, async (req) => {
    const userId = (req.user as { sub: string }).sub;
    await ensureSupportWelcome(userId);
    const [unread, latest] = await Promise.all([
      prisma.chatMessage.count({
        where: { userId, senderType: { in: ['SUPPORT', 'SYSTEM'] }, readAt: null },
      }),
      prisma.chatMessage.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          senderType: true,
          type: true,
          content: true,
          assetUrl: true,
          createdAt: true,
        },
      }),
    ]);
    return { unread, latest };
  });

  app.get('/api/chat/messages', { preHandler: [app.authUser] }, async (req) => {
    const userId = (req.user as { sub: string }).sub;
    const { cursor, limit } = z
      .object({ cursor: cuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
      .parse(req.query);
    if (!cursor) await ensureSupportWelcome(userId);
    const rows = await prisma.chatMessage.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, limit).reverse();
    const visibleUnreadIds = items
      .filter(
        (message) =>
          (message.senderType === 'SUPPORT' || message.senderType === 'SYSTEM')
          && message.readAt === null,
      )
      .map((message) => message.id);
    if (visibleUnreadIds.length) {
      await prisma.chatMessage.updateMany({
        where: { id: { in: visibleUnreadIds }, userId, readAt: null },
        data: { readAt: new Date() },
      });
    }
    return {
      items,
      // 下一页从本页最后一条之后开始；不能指向首条未返回记录再 skip，否则每页漏一条。
      nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
    };
  });

  app.post('/api/chat/messages', { preHandler: [app.authUser] }, async (req) => {
    const userId = (req.user as { sub: string }).sub;
    const body = z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('TEXT'), content: z.string().trim().min(1).max(2_000) }),
        z.object({ type: z.literal('EMOJI'), content: z.string().trim().min(1).max(100) }),
        z.object({ type: z.literal('STICKER'), stickerId: cuid }),
      ])
      .parse(req.body);
    let content: string | undefined;
    let assetUrl: string | undefined;
    if (body.type === 'STICKER') {
      const sticker = await prisma.stickerAsset.findFirst({
        where: { id: body.stickerId, status: 'ACTIVE' },
      });
      if (!sticker) throw new Error('STICKER_NOT_FOUND');
      content = sticker.name;
      assetUrl = sticker.url;
    } else {
      content = body.content;
    }
    const message = await prisma.chatMessage.create({
      data: { userId, senderType: 'USER', type: body.type, content, assetUrl },
    });
    const autoReplies = await handleUserSupportMessage({
      userId,
      content: content ?? '',
      type: body.type,
    });
    return { ok: true, message, autoReplies };
  });
}

export async function adminOperationsRoutes(app: FastifyInstance) {
  const operators = [app.authAdmin, app.requireAdminRoles('SUPER', 'OPERATOR')];
  /** 用户中心可读：运营 / 审核 / 财务均可查档案、流水、牌局 */
  const userReaders = [
    app.authAdmin,
    app.requireAdminRoles('SUPER', 'OPERATOR', 'REVIEWER', 'FINANCE'),
  ];
  const support = [
    app.authAdmin,
    app.requireAdminRoles('SUPER', 'OPERATOR', 'REVIEWER'),
  ];
  const noteEditors = [
    app.authAdmin,
    app.requireAdminRoles('SUPER', 'OPERATOR', 'REVIEWER'),
  ];
  /** 提款账户可改：运营 / 审核 / 财务（打款核对时需修正账号） */
  const withdrawAccountEditors = [
    app.authAdmin,
    app.requireAdminRoles('SUPER', 'OPERATOR', 'REVIEWER', 'FINANCE'),
  ];
  const finance = [app.authAdmin, app.requireAdminRoles('SUPER', 'FINANCE')];
  const rewardReaders = [
    app.authAdmin,
    app.requireAdminRoles('SUPER', 'OPERATOR', 'REVIEWER', 'FINANCE'),
  ];
  const tngManagers = [
    app.authAdmin,
    app.requireAdminRoles('SUPER', 'OPERATOR', 'FINANCE'),
  ];
  const leaderboardManagers = [
    app.authAdmin,
    app.requireAdminRoles('SUPER', 'OPERATOR', 'FINANCE'),
  ];

  // ── 用户中心 / 设备 / 风控 ──
  app.get('/api/admin/users', { preHandler: userReaders }, async (req) => {
    const query = z
      .object({
        q: z.string().trim().max(100).optional(),
        status: z.enum(['ACTIVE', 'BANNED']).optional(),
        /** @deprecated 兼容旧客户端；优先使用 page/pageSize */
        limit: z.coerce.number().int().min(1).max(200).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
      })
      .parse(req.query);
    const pageSize = query.limit ?? query.pageSize;
    const page = query.limit ? 1 : query.page;
    const search = query.q;
    const tgIdCandidate = search && /^\d{1,19}$/.test(search) ? BigInt(search) : undefined;
    const tgId =
      tgIdCandidate !== undefined && tgIdCandidate <= 9_223_372_036_854_775_807n
        ? tgIdCandidate
        : undefined;
    const last4 = search && /^\d{4}$/.test(search) ? search : undefined;
    const where: Prisma.UserWhereInput = {
      status: query.status,
      ...(search
        ? {
            OR: [
              { uid: { contains: search } },
              { nickname: { contains: search, mode: 'insensitive' } },
              { tgUsername: { contains: search.replace(/^@/, ''), mode: 'insensitive' } },
              { tgDisplayName: { contains: search, mode: 'insensitive' } },
              ...(tgId ? [{ tgId }] : []),
              { kyc: { is: { realNameHash: blindIndex(search) } } },
              { kyc: { is: { duitnowHash: blindIndex(search) } } },
              { kyc: { is: { bankAccountHash: blindIndex(search.replace(/\s+/g, '')) } } },
              ...(last4 ? [{ kyc: { is: { bankAccountLast4Hash: blindIndex(last4) } } }] : []),
            ],
          }
        : {}),
    };
    const [total, items] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        include: {
          wallet: true,
          kyc: true,
          device: true,
          paymentPin: {
            select: {
              isSet: true,
              lockedUntil: true,
              setAt: true,
            },
          },
          inviter: { select: { uid: true, nickname: true } },
          _count: { select: { invitees: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      items: items.map((user) => ({
        id: user.id,
        uid: user.uid,
        tgId: user.tgId != null ? String(user.tgId) : null,
        kind: user.kind,
        nickname: user.nickname,
        status: user.status,
        adminNote: user.adminNote,
        inviter: user.inviter,
        invitees: user._count.invitees,
        device: user.device
          ? { status: user.device.status, boundAt: user.device.boundAt }
          : null,
        paymentPin: {
          set: Boolean(user.paymentPin?.isSet),
          lockedUntil: user.paymentPin?.isSet ? user.paymentPin.lockedUntil : null,
        },
        kyc: user.kyc
          ? {
              status: user.kyc.status,
              realName: safeDecryptSecret(user.kyc.realName),
              duitnowId: safeMaskSecret(user.kyc.duitnowId),
              bankName: user.kyc.bankName,
              bankAccount: safeMaskSecret(user.kyc.bankAccount),
            }
          : null,
        wallet: user.wallet,
        createdAt: user.createdAt,
      })),
      total,
      page,
      pageSize,
    };
  });

  app.get('/api/admin/users/:id', { preHandler: userReaders }, async (req, reply) => {
    const { id } = z.object({ id: cuid }).parse(req.params);
    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        wallet: true,
        kyc: true,
        device: true,
        paymentPin: {
          select: {
            isSet: true,
            failedAttempts: true,
            lockedUntil: true,
            version: true,
            setAt: true,
            updatedAt: true,
          },
        },
        inviter: { select: { id: true, uid: true, nickname: true } },
        withdrawAccounts: {
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
          select: {
            id: true,
            type: true,
            institution: true,
            accountNo: true,
            accountName: true,
            isDefault: true,
            status: true,
            source: true,
            rejectReason: true,
            reviewedBy: true,
            reviewedAt: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        _count: {
          select: {
            invitees: true,
            bids: true,
            bets: true,
            claims: true,
            settlements: true,
            rewardGrants: true,
            depositOrders: true,
            withdrawOrders: true,
            roomMemberships: true,
          },
        },
      },
    });
    if (!user) return reply.code(404).send({ error: 'USER_NOT_FOUND' });

    const [grandInviter, bankerRounds, auditLogs] = await Promise.all([
      user.grandInviterId
        ? prisma.user.findUnique({
            where: { id: user.grandInviterId },
            select: { id: true, uid: true, nickname: true },
          })
        : null,
      prisma.round.count({ where: { bankerId: id } }),
      prisma.auditLog.findMany({
        where: { target: id },
        orderBy: { createdAt: 'desc' },
        take: 30,
        select: { id: true, adminId: true, action: true, createdAt: true },
      }),
    ]);

    return {
      user: {
        id: user.id,
        uid: user.uid,
        tgId: user.tgId != null ? String(user.tgId) : null,
        kind: user.kind,
        nickname: user.nickname,
        tgUsername: user.tgUsername,
        tgDisplayName: user.tgDisplayName,
        avatarUrl: user.avatarUrl,
        status: user.status,
        adminNote: user.adminNote,
        inviter: user.inviter,
        grandInviter,
        inviterBoundAt: user.inviterBoundAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      wallet: user.wallet,
      kyc: user.kyc
        ? {
            id: user.kyc.id,
            realName: safeDecryptSecret(user.kyc.realName),
            duitnowId: safeDecryptSecret(user.kyc.duitnowId),
            bankName: user.kyc.bankName,
            bankAccount: safeDecryptSecret(user.kyc.bankAccount),
            accountHolder: safeDecryptSecret(user.kyc.accountHolder),
            status: user.kyc.status,
            rejectReason: user.kyc.rejectReason,
            reviewedBy: user.kyc.reviewedBy,
            reviewedAt: user.kyc.reviewedAt,
            submittedAt: user.kyc.submittedAt,
          }
        : null,
      device: user.device
        ? {
            id: user.device.id,
            deviceIdMasked: user.device.deviceId.length > 8
              ? `••••${user.device.deviceId.slice(-8)}`
              : '••••••••',
            status: user.device.status,
            boundAt: user.device.boundAt,
          }
        : null,
      paymentPin: {
        set: Boolean(user.paymentPin?.isSet),
        failedAttempts: user.paymentPin?.isSet ? user.paymentPin.failedAttempts : 0,
        lockedUntil: user.paymentPin?.isSet ? user.paymentPin.lockedUntil : null,
        version: user.paymentPin?.version ?? null,
        setAt: user.paymentPin?.isSet ? user.paymentPin.setAt : null,
        updatedAt: user.paymentPin?.updatedAt ?? null,
      },
      withdrawAccounts: user.withdrawAccounts.map((account) => {
        const accountNo = safeDecryptSecret(account.accountNo);
        const readable = Boolean(accountNo) && accountNo !== UNREADABLE_SECRET;
        return {
          id: account.id,
          type: account.type,
          institution: account.institution,
          accountNo,
          accountNoMasked: readable
            ? maskPlaintext(accountNo)
            : safeMaskSecret(account.accountNo),
          accountName: safeDecryptSecret(account.accountName),
          isDefault: account.isDefault,
          status: account.status,
          source: account.source,
          rejectReason: account.rejectReason,
          reviewedBy: account.reviewedBy,
          reviewedAt: account.reviewedAt,
          createdAt: account.createdAt,
          updatedAt: account.updatedAt,
        };
      }),
      summary: {
        directInvitees: user._count.invitees,
        bids: user._count.bids,
        bets: user._count.bets,
        claims: user._count.claims,
        settlements: user._count.settlements,
        bankerRounds,
        rewards: user._count.rewardGrants,
        deposits: user._count.depositOrders,
        withdrawals: user._count.withdrawOrders,
        rooms: user._count.roomMemberships,
      },
      auditLogs,
    };
  });

  app.get('/api/admin/users/:id/ledger', { preHandler: userReaders }, async (req, reply) => {
    const { id } = z.object({ id: cuid }).parse(req.params);
    const query = z
      .object({
        cursor: cuid.optional(),
        accountType: z.nativeEnum(AccountType).optional(),
        refType: z.string().trim().min(1).max(80).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    const exists = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return reply.code(404).send({ error: 'USER_NOT_FOUND' });
    const rows = await prisma.ledgerEntry.findMany({
      where: {
        userId: id,
        accountType: query.accountType,
        refType: query.refType,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        accountType: true,
        direction: true,
        amountCents: true,
        balanceAfterCents: true,
        roundId: true,
        refType: true,
        refId: true,
        memo: true,
        createdAt: true,
      },
    });
    return {
      items: rows.slice(0, query.limit),
      nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.id : null,
    };
  });

  app.get('/api/admin/users/:id/ledger.csv', { preHandler: userReaders }, async (req, reply) => {
    const { id } = z.object({ id: cuid }).parse(req.params);
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, uid: true, nickname: true },
    });
    if (!user) return reply.code(404).send({ error: 'USER_NOT_FOUND' });
    const rows = await prisma.ledgerEntry.findMany({
      where: { userId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20_000,
      select: {
        createdAt: true,
        accountType: true,
        direction: true,
        amountCents: true,
        balanceAfterCents: true,
        refType: true,
        refId: true,
        roundId: true,
        memo: true,
        id: true,
      },
    });
    const escape = (value: string, formulaSafe = false) => {
      const safeValue =
        formulaSafe && /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
      if (/[",\n\r]/.test(safeValue)) return `"${safeValue.replace(/"/g, '""')}"`;
      return safeValue;
    };
    const cents = (value: bigint | null) => {
      if (value === null) return '';
      const sign = value < 0n ? '-' : '';
      const amount = value < 0n ? -value : value;
      return `${sign}${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;
    };
    const header = [
      '时间',
      'UID',
      '昵称',
      '科目',
      '方向',
      '金额RM',
      '余额后RM',
      '业务类型',
      '业务ID',
      '关联局ID',
      '备注',
      '流水ID',
    ].join(',');
    const lines = rows.map((row) =>
      [
        row.createdAt.toISOString(),
        user.uid,
        user.nickname ?? '',
        row.accountType,
        row.direction === 'CREDIT' ? '增加' : '减少',
        cents(row.amountCents),
        cents(row.balanceAfterCents),
        row.refType,
        row.refId ?? '',
        row.roundId ?? '',
        row.memo ?? '',
        row.id,
      ]
        // 昵称和备注可由用户输入；前置单引号阻止 Excel/Sheets 将其作为公式执行。
        .map((cell, index) => escape(String(cell), index === 2 || index === 10))
        .join(','),
    );
    const csv = `\uFEFF${header}\n${lines.join('\n')}\n`;
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename="user-${user.uid}-ledger.csv"; filename*=UTF-8''user-${encodeURIComponent(user.uid)}-ledger.csv`,
      );
    return reply.send(csv);
  });

  app.get('/api/admin/users/:id/rounds', { preHandler: userReaders }, async (req, reply) => {
    const { id } = z.object({ id: cuid }).parse(req.params);
    const query = z
      .object({
        cursor: cuid.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .parse(req.query);
    const exists = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return reply.code(404).send({ error: 'USER_NOT_FOUND' });
    const rows = await prisma.round.findMany({
      where: {
        OR: [
          { bankerId: id },
          { bids: { some: { userId: id } } },
          { bets: { some: { userId: id } } },
          { claims: { some: { userId: id } } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        seqNo: true,
        phase: true,
        bankerId: true,
        potCents: true,
        cancelReason: true,
        createdAt: true,
        settledAt: true,
        finishedAt: true,
        room: { select: { id: true, title: true } },
        packet: { select: { status: true } },
        bids: {
          where: { userId: id },
          select: { amountCents: true, won: true, createdAt: true },
        },
        bets: {
          where: { userId: id },
          select: { amountCents: true, isAllIn: true, status: true, createdAt: true },
        },
        claims: {
          where: { userId: id },
          select: { amountCents: true, handType: true, points: true, source: true },
        },
        settlements: {
          where: { userId: id },
          select: {
            outcome: true,
            betCents: true,
            multiplier: true,
            paidCents: true,
            rakeCents: true,
            shortfallCents: true,
          },
        },
        scoreboard: { select: { bankerSummary: true } },
      },
    });
    return {
      items: rows.slice(0, query.limit).map((round) => {
        const settlement = round.settlements[0] ?? null;
        const playerNetCents = settlement
          ? settlement.outcome === 'PLAYER_WIN'
            ? settlement.paidCents - settlement.rakeCents
            : settlement.outcome === 'BANKER_WIN'
              ? -settlement.betCents
              : 0n
          : null;
        return {
          ...round,
          role:
            round.bankerId === id
              ? 'BANKER'
              : round.bets.length > 0
                ? 'PLAYER'
                : 'BIDDER',
          bid: round.bids[0] ?? null,
          bet: round.bets[0] ?? null,
          claim: round.claims[0] ?? null,
          settlement,
          playerNetCents,
          bids: undefined,
          bets: undefined,
          claims: undefined,
          settlements: undefined,
        };
      }),
      nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.id : null,
    };
  });

  app.get('/api/admin/users/:id/invitees', { preHandler: userReaders }, async (req, reply) => {
    const { id } = z.object({ id: cuid }).parse(req.params);
    const query = z
      .object({
        cursor: cuid.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    const exists = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return reply.code(404).send({ error: 'USER_NOT_FOUND' });
    const rows = await prisma.user.findMany({
      where: { inviterId: id },
      orderBy: [{ inviterBoundAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        uid: true,
        nickname: true,
        status: true,
        inviterBoundAt: true,
        createdAt: true,
        kyc: { select: { status: true, realName: true } },
        wallet: { select: { availableCents: true } },
        _count: { select: { invitees: true } },
      },
    });
    return {
      items: rows.slice(0, query.limit).map((item) => ({
        id: item.id,
        uid: item.uid,
        nickname: item.nickname,
        status: item.status,
        inviterBoundAt: item.inviterBoundAt,
        createdAt: item.createdAt,
        kycStatus: item.kyc?.status ?? null,
        realName: item.kyc ? safeDecryptSecret(item.kyc.realName) : null,
        availableCents: item.wallet?.availableCents ?? 0n,
        invitees: item._count.invitees,
      })),
      nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.id : null,
    };
  });

  app.get('/api/admin/users/:id/orders', { preHandler: userReaders }, async (req, reply) => {
    const { id } = z.object({ id: cuid }).parse(req.params);
    const query = z
      .object({
        type: z.enum(['deposit', 'withdraw', 'all']).default('all'),
        limit: z.coerce.number().int().min(1).max(100).default(40),
      })
      .parse(req.query);
    const exists = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return reply.code(404).send({ error: 'USER_NOT_FOUND' });
    const [deposits, withdrawals] = await Promise.all([
      query.type === 'withdraw'
        ? Promise.resolve([])
        : prisma.depositOrder.findMany({
            where: { userId: id },
            orderBy: { createdAt: 'desc' },
            take: query.limit,
            select: {
              id: true,
              amountCents: true,
              status: true,
              proofUrl: true,
              payeeSnapshot: true,
              createdAt: true,
              reviewedAt: true,
            },
          }),
      query.type === 'deposit'
        ? Promise.resolve([])
        : prisma.withdrawOrder.findMany({
            where: { userId: id },
            orderBy: { createdAt: 'desc' },
            take: query.limit,
            select: {
              id: true,
              amountCents: true,
              status: true,
              channel: true,
              targetSnapshot: true,
              createdAt: true,
              reviewedAt: true,
            },
          }),
    ]);
    const items = [
      ...deposits.map((item) => ({
        kind: 'deposit' as const,
        ...item,
        payeeSnapshot: revealOrderSnapshot(item.payeeSnapshot),
      })),
      ...withdrawals.map((item) => ({
        kind: 'withdraw' as const,
        ...item,
        targetSnapshot: revealOrderSnapshot(item.targetSnapshot),
      })),
    ]
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
      .slice(0, query.limit);
    return { items };
  });

  app.patch('/api/admin/users/:id/note', { preHandler: noteEditors }, async (req, reply) => {
    const { id } = z.object({ id: cuid }).parse(req.params);
    const adminId = (req.user as { sub: string }).sub;
    const body = z
      .object({
        adminNote: z.string().trim().max(4_000).nullable(),
        reason: z.string().trim().min(2).max(500).optional(),
      })
      .parse(req.body);
    const before = await prisma.user.findUnique({
      where: { id },
      select: { id: true, adminNote: true },
    });
    if (!before) return reply.code(404).send({ error: 'USER_NOT_FOUND' });
    const note = body.adminNote?.trim() ? body.adminNote.trim() : null;
    await prisma.$transaction([
      prisma.user.update({ where: { id }, data: { adminNote: note } }),
      prisma.auditLog.create({
        data: {
          adminId,
          action: 'user_note_update',
          target: id,
          before: { adminNote: before.adminNote },
          after: { adminNote: note, reason: body.reason ?? null },
          ip: req.ip,
        },
      }),
    ]);
    return { ok: true, adminNote: note };
  });

  app.patch(
    '/api/admin/users/:id/profile',
    { preHandler: [app.authAdmin, app.requireAdminRoles('SUPER')] },
    async (req, reply) => {
      const { id } = z.object({ id: cuid }).parse(req.params);
      const adminId = (req.user as { sub: string }).sub;
      const body = profileUpdateSchema.parse(req.body);
      const before = await prisma.user.findUnique({
        where: { id },
        select: {
          nickname: true,
          tgUsername: true,
          tgDisplayName: true,
          avatarUrl: true,
        },
      });
      if (!before) return reply.code(404).send({ error: 'USER_NOT_FOUND' });
      const { reason, ...changes } = body;
      const updated = await prisma.$transaction(async (tx) => {
        const item = await tx.user.update({
          where: { id },
          data: changes,
          select: {
            id: true,
            uid: true,
            nickname: true,
            tgUsername: true,
            tgDisplayName: true,
            avatarUrl: true,
            updatedAt: true,
          },
        });
        await tx.auditLog.create({
          data: {
            adminId,
            action: 'user_profile_update',
            target: id,
            before,
            after: { ...changes, reason },
            ip: req.ip,
          },
        });
        return item;
      });
      void broadcastUserProfileChanged(updated).catch(() => undefined);
      return { ok: true, user: updated };
    },
  );

  app.patch(
    '/api/admin/users/:id/kyc',
    { preHandler: [app.authAdmin, app.requireAdminRoles('SUPER', 'OPERATOR', 'REVIEWER')] },
    async (req, reply) => {
      const { id } = z.object({ id: cuid }).parse(req.params);
      const adminId = (req.user as { sub: string }).sub;
      const body = kycUpdateSchema.parse(req.body);
      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, kyc: { select: { status: true } } },
      });
      if (!user) return reply.code(404).send({ error: 'USER_NOT_FOUND' });
      const reviewed = body.status !== 'PENDING';
      const bankAccount = body.bankAccount.replace(/\s+/g, '');
      const accountHolder = body.accountHolder || body.realName;
      const hashes = kycSearchHashes({
        duitnowId: body.duitnowId,
        bankAccount,
      });
      const kyc = await serializable(async (tx) => {
        const updated = await tx.kyc.upsert({
          where: { userId: id },
          create: {
            userId: id,
            realName: encryptSecret(body.realName),
            realNameHash: blindIndex(body.realName),
            duitnowId: encryptSecret(body.duitnowId),
            duitnowHash: hashes.duitnowHash,
            bankName: body.bankName,
            bankAccount: encryptSecret(bankAccount),
            bankAccountHash: hashes.bankAccountHash,
            bankAccountLast4Hash: hashes.bankAccountLast4Hash,
            accountHolder: encryptSecret(accountHolder),
            status: body.status,
            rejectReason: body.status === 'REJECTED' ? body.rejectReason : null,
            reviewedBy: reviewed ? adminId : null,
            reviewedAt: reviewed ? new Date() : null,
          },
          update: {
            realName: encryptSecret(body.realName),
            realNameHash: blindIndex(body.realName),
            duitnowId: encryptSecret(body.duitnowId),
            duitnowHash: hashes.duitnowHash,
            bankName: body.bankName,
            bankAccount: encryptSecret(bankAccount),
            bankAccountHash: hashes.bankAccountHash,
            bankAccountLast4Hash: hashes.bankAccountLast4Hash,
            accountHolder: encryptSecret(accountHolder),
            status: body.status,
            rejectReason: body.status === 'REJECTED' ? body.rejectReason : null,
            reviewedBy: reviewed ? adminId : null,
            reviewedAt: reviewed ? new Date() : null,
          },
        });

        const sourceAccounts = await tx.withdrawAccount.findMany({
          where: { userId: id, source: 'kyc' },
        });
        if (body.status === 'APPROVED') {
          const defaultAccount = await tx.withdrawAccount.findFirst({
            where: { userId: id, isDefault: true },
            select: { id: true },
          });
          const accountInputs = [
            {
              type: 'EWALLET' as const,
              institution: "Touch 'n Go eWallet",
              accountNo: encryptSecret(body.duitnowId),
              accountName: encryptSecret(body.realName),
              isDefault: !defaultAccount,
            },
            ...(body.bankName && bankAccount
              ? [
                  {
                    type: 'BANK' as const,
                    institution: body.bankName,
                    accountNo: encryptSecret(bankAccount),
                    accountName: encryptSecret(accountHolder),
                    isDefault: false,
                  },
                ]
              : []),
          ];
          for (const input of accountInputs) {
            const existing = sourceAccounts.find((account) => account.type === input.type);
            if (existing) {
              await tx.withdrawAccount.update({
                where: { id: existing.id },
                data: {
                  institution: input.institution,
                  accountNo: input.accountNo,
                  accountName: input.accountName,
                  isDefault: existing.isDefault || input.isDefault,
                  status: 'APPROVED',
                  rejectReason: null,
                  reviewedBy: adminId,
                  reviewedAt: new Date(),
                },
              });
            } else {
              await tx.withdrawAccount.create({
                data: {
                  userId: id,
                  type: input.type,
                  institution: input.institution,
                  accountNo: input.accountNo,
                  accountName: input.accountName,
                  isDefault: input.isDefault,
                  status: 'APPROVED',
                  source: 'kyc',
                  reviewedBy: adminId,
                  reviewedAt: new Date(),
                },
              });
            }
          }
        } else {
          await tx.withdrawAccount.updateMany({
            where: { userId: id, source: 'kyc' },
            data: {
              status: body.status,
              rejectReason: body.status === 'REJECTED' ? body.rejectReason : null,
              reviewedBy: reviewed ? adminId : null,
              reviewedAt: reviewed ? new Date() : null,
            },
          });
        }

        await tx.auditLog.create({
          data: {
            adminId,
            action: 'user_kyc_update',
            target: id,
            before: { status: user.kyc?.status ?? null },
            after: {
              status: body.status,
              changedFields: ['realName', 'duitnowId'],
              reason: body.reason,
            },
            ip: req.ip,
          },
        });
        return updated;
      });
      return {
        ok: true,
        kyc: {
          id: kyc.id,
          realName: safeDecryptSecret(kyc.realName),
          duitnowId: safeDecryptSecret(kyc.duitnowId),
          bankName: kyc.bankName,
          bankAccount: safeDecryptSecret(kyc.bankAccount),
          accountHolder: safeDecryptSecret(kyc.accountHolder),
          status: kyc.status,
          rejectReason: kyc.rejectReason,
          reviewedBy: kyc.reviewedBy,
          reviewedAt: kyc.reviewedAt,
          submittedAt: kyc.submittedAt,
        },
      };
    },
  );

  app.patch(
    '/api/admin/users/:id/withdraw-accounts/:accountId',
    { preHandler: withdrawAccountEditors },
    async (req, reply) => {
      const { id, accountId } = z
        .object({ id: cuid, accountId: cuid })
        .parse(req.params);
      const adminId = (req.user as { sub: string }).sub;
      const body = withdrawAccountUpdateSchema.parse(req.body);
      const existing = await prisma.withdrawAccount.findFirst({
        where: { id: accountId, userId: id },
      });
      if (!existing) return reply.code(404).send({ error: 'WITHDRAW_ACCOUNT_NOT_FOUND' });

      const accountNo = body.accountNo.replace(/\s+/g, '');
      const reviewed = body.status !== 'PENDING';
      const wantDefault = body.isDefault === true || (body.isDefault === undefined && existing.isDefault);

      const item = await serializable(async (tx) => {
        if (wantDefault && body.status === 'APPROVED') {
          await tx.withdrawAccount.updateMany({
            where: { userId: id, id: { not: accountId } },
            data: { isDefault: false },
          });
        }

        let isDefault = false;
        if (body.status === 'APPROVED') {
          isDefault =
            body.isDefault === true
              ? true
              : body.isDefault === false
                ? false
                : existing.isDefault;
        }

        const updated = await tx.withdrawAccount.update({
          where: { id: accountId },
          data: {
            type: body.type,
            institution: body.institution,
            accountNo: encryptSecret(accountNo),
            accountName: encryptSecret(body.accountName),
            status: body.status,
            rejectReason: body.status === 'REJECTED' ? body.rejectReason : null,
            isDefault,
            reviewedBy: reviewed ? adminId : null,
            reviewedAt: reviewed ? new Date() : null,
          },
        });

        if (!isDefault && body.status === 'APPROVED') {
          const hasDefault = await tx.withdrawAccount.findFirst({
            where: { userId: id, isDefault: true, status: 'APPROVED' },
            select: { id: true },
          });
          if (!hasDefault) {
            await tx.withdrawAccount.update({
              where: { id: accountId },
              data: { isDefault: true },
            });
            updated.isDefault = true;
          }
        }

        if (body.status !== 'APPROVED') {
          const fallback = await tx.withdrawAccount.findFirst({
            where: { userId: id, status: 'APPROVED', id: { not: accountId } },
            orderBy: { createdAt: 'asc' },
          });
          if (fallback && !fallback.isDefault) {
            await tx.withdrawAccount.update({
              where: { id: fallback.id },
              data: { isDefault: true },
            });
          }
        }

        await tx.auditLog.create({
          data: {
            adminId,
            action: 'user_withdraw_account_update',
            target: id,
            before: {
              accountId: existing.id,
              type: existing.type,
              institution: existing.institution,
              accountNoMasked: safeMaskSecret(existing.accountNo),
              accountName: safeDecryptSecret(existing.accountName),
              status: existing.status,
              isDefault: existing.isDefault,
              source: existing.source,
            },
            after: {
              accountId,
              type: body.type,
              institution: body.institution,
              accountNoMasked: maskPlaintext(accountNo),
              accountName: body.accountName,
              status: body.status,
              isDefault: updated.isDefault,
              source: existing.source,
              reason: body.reason,
            },
            ip: req.ip,
          },
        });

        return updated;
      });

      const plainNo = safeDecryptSecret(item.accountNo);
      const readable = Boolean(plainNo) && plainNo !== UNREADABLE_SECRET;
      return {
        ok: true,
        account: {
          id: item.id,
          type: item.type,
          institution: item.institution,
          accountNo: plainNo,
          accountNoMasked: readable
            ? maskPlaintext(plainNo)
            : safeMaskSecret(item.accountNo),
          accountName: safeDecryptSecret(item.accountName),
          isDefault: item.isDefault,
          status: item.status,
          source: item.source,
          rejectReason: item.rejectReason,
          reviewedBy: item.reviewedBy,
          reviewedAt: item.reviewedAt,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        },
      };
    },
  );

  app.patch(
    '/api/admin/users/:id/status',
    { preHandler: [app.authAdmin, app.requireAdminRoles('SUPER')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const adminId = (req.user as { sub: string }).sub;
      const { status, reason } = z
        .object({
          status: z.enum(['ACTIVE', 'BANNED']),
          reason: z.string().min(2).max(300),
        })
        .parse(req.body);
      const before = await prisma.user.findUnique({ where: { id } });
      if (!before) return reply.code(404).send({ error: 'USER_NOT_FOUND' });
      await prisma.$transaction([
        prisma.user.update({ where: { id }, data: { status } }),
        prisma.auditLog.create({
          data: {
            adminId,
            action: 'user_status_update',
            target: id,
            before: { status: before.status },
            after: { status, reason },
          },
        }),
      ]);
      return { ok: true };
    },
  );

  // ── 客服聊天 / 动画贴纸 ──
  app.get('/api/admin/support/threads', { preHandler: support }, async () => {
    const latest = await prisma.chatMessage.findMany({
      distinct: ['userId'],
      orderBy: [{ userId: 'asc' }, { createdAt: 'desc' }],
      include: {
        user: {
          select: {
            uid: true,
            nickname: true,
            avatarUrl: true,
          },
        },
      },
    });
    const unread = await prisma.chatMessage.groupBy({
      by: ['userId'],
      where: { senderType: 'USER', readAt: null },
      _count: { _all: true },
    });
    const counts = new Map(unread.map((row) => [row.userId, row._count._all]));
    return {
      items: latest
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((message) => ({
          ...message,
          unread: counts.get(message.userId) ?? 0,
          user: {
            uid: message.user.uid,
            nickname: message.user.nickname,
            avatarUrl: message.user.avatarUrl,
            avatarDisplayUrl: resolveAvatarUrl(message.user.avatarUrl),
          },
        })),
    };
  });

  app.get('/api/admin/support/:userId/messages', { preHandler: support }, async (req) => {
    const { userId } = req.params as { userId: string };
    const { cursor, limit } = z
      .object({
        cursor: cuid.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(500),
      })
      .parse(req.query);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        uid: true,
        nickname: true,
        avatarUrl: true,
      },
    });
    if (!user) throw new Error('USER_NOT_FOUND');
    const rows = await prisma.chatMessage.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, limit).reverse();
    const visibleUnreadIds = items
      .filter((message) => message.senderType === 'USER' && message.readAt === null)
      .map((message) => message.id);
    if (visibleUnreadIds.length) {
      await prisma.chatMessage.updateMany({
        where: { id: { in: visibleUnreadIds }, userId, readAt: null },
        data: { readAt: new Date() },
      });
    }
    return {
      items,
      nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
      user: {
        uid: user.uid,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        avatarDisplayUrl: resolveAvatarUrl(user.avatarUrl),
      },
    };
  });

  app.post('/api/admin/support/:userId/messages', { preHandler: support }, async (req) => {
    const { userId } = req.params as { userId: string };
    const adminId = (req.user as { sub: string }).sub;
    const body = z
      .object({
        type: z.nativeEnum(MessageType).default('TEXT'),
        content: z.string().trim().min(1).max(2_000),
        assetUrl: z.string().url().optional(),
      })
      .parse(req.body);
    const message = await prisma.chatMessage.create({
      data: { userId, senderType: 'SUPPORT', operatorId: adminId, ...body },
    });
    const notification =
      body.type === 'TEXT'
        ? `💬 客服回复\n${body.content}`
        : '💬 客服发来一条新消息，请打开至尊牛牛查看。';
    app.pushService?.sendCustom(userId, notification).catch(() => undefined);
    return { ok: true, message };
  });

  app.get('/api/admin/stickers', { preHandler: support }, async () => ({
    items: await prisma.stickerAsset.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
  }));

  app.post('/api/admin/stickers', { preHandler: operators }, async (req) => {
    const body = z
      .object({
        name: z.string().min(1).max(100),
        url: z.string().url(),
        sortOrder: z.number().int().default(0),
      })
      .parse(req.body);
    return { ok: true, item: await prisma.stickerAsset.create({ data: body }) };
  });

  app.patch('/api/admin/stickers/:id', { preHandler: operators }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        name: z.string().min(1).max(100).optional(),
        url: z.string().url().optional(),
        sortOrder: z.number().int().optional(),
        status: z.enum(['ACTIVE', 'DISABLED']).optional(),
      })
      .parse(req.body);
    return { ok: true, item: await prisma.stickerAsset.update({ where: { id }, data: body }) };
  });

  // ── 公告 / Banner ──
  // ROOM:<id> 置顶由游戏运营中心小助手接管接口管理，禁止通用公告路由绕过租约。
  app.get('/api/admin/announcements', { preHandler: operators }, async () => ({
    items: await prisma.announcement.findMany({
      where: { NOT: { target: { startsWith: 'ROOM:' } } },
      orderBy: { createdAt: 'desc' },
    }),
  }));

  app.post('/api/admin/announcements', { preHandler: operators }, async (req, reply) => {
    const adminId = (req.user as { sub: string }).sub;
    const body = z
      .object({
        title: z.string().min(1).max(200),
        body: z.string().min(1).max(5_000),
        imageUrl: z.string().url().optional(),
        target: z.string().max(50).default('ALL'),
        pinned: z.boolean().default(false),
        publishNow: z.boolean().default(false),
        scheduledAt: z.coerce.date().optional(),
      })
      .parse(req.body);
    if (body.target.startsWith('ROOM:')) {
      return reply.code(400).send({
        error: 'ROOM_PIN_VIA_ASSISTANT_ONLY',
        message: '房间置顶请在游戏运营中心接管至尊牛牛小助手后操作',
      });
    }
    const { publishNow, ...data } = body;
    const item = await prisma.announcement.create({
      data: {
        ...data,
        createdBy: adminId,
        status: publishNow ? 'PUBLISHED' : 'DRAFT',
        publishedAt: publishNow ? new Date() : null,
      },
    });
    return { ok: true, item };
  });

  app.patch('/api/admin/announcements/:id', { preHandler: operators }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.announcement.findUnique({
      where: { id },
      select: { id: true, target: true },
    });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (existing.target.startsWith('ROOM:')) {
      return reply.code(409).send({
        error: 'ROOM_PIN_VIA_ASSISTANT_ONLY',
        message: '房间置顶请在游戏运营中心接管至尊牛牛小助手后操作',
      });
    }
    const body = z
      .object({
        title: z.string().min(1).max(200).optional(),
        body: z.string().min(1).max(5_000).optional(),
        imageUrl: z.string().url().nullable().optional(),
        pinned: z.boolean().optional(),
        status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
        scheduledAt: z.coerce.date().nullable().optional(),
      })
      .parse(req.body);
    return {
      ok: true,
      item: await prisma.announcement.update({
        where: { id },
        data: {
          ...body,
          ...(body.status === 'PUBLISHED' ? { publishedAt: new Date() } : {}),
        },
      }),
    };
  });

  // ── 推送中心 ──
  app.get('/api/admin/push/templates', { preHandler: operators }, async () => ({
    items: await prisma.pushTemplate.findMany({ orderBy: { createdAt: 'desc' } }),
  }));

  app.post('/api/admin/push/templates', { preHandler: operators }, async (req) => {
    const adminId = (req.user as { sub: string }).sub;
    const body = z
      .object({
        code: z.string().regex(/^[a-z0-9_]{2,64}$/),
        title: z.string().min(1).max(200),
        body: z.string().min(1).max(4_000),
      })
      .parse(req.body);
    const item = await prisma.$transaction(async (tx) => {
      const before = await tx.pushTemplate.findUnique({ where: { code: body.code } });
      const updated = await tx.pushTemplate.upsert({
        where: { code: body.code },
        create: body,
        update: { title: body.title, body: body.body },
      });
      await tx.auditLog.create({
        data: {
          adminId,
          action: before ? 'push_template_update' : 'push_template_create',
          target: updated.id,
          before: before
            ? { code: before.code, title: before.title, body: before.body }
            : undefined,
          after: { code: updated.code, title: updated.title, body: updated.body },
          ip: req.ip,
        },
      });
      return updated;
    });
    return { ok: true, item };
  });

  app.get('/api/admin/push/jobs', { preHandler: operators }, async () => ({
    items: await prisma.pushJob.findMany({
      include: { template: true, _count: { select: { logs: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
  }));

  app.post('/api/admin/push/jobs', { preHandler: operators }, async (req, reply) => {
    const adminId = (req.user as { sub: string }).sub;
    const body = z
      .object({
        templateId: cuid.optional(),
        botId: cuid.optional(),
        audience: z
          .object({
            type: z.enum(['all', 'kyc_approved', 'uids', 'room']),
            uids: z.array(z.string()).max(1_000).optional(),
            roomId: compatibleId.optional(),
          })
          .refine((value) => value.type !== 'room' || !!value.roomId, {
            message: '指定房间推送必须选择房间',
            path: ['roomId'],
          }),
        payload: z.record(z.unknown()).default({}),
        scheduledAt: z.coerce.date().optional(),
      })
      .parse(req.body);
    if (!body.templateId && typeof body.payload.body !== 'string') {
      throw new Error('PUSH_BODY_REQUIRED');
    }
    const template = body.templateId
      ? await prisma.pushTemplate.findUnique({
          where: { id: body.templateId },
          select: { body: true },
        })
      : null;
    if (body.templateId && !template) {
      return reply.code(404).send({ error: 'PUSH_TEMPLATE_NOT_FOUND' });
    }
    const jobPayload = {
      ...body.payload,
      ...(template ? { __templateBody: template.body } : {}),
    };
    const job = await prisma.$transaction(async (tx) => {
      const created = await tx.pushJob.create({
        data: {
          ...body,
          audience: body.audience,
          payload: jobPayload as Prisma.InputJsonValue,
          createdBy: adminId,
        },
      });
      await tx.auditLog.create({
        data: {
          adminId,
          action: 'push_job_create',
          target: created.id,
          after: {
            templateId: body.templateId ?? null,
            botId: body.botId ?? null,
            audience: body.audience,
            scheduledAt: body.scheduledAt?.toISOString() ?? null,
            payload: jobPayload,
          } as Prisma.InputJsonValue,
          ip: req.ip,
        },
      });
      return created;
    });
    if (!body.scheduledAt || body.scheduledAt <= new Date()) {
      setImmediate(() => {
        void pushService.executeJob(job.id).catch((error) => {
          req.log.error({ err: error, jobId: job.id }, 'push job execution failed');
        });
      });
    }
    return { ok: true, job };
  });

  app.post('/api/admin/push/jobs/:id/retry', { preHandler: operators }, async (req) => {
    const { id } = req.params as { id: string };
    const adminId = (req.user as { sub: string }).sub;
    await prisma.$transaction([
      prisma.pushJob.update({ where: { id }, data: { status: 'PENDING' } }),
      prisma.auditLog.create({
        data: {
          adminId,
          action: 'push_job_retry',
          target: id,
          ip: req.ip,
        },
      }),
    ]);
    setImmediate(() => {
      void pushService.executeJob(id).catch((error) => {
        req.log.error({ err: error, jobId: id }, 'push job retry failed');
      });
    });
    return { ok: true };
  });

  app.get('/api/admin/push/jobs/:id/logs', { preHandler: operators }, async (req) => {
    const { id } = req.params as { id: string };
    return {
      items: await prisma.pushLog.findMany({
        where: { jobId: id },
        orderBy: { sentAt: 'desc' },
        take: 1_000,
      }),
    };
  });

  // ── 每日奖励 / 排行榜 / 返水 ──
  const rewardConfigInput = z.object({
    id: cuid.optional(),
    tab: z.nativeEnum(RewardTab),
    code: z.string().regex(/^[a-z0-9_]{2,64}$/),
    title: z.string().min(1).max(200),
    conditions: z.record(z.unknown()),
    amountCents: positiveCents,
    dailyQuota: z.number().int().min(0).max(100_000).default(0),
    status: z.enum(['ACTIVE', 'DISABLED']).default('ACTIVE'),
  });
  const rewardGrantInput = z
    .object({
      userId: cuid.optional(),
      uid: z.string().optional(),
      date: date.optional(),
    })
    .refine((value) => !!value.userId || !!value.uid, {
      message: '必须提供 userId 或 uid',
    });

  async function upsertRewardConfig(
    scopedGameCode: string,
    body: z.infer<typeof rewardConfigInput>,
    adminId: string,
    ip: string,
  ) {
    const before = body.id
      ? await prisma.rewardConfig.findFirst({
          where: { id: body.id, gameCode: scopedGameCode },
        })
      : await prisma.rewardConfig.findUnique({
          where: {
            gameCode_code: {
              gameCode: scopedGameCode,
              code: body.code,
            },
          },
        });
    if (body.id && !before) throw new Error('REWARD_NOT_FOUND');
    const data = {
      tab: body.tab,
      code: body.code,
      title: body.title,
      conditions: body.conditions as Prisma.InputJsonValue,
      amountCents: BigInt(body.amountCents),
      dailyQuota: body.dailyQuota,
      status: body.status,
    };
    const item = body.id
      ? await prisma.rewardConfig.update({
          where: { id: body.id },
          data,
        })
      : await prisma.rewardConfig.upsert({
          where: {
            gameCode_code: {
              gameCode: scopedGameCode,
              code: body.code,
            },
          },
          create: {
            ...data,
            gameCode: scopedGameCode,
          },
          update: data,
        });
    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'game_reward_config_update',
        target: `game:${scopedGameCode}:reward:${item.id}`,
        before: before
          ? {
              gameCode: before.gameCode,
              tab: before.tab,
              code: before.code,
              title: before.title,
              conditions: before.conditions,
              amountCents: String(before.amountCents),
              dailyQuota: before.dailyQuota,
              status: before.status,
            }
          : Prisma.JsonNull,
        after: JSON.parse(
          JSON.stringify({
            ...body,
            gameCode: scopedGameCode,
          }),
        ) as Prisma.InputJsonValue,
        ip,
      },
    });
    return item;
  }

  async function grantScopedReward(
    scopedGameCode: string,
    id: string,
    input: z.infer<typeof rewardGrantInput>,
    adminId: string,
  ) {
    const config = await prisma.rewardConfig.findFirst({
      where: { id, gameCode: scopedGameCode },
    });
    if (!config) return { error: 'REWARD_NOT_FOUND' as const };
    let userId = input.userId;
    if (!userId) {
      const user = await prisma.user.findUnique({ where: { uid: input.uid! } });
      if (!user) return { error: 'USER_NOT_FOUND' as const };
      userId = user.id;
    }
    const result = await grantReward(id, userId, input.date, adminId);
    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'reward_manual_grant',
        target: `game:${scopedGameCode}:reward:${id}`,
        after: { userId, date: input.date, granted: !!result },
      },
    });
    return { result, userId };
  }

  async function listRewardGrants(scopedGameCode: string, selectedDate?: string) {
    return prisma.rewardGrant.findMany({
      where: { date: selectedDate, config: { gameCode: scopedGameCode } },
      include: {
        config: { select: { title: true, tab: true, gameCode: true } },
        user: { select: { uid: true, nickname: true } },
      },
      orderBy: { grantedAt: 'desc' },
      take: 500,
    });
  }

  app.get('/api/admin/games/:gameCode/rewards', { preHandler: rewardReaders }, async (req) => {
    const params = z.object({ gameCode }).parse(req.params);
    return {
      gameCode: params.gameCode,
      items: await prisma.rewardConfig.findMany({
        where: { gameCode: params.gameCode },
        orderBy: { createdAt: 'asc' },
      }),
    };
  });

  app.post('/api/admin/games/:gameCode/rewards', { preHandler: finance }, async (req) => {
    const { gameCode: scopedGameCode } = z.object({ gameCode }).parse(req.params);
    const adminId = (req.user as { sub: string }).sub;
    const item = await upsertRewardConfig(
      scopedGameCode,
      rewardConfigInput.parse(req.body),
      adminId,
      req.ip,
    );
    return { ok: true, item };
  });

  app.get('/api/admin/games/:gameCode/rewards/grants', { preHandler: rewardReaders }, async (req) => {
    const { gameCode: scopedGameCode } = z.object({ gameCode }).parse(req.params);
    const query = z.object({ date: date.optional() }).parse(req.query);
    return {
      gameCode: scopedGameCode,
      items: await listRewardGrants(scopedGameCode, query.date),
    };
  });

  app.post('/api/admin/games/:gameCode/rewards/:id/grant', { preHandler: finance }, async (req, reply) => {
    const { gameCode: scopedGameCode, id } = z
      .object({ gameCode, id: cuid })
      .parse(req.params);
    const adminId = (req.user as { sub: string }).sub;
    const granted = await grantScopedReward(
      scopedGameCode,
      id,
      rewardGrantInput.parse(req.body),
      adminId,
    );
    if ('error' in granted) {
      return reply.code(404).send({ error: granted.error });
    }
    return { ok: true, granted: !!granted.result };
  });

  /** @deprecated 无游戏上下文的管理端接口固定映射至尊牛牛。 */
  app.get('/api/admin/rewards', { preHandler: rewardReaders }, async () => ({
    items: await prisma.rewardConfig.findMany({
      where: { gameCode: SUPREME_NIUNIU_GAME_CODE },
      orderBy: { createdAt: 'asc' },
    }),
  }));

  app.post('/api/admin/rewards', { preHandler: finance }, async (req) => {
    const adminId = (req.user as { sub: string }).sub;
    const item = await upsertRewardConfig(
      SUPREME_NIUNIU_GAME_CODE,
      rewardConfigInput.parse(req.body),
      adminId,
      req.ip,
    );
    return { ok: true, item };
  });

  app.get('/api/admin/rewards/grants', { preHandler: rewardReaders }, async (req) => {
    const query = z.object({ date: date.optional() }).parse(req.query);
    return {
      items: await listRewardGrants(SUPREME_NIUNIU_GAME_CODE, query.date),
    };
  });

  app.post('/api/admin/rewards/:id/grant', { preHandler: finance }, async (req, reply) => {
    const { id } = z.object({ id: cuid }).parse(req.params);
    const adminId = (req.user as { sub: string }).sub;
    const granted = await grantScopedReward(
      SUPREME_NIUNIU_GAME_CODE,
      id,
      rewardGrantInput.parse(req.body),
      adminId,
    );
    if ('error' in granted) {
      return reply.code(404).send({ error: granted.error });
    }
    return { ok: true, granted: !!granted.result };
  });

  const leaderboardRewardInput = z.object({
    type: z.enum(['points', 'hands', 'banker']),
    period: z.enum(['daily', 'weekly', 'monthly']),
    periodKey: z.string().trim().min(7).max(10),
    expectedSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    prizes: z
      .array(
        z.object({
          rank: z.number().int().min(1).max(500),
          amountCents: positiveCents,
        }),
      )
      .min(1)
      .max(100),
  });

  async function distributeScopedLeaderboardRewards(
    scopedGameCode: string,
    body: z.infer<typeof leaderboardRewardInput>,
    adminId: string,
    ip: string,
  ) {
    const outcome = await distributeLeaderboardRewards({
      gameCode: scopedGameCode,
      type: body.type,
      period: body.period,
      periodKey: body.periodKey,
      expectedSnapshotHash: body.expectedSnapshotHash,
      prizes: body.prizes.map((prize) => ({
        rank: prize.rank,
        amountCents: BigInt(prize.amountCents),
      })),
      operatorId: adminId,
    });
    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'leaderboard_reward_distribute',
        target: `game:${scopedGameCode}:leaderboard:${body.type}:${body.period}:${outcome.periodKey}`,
        after: JSON.parse(JSON.stringify(outcome)) as Prisma.InputJsonValue,
        ip,
      },
    });
    for (const result of outcome.results) {
      if (!result.granted) continue;
      const amount = `${BigInt(result.amountCents) / 100n}.${(BigInt(result.amountCents) % 100n).toString().padStart(2, '0')}`;
      void pushService
        .notifyRewardGranted(result.userId, '排行榜奖励', amount)
        .catch(() => undefined);
    }
    return outcome;
  }

  app.post('/api/admin/games/:gameCode/leaderboards/generate', { preHandler: leaderboardManagers }, async (req) => {
    const { gameCode: scopedGameCode } = z.object({ gameCode }).parse(req.params);
    const body = z
      .object({
        period: z.enum(['daily', 'weekly', 'monthly']).default('daily'),
        periodKey: z.string().trim().min(7).max(10).optional(),
      })
      .parse(req.body ?? {});
    return {
      ok: true,
      gameCode: scopedGameCode,
      dashboard: await leaderboardDashboard(
        scopedGameCode,
        body.period,
        true,
        body.periodKey,
        true,
      ),
    };
  });

  app.get('/api/admin/games/:gameCode/leaderboards', { preHandler: leaderboardManagers }, async (req) => {
    const { gameCode: scopedGameCode } = z.object({ gameCode }).parse(req.params);
    const { period, periodKey } = z
      .object({
        period: z.enum(['daily', 'weekly', 'monthly']).default('daily'),
        periodKey: z.string().trim().min(7).max(10).optional(),
      })
      .parse(req.query);
    return leaderboardDashboard(scopedGameCode, period, true, periodKey);
  });

  app.post('/api/admin/games/:gameCode/leaderboards/reward', { preHandler: finance }, async (req, reply) => {
    const { gameCode: scopedGameCode } = z.object({ gameCode }).parse(req.params);
    const adminId = (req.user as { sub: string }).sub;
    try {
      const outcome = await distributeScopedLeaderboardRewards(
        scopedGameCode,
        leaderboardRewardInput.parse(req.body),
        adminId,
        req.ip,
      );
      return { ok: true, ...outcome };
    } catch (error) {
      const code = (error as Error).message;
      if (code === 'LEADERBOARD_PERIOD_NOT_CLOSED' || code === 'LEADERBOARD_SNAPSHOT_CHANGED') {
        return reply.code(409).send({ error: code });
      }
      throw error;
    }
  });

  /** @deprecated 无游戏上下文的管理端接口固定映射至尊牛牛。 */
  app.post('/api/admin/leaderboards/generate', { preHandler: leaderboardManagers }, async () => ({
    ok: true,
    items: await generateAllLeaderboards(SUPREME_NIUNIU_GAME_CODE),
  }));

  app.get('/api/admin/leaderboards', { preHandler: leaderboardManagers }, async (req) => {
    const { period } = z
      .object({ period: z.enum(['daily', 'weekly', 'monthly']).default('daily') })
      .parse(req.query);
    return leaderboardDashboard(SUPREME_NIUNIU_GAME_CODE, period, true);
  });

  app.post('/api/admin/leaderboards/reward', { preHandler: finance }, async (req, reply) => {
    const adminId = (req.user as { sub: string }).sub;
    try {
      const outcome = await distributeScopedLeaderboardRewards(
        SUPREME_NIUNIU_GAME_CODE,
        leaderboardRewardInput.parse(req.body),
        adminId,
        req.ip,
      );
      return { ok: true, ...outcome };
    } catch (error) {
      const code = (error as Error).message;
      if (code === 'LEADERBOARD_PERIOD_NOT_CLOSED' || code === 'LEADERBOARD_SNAPSHOT_CHANGED') {
        return reply.code(409).send({ error: code });
      }
      throw error;
    }
  });

  app.post('/api/admin/rebates/settle', { preHandler: finance }, async (req, reply) => {
    const { settlementDate } = z.object({ settlementDate: date }).parse(req.body);
    if (settlementDate >= malaysiaDay()) {
      return reply.code(409).send({ error: 'REBATE_PERIOD_NOT_CLOSED' });
    }
    return { ok: true, items: await settleRebates(settlementDate) };
  });

  app.get('/api/admin/rebates', { preHandler: finance }, async (req) => {
    const query = z.object({ date: date.optional() }).parse(req.query);
    const items = await prisma.rebateSettlement.findMany({
      where: { date: query.date },
      include: { user: { select: { uid: true, nickname: true } } },
      orderBy: { createdAt: 'desc' },
      take: 1_000,
    });
    return { items };
  });

  // ── 财务流水 / 人工调账 ──
  app.get('/api/admin/finance/ledger', { preHandler: finance }, async (req) => {
    const query = z
      .object({
        uid: z.string().optional(),
        accountType: z.nativeEnum(AccountType).optional(),
        roundId: cuid.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);
    const user = query.uid ? await prisma.user.findUnique({ where: { uid: query.uid } }) : null;
    const items = await prisma.ledgerEntry.findMany({
      where: {
        ...(query.uid ? { userId: user?.id ?? '__not_found__' } : {}),
        accountType: query.accountType,
        roundId: query.roundId,
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    });
    return { items };
  });

  app.post('/api/admin/finance/adjust', { preHandler: finance }, async (req, reply) => {
    const adminId = (req.user as { sub: string }).sub;
    const body = z
      .object({
        uid: z.string(),
        direction: z.enum(['credit', 'debit']),
        amountCents: positiveCents.refine((value) => BigInt(value) <= 100_000_000_000n, {
          message: 'AMOUNT_TOO_LARGE',
        }),
        reason: z.string().trim().min(4).max(500),
        requestId: z.string().uuid(),
      })
      .parse(req.body);
    const user = await prisma.user.findUnique({ where: { uid: body.uid } });
    if (!user) return reply.code(404).send({ error: 'USER_NOT_FOUND' });
    const amount = BigInt(body.amountCents);
    const adjustmentId = body.requestId;
    const idempotencyKey = `adjust:${adjustmentId}`;
    const result = await serializable(async (tx) => {
      const duplicate = await tx.ledgerEntry.findUnique({
        where: { idempotencyKey: `${idempotencyKey}:in` },
      });
      if (duplicate) {
        const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId: user.id } });
        return { duplicate: true, wallet };
      }
      const before = await tx.wallet.findUniqueOrThrow({ where: { userId: user.id } });
      await transfer(tx, {
        amountCents: amount,
        from:
          body.direction === 'credit'
            ? { accountType: AccountType.ADJUST_CLEARING }
            : { userId: user.id, accountType: AccountType.USER_AVAILABLE },
        to:
          body.direction === 'credit'
            ? { userId: user.id, accountType: AccountType.USER_AVAILABLE }
            : { accountType: AccountType.ADJUST_CLEARING },
        refType: 'adjust',
        refId: adjustmentId,
        idempotencyKey,
        operatorId: adminId,
        memo: body.reason,
      });
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId: user.id } });
      await tx.auditLog.create({
        data: {
          adminId,
          action: 'wallet_adjust',
          target: user.id,
          before: { availableCents: String(before.availableCents) },
          after: {
            direction: body.direction,
            amountCents: body.amountCents,
            availableCents: String(wallet.availableCents),
            reason: body.reason,
            adjustmentId,
          },
          ip: req.ip,
        },
      });
      return { duplicate: false, wallet };
    });
    return { ok: true, ...result, adjustmentId };
  });

  // ── TNG 发包账号 ──
  app.get('/api/admin/tng/accounts', { preHandler: tngManagers }, async () => {
    const items = await prisma.tngAccount.findMany({ orderBy: { createdAt: 'asc' } });
    return {
      items: items.map((item) => ({
        ...item,
        accountName: safeDecryptSecret(item.accountName),
      })),
    };
  });

  app.post('/api/admin/tng/accounts', { preHandler: tngManagers }, async (req) => {
    const body = z
      .object({
        label: z.string().min(1).max(100),
        accountName: z.string().min(2).max(100),
        maskedId: z.string().max(100).optional(),
        monthlyLimitCents: positiveCents.optional(),
        notes: z.string().max(500).optional(),
      })
      .parse(req.body);
    return {
      ok: true,
      item: await prisma.tngAccount.create({
        data: {
          ...body,
          accountName: encryptSecret(body.accountName),
          monthlyLimitCents: body.monthlyLimitCents
            ? BigInt(body.monthlyLimitCents)
            : undefined,
        },
      }),
    };
  });

  app.patch('/api/admin/tng/accounts/:id', { preHandler: tngManagers }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        label: z.string().min(1).max(100).optional(),
        accountName: z.string().min(2).max(100).optional(),
        maskedId: z.string().max(100).nullable().optional(),
        monthlyLimitCents: positiveCents.nullable().optional(),
        notes: z.string().max(500).nullable().optional(),
        status: z.enum(['ACTIVE', 'DISABLED']).optional(),
      })
      .parse(req.body);
    return {
      ok: true,
      item: await prisma.tngAccount.update({
        where: { id },
        data: {
          ...body,
          accountName: body.accountName ? encryptSecret(body.accountName) : undefined,
          monthlyLimitCents:
            body.monthlyLimitCents === null
              ? null
              : body.monthlyLimitCents
                ? BigInt(body.monthlyLimitCents)
                : undefined,
        },
      }),
    };
  });

  // ── 手机端回传的待指认领取明细 ──
  app.get('/api/admin/tng/claim-inbox', { preHandler: tngManagers }, async (req) => {
    const query = z
      .object({
        status: z.enum(['PENDING', 'RESOLVED', 'DISCARDED']).default('PENDING'),
        take: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    const rows = await prisma.tngClaimInbox.findMany({
      where: { status: query.status },
      orderBy: { createdAt: 'desc' },
      take: query.take,
      include: {
        packet: {
          select: {
            id: true,
            roundId: true,
            totalCents: true,
            participantCount: true,
            round: { select: { phase: true, roomId: true } },
          },
        },
      },
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        packetId: row.packetId,
        roundId: row.roundId,
        roomId: row.packet.round.roomId,
        phase: row.packet.round.phase,
        tngName: safeDecryptSecret(row.tngName),
        amountCents: String(row.amountCents),
        claimedAt: row.claimedAt,
        deviceId: row.deviceId,
        reason: row.reason,
        status: row.status,
        createdAt: row.createdAt,
      })),
    };
  });

  /** 人工指认：把采集到的姓名归到指定玩家并正式认额（沿用 forceMatch 的原因留痕要求）。 */
  app.post('/api/admin/tng/claim-inbox/:id/resolve', { preHandler: tngManagers }, async (req) => {
    const { id } = req.params as { id: string };
    const adminId = (req.user as { sub: string }).sub;
    const body = z
      .object({
        userId: z.string().min(1).max(64),
        forceMatch: z.boolean().default(false),
        matchOverrideReason: z.string().min(4).max(500).optional(),
      })
      .refine((value) => !value.forceMatch || !!value.matchOverrideReason, {
        message: '强制匹配必须填写原因',
        path: ['matchOverrideReason'],
      })
      .parse(req.body);

    const row = await prisma.tngClaimInbox.findUnique({ where: { id } });
    if (!row) return { ok: false, error: 'INBOX_ITEM_NOT_FOUND' };
    if (row.status !== 'PENDING') return { ok: false, error: 'INBOX_ITEM_NOT_PENDING' };

    const result = await recordClaim({
      roundId: row.roundId,
      userId: body.userId,
      amountCents: row.amountCents,
      tngName: safeDecryptSecret(row.tngName),
      source: ClaimSource.PROVIDER,
      enteredBy: adminId,
      forceMatch: body.forceMatch,
      matchOverrideReason: body.matchOverrideReason,
    });

    await prisma.tngClaimInbox.update({
      where: { id },
      data: {
        status: 'RESOLVED',
        resolvedBy: adminId,
        resolvedAt: new Date(),
        claimId: result.claim.id,
      },
    });
    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'tng_claim_inbox_resolve',
        target: row.id,
        after: {
          roundId: row.roundId,
          userId: body.userId,
          amountCents: String(row.amountCents),
          forceMatch: body.forceMatch,
          ...(body.matchOverrideReason ? { reason: body.matchOverrideReason } : {}),
        },
        ip: req.ip,
      },
    });
    gameBus.claimRecorded({
      roundId: row.roundId,
      userId: body.userId,
      amountCents: String(row.amountCents),
    });
    return { ok: true, complete: result.complete, claim: result.claim };
  });

  /** 丢弃：重复采集、测试数据或已由人工另行录入的行。 */
  app.post('/api/admin/tng/claim-inbox/:id/discard', { preHandler: tngManagers }, async (req) => {
    const { id } = req.params as { id: string };
    const adminId = (req.user as { sub: string }).sub;
    const body = z.object({ reason: z.string().min(4).max(500) }).parse(req.body);
    const row = await prisma.tngClaimInbox.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'DISCARDED',
        reason: body.reason,
        resolvedBy: adminId,
        resolvedAt: new Date(),
      },
    });
    if (row.count !== 1) return { ok: false, error: 'INBOX_ITEM_NOT_PENDING' };
    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'tng_claim_inbox_discard',
        target: id,
        after: { reason: body.reason },
        ip: req.ip,
      },
    });
    return { ok: true };
  });

  // ── Bot 状态 / 默认路由 ──
  app.patch(
    '/api/admin/bots/:id',
    { preHandler: [app.authAdmin, app.requireAdminRoles('SUPER')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const adminId = (req.user as { sub: string }).sub;
      const body = z
        .object({
          name: z.string().min(1).max(100).optional(),
          username: z.string().regex(/^[A-Za-z0-9_]{5,64}$/).optional(),
          token: z.string().min(30).max(256).optional(),
          status: z.enum(['ACTIVE', 'DISABLED']).optional(),
          isDefault: z.boolean().optional(),
        })
        .parse(req.body);
      const current = await prisma.telegramBot.findUnique({ where: { id } });
      if (!current) return reply.code(404).send({ error: 'BOT_NOT_FOUND' });
      if (body.status === 'DISABLED') {
        const activeRooms = await prisma.room.count({ where: { botId: id, status: 'ACTIVE' } });
        if (activeRooms > 0) {
          return reply.code(409).send({ error: 'BOT_HAS_ACTIVE_ROOMS', activeRooms });
        }
      }
      if (body.token || body.username || body.status === 'ACTIVE') {
        try {
          await validateBotCredentials(
            body.token ?? decryptSecret(current.token),
            body.username ?? current.username,
          );
        } catch (error) {
          const code = error instanceof Error && error.message === 'BOT_USERNAME_MISMATCH'
            ? error.message
            : 'INVALID_BOT_TOKEN';
          return reply.code(400).send({ error: code });
        }
      }
      const item = await prisma.$transaction(async (tx) => {
        if (body.isDefault) await tx.telegramBot.updateMany({ data: { isDefault: false } });
        const updated = await tx.telegramBot.update({
          where: { id },
          data: { ...body, token: body.token ? encryptSecret(body.token) : undefined },
        });
        await tx.auditLog.create({
          data: {
            adminId,
            action: 'bot_update',
            target: id,
            after: { ...body, token: body.token ? '[REDACTED]' : undefined },
          },
        });
        return updated;
      });
      pushService.clearBotCache();
      setImmediate(() => void reloadBots().catch((error) => console.error('[bot] reload failed', error)));
      return { ok: true, item: { ...item, token: undefined } };
    },
  );

  // ── 管理员与审计 ──
  app.get(
    '/api/admin/audit-logs',
    { preHandler: [app.authAdmin, app.requireAdminRoles('SUPER')] },
    async () => ({
      items: await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 1_000 }),
    }),
  );

  app.get('/api/admin/rebate-estimate/:userId', { preHandler: finance }, async (req) => {
    const { userId } = req.params as { userId: string };
    return { date: malaysiaDay(), commissionCents: String(await estimatedCommission(userId)) };
  });
}
