/** 按房间局号范围的称桶利润池、不可变快照与代理网络 API。权限：SUPER / FINANCE。 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import {
  ProfitPoolError,
  bindAgentPlayer,
  createAgent,
  discardPendingProfitPool,
  getProfitPoolConfig,
  listAgentPlayers,
  listAgents,
  setProfitPoolConfig,
  unbindAgentPlayer,
  updateAgent,
} from '../services/profitPool.js';
import { houseInviteLinks } from '../services/houseInviter.js';
import {
  distributeProfitPoolBatch,
  generateProfitPoolBatch,
  getProfitPoolBatch,
  getProfitPoolOverview,
  listProfitPoolBatches,
  listProfitPoolRooms,
  previewProfitPoolBatch,
  serializeProfitPoolBatch,
  serializeProfitPoolComputation,
} from '../services/profitPoolBatches.js';
import {
  getAdminAgentDashboard,
  getAdminAgentNetwork,
  listAdminAgentDashboardPeriods,
  listAdminAgentDashboardPlayers,
} from '../services/agentDashboard.js';

export const PROFIT_POOL_ERROR_MESSAGES: Record<string, string> = {
  INVALID_DATE: '日期格式无效',
  DATE_NOT_CLOSED: '只能生成已结束日期的报表（马来西亚时区次日起可结）',
  SEQ_RANGE_INVALID: '开始局数和结束局数无效',
  SEQ_RANGE_TOO_LARGE: '单次选择的局数过多，请缩小范围',
  ROUND_RANGE_INCOMPLETE: '所选范围存在缺失局号，请重新选择',
  ROUNDS_NOT_TERMINAL: '所选范围包含尚未结束的牌局',
  ROUND_CONFIG_SNAPSHOT_MISSING: '所选历史牌局缺少配置快照，无法安全重算',
  RANGE_OVERLAP: '该范围包含已生成利润池的游戏局数，请重新选择',
  CUTOVER_SEQ_BLOCKED: '所选局数属于旧按日结算范围，不能重复生成',
  PREVIEW_STALE: '牌局或代理数据已变化，请重新预览后再生成',
  LEGACY_PENDING_EXISTS: '仍有旧按日报表待处理，请先完成迁移',
  INVALID_EXPENSE_RATIO: '支出比例必须在 0–100% 之间',
  INVALID_BUCKET_BASE: '称桶基准必须为 1–10000 的整数',
  INVALID_MIN_RESERVE: '最低预留点数必须为 0 到称桶基准之间的整数',
  INVALID_TIER_PRESET_POINTS: '占成预设点数必须在 0 到称桶基准之间',
  MIN_RESERVE_BREAKS_EXISTING_TREE: '新的最低预留点数与现有代理层级冲突，请先调整代理占成',
  BUCKET_BASE_BELOW_EXISTING_AGENT_POINTS: '新的称桶基准低于现有代理占成，请先调整代理占成',
  INVALID_SHARE_POINTS: '占成点数必须为 0 到称桶基准之间的整数',
  INVALID_AGENT_HIERARCHY: '代理层级占成不符合最低预留规则，请先修正代理点数',
  DISTRIBUTION_EXCEEDS_POOL: '代理分配合计超过可分配利润池，已停止生成，请检查代理层级配置',
  DISTRIBUTION_SNAPSHOT_MISMATCH: '代理分配快照与利润池总额不一致，已停止发放',
  SHARE_POINTS_OUT_OF_RANGE: '占成点数超出允许范围（受上级/下级占成与最低预留限制）',
  USER_NOT_FOUND: '未找到该 UID 对应的用户',
  VIRTUAL_NOT_ALLOWED: '虚拟玩家不能作为代理或归属玩家',
  AGENT_ALREADY_EXISTS: '该用户已经是代理',
  AGENT_NOT_FOUND: '代理不存在',
  SUBAGENT_NOT_FOUND: '该代理不是你的直属下级',
  AGENT_CANNOT_BE_PLAYER: '该用户已是代理，不能再绑定为归属玩家',
  USER_IS_BOUND_PLAYER: '该用户已归属某个代理名下，请先解绑再建为代理',
  PLAYER_ALREADY_BOUND: '该玩家已归属其他代理，请先解绑',
  BINDING_NOT_FOUND: '未找到该归属关系',
  ROOM_NOT_FOUND: '游戏房间不存在',
  POOL_NOT_GENERATED: '利润池不存在',
  POOL_NOT_CONFIRMABLE: '该利润池状态不允许发放',
  POOL_ALREADY_SETTLED: '该利润池已经发放',
};

function sendProfitPoolError(reply: FastifyReply, error: ProfitPoolError) {
  const statusCode =
    error.code === 'ROOM_NOT_FOUND' ||
    error.code === 'POOL_NOT_GENERATED' ||
    error.code === 'AGENT_NOT_FOUND'
      ? 404
      : [
            'RANGE_OVERLAP',
            'PREVIEW_STALE',
            'LEGACY_PENDING_EXISTS',
            'POOL_ALREADY_SETTLED',
          ].includes(error.code)
        ? 409
        : 400;
  return reply.code(statusCode).send({
    error: error.code,
    message: PROFIT_POOL_ERROR_MESSAGES[error.code] ?? error.code,
    details: error.details,
  });
}

const rangeSelectionSchema = z
  .object({
    roomId: z.string().trim().min(1),
    startSeqNo: z.number().int().min(1),
    endSeqNo: z.number().int().min(1),
  })
  .strict();
const rangeSchema = rangeSelectionSchema.extend({
  expenseBps: z.number().int().min(0).max(10_000),
});

const configSchema = z
  .object({
    expenseRatio: z.number().min(0).max(1).optional(),
    bucketBase: z.number().int().min(1).max(10_000).optional(),
    minReservePoints: z.number().int().min(0).max(10_000).optional(),
    autoSettle: z.boolean().optional(),
    tierPresets: z
      .array(
        z.object({
          label: z.string().trim().min(1).max(20),
          points: z.number().int().min(0).max(10_000),
        }),
      )
      .max(10)
      .optional(),
  })
  .strict();

const createAgentSchema = z.object({
  uid: z.string().trim().min(1),
  label: z.string().trim().min(1).max(30),
  sharePoints: z.number().int().min(0).max(10_000),
});

const updateAgentSchema = z
  .object({
    label: z.string().trim().min(1).max(30).optional(),
    sharePoints: z.number().int().min(0).max(10_000).optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  })
  .strict();

const userOptionQuerySchema = z.object({
  q: z.string().trim().max(100).default(''),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});

export async function adminProfitPoolRoutes(app: FastifyInstance) {
  const guard = {
    preHandler: [app.authAdmin, app.requireAdminRoles('SUPER', 'FINANCE')],
  };

  function adminId(req: { user: unknown }): string {
    return (req.user as { sub: string }).sub;
  }

  async function audit(
    req: { user: unknown; ip: string },
    action: string,
    target: string,
    after?: unknown,
  ) {
    await prisma.auditLog.create({
      data: {
        adminId: adminId(req),
        action,
        target,
        after: after === undefined ? undefined : JSON.parse(JSON.stringify(after)),
        ip: req.ip,
      },
    });
  }

  /** 新版总览：最新局数池、累计金额、状态数量、默认配置与平台科目。 */
  app.get('/api/admin/profit-pool/overview', guard, async () => {
    const [overview, config, accounts, houseInvite] = await Promise.all([
      getProfitPoolOverview(),
      getProfitPoolConfig(),
      prisma.platformAccount.findMany({
        where: {
          accountType: {
            in: ['PLATFORM_RAKE', 'PLATFORM_PROFIT_POOL', 'PLATFORM_FEES'],
          },
        },
      }),
      houseInviteLinks(),
    ]);
    return {
      ...overview,
      latest: overview.latest ? serializeProfitPoolBatch(overview.latest) : null,
      totals: {
        netPoolCents: String(overview.totals.netPoolCents ?? 0n),
        distributedCents: String(overview.totals.distributedCents ?? 0n),
        residualCents: String(overview.totals.residualCents ?? 0n),
        turnoverCents: String(overview.totals.turnoverCents ?? 0n),
      },
      config: { ...config, autoSettle: false },
      houseInvite,
      accountBalances: Object.fromEntries(
        accounts.map((account) => [account.accountType, String(account.balanceCents)]),
      ),
    };
  });

  app.get('/api/admin/profit-pool/rooms', guard, async () => ({
    items: await listProfitPoolRooms(),
  }));

  /** 正式批次列表：按编号、状态、房间筛选。 */
  app.get('/api/admin/profit-pool/history', guard, async (req) => {
    const query = z
      .object({
        q: z.string().trim().max(40).optional(),
        status: z.enum(['PENDING', 'DISTRIBUTED', 'NO_DISTRIBUTION']).optional(),
        roomId: z.string().trim().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
        cursor: z.string().optional(),
      })
      .parse(req.query);
    const result = await listProfitPoolBatches(query);
    return {
      ...result,
      items: result.items.map((batch: (typeof result.items)[number]) =>
        serializeProfitPoolBatch(batch),
      ),
    };
  });

  /**
   * 代理管理专用用户选择器。
   * 返回代理/玩家归属状态，前端可在选择阶段直接说明用户是否可用，
   * 避免管理员记 UID 或提交后才发现用户已被占用。
   */
  app.get('/api/admin/profit-pool/user-options', guard, async (req) => {
    const { q, limit } = userOptionQuerySchema.parse(req.query);
    const tgIdCandidate = q && /^\d{1,19}$/.test(q) ? BigInt(q) : undefined;
    const tgId =
      tgIdCandidate !== undefined && tgIdCandidate <= 9_223_372_036_854_775_807n
        ? tgIdCandidate
        : undefined;
    const users = await prisma.user.findMany({
      where: {
        kind: 'HUMAN',
        NOT: { adminNote: 'HOUSE_INVITER' },
        ...(q
          ? {
              OR: [
                { uid: { contains: q } },
                { nickname: { contains: q, mode: 'insensitive' as const } },
                {
                  tgUsername: {
                    contains: q.replace(/^@/, ''),
                    mode: 'insensitive' as const,
                  },
                },
                { tgDisplayName: { contains: q, mode: 'insensitive' as const } },
                ...(tgId ? [{ tgId }] : []),
              ],
            }
          : {}),
      },
      select: {
        id: true,
        uid: true,
        nickname: true,
        tgUsername: true,
        tgDisplayName: true,
        status: true,
        wallet: { select: { availableCents: true } },
        agentProfile: {
          select: { id: true, label: true, status: true },
        },
        agentBinding: {
          select: {
            agentId: true,
            agent: { select: { label: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return {
      items: users.map((user) => ({
        id: user.id,
        uid: user.uid,
        nickname: user.nickname,
        tgUsername: user.tgUsername,
        tgDisplayName: user.tgDisplayName,
        status: user.status,
        availableCents: String(user.wallet?.availableCents ?? 0),
        agent: user.agentProfile,
        binding: user.agentBinding
          ? {
              agentId: user.agentBinding.agentId,
              agentLabel: user.agentBinding.agent.label,
            }
          : null,
      })),
    };
  });

  /** 向导第 1 步：只检查局号范围；0% 计算不会落库。 */
  app.post('/api/admin/profit-pool/range/check', guard, async (req, reply) => {
    const selection = rangeSelectionSchema.parse(req.body);
    try {
      const preview = await previewProfitPoolBatch({ ...selection, expenseBps: 0 });
      return {
        ok: true,
        room: preview.room,
        startSeqNo: preview.startSeqNo,
        endSeqNo: preview.endSeqNo,
        roundCount: preview.roundCount,
        finishedRoundCount: preview.finishedRoundCount,
        cancelledRoundCount: preview.cancelledRoundCount,
      };
    } catch (error) {
      if (error instanceof ProfitPoolError) return sendProfitPoolError(reply, error);
      throw error;
    }
  });

  /** 向导第 3 步：按必填支出百分比生成只读核对数据。 */
  app.post('/api/admin/profit-pool/preview', guard, async (req, reply) => {
    const body = rangeSchema.parse(req.body);
    try {
      return { preview: serializeProfitPoolComputation(await previewProfitPoolBatch(body)) };
    } catch (error) {
      if (error instanceof ProfitPoolError) return sendProfitPoolError(reply, error);
      throw error;
    }
  });

  /** 向导第 4 步：二次确认后正式生成、永久锁局，状态为待分配/无需分配。 */
  app.post('/api/admin/profit-pool/generate', guard, async (req, reply) => {
    const body = rangeSchema
      .extend({ calculationHash: z.string().length(64) })
      .parse(req.body);
    try {
      const pool = await generateProfitPoolBatch({
        ...body,
        actorId: adminId(req),
        auditIp: req.ip,
      });
      return {
        ok: true,
        pool: {
          ...serializeProfitPoolBatch(pool),
          agentSnapshots: pool.agentSnapshots.map(
            (agent: (typeof pool.agentSnapshots)[number]) => ({
            ...agent,
            selfTurnoverCents: String(agent.selfTurnoverCents),
            teamTurnoverCents: String(agent.teamTurnoverCents),
            selfAmountCents: String(agent.selfAmountCents),
            overrideAmountCents: String(agent.overrideAmountCents),
            amountCents: String(agent.amountCents),
            }),
          ),
        },
      };
    } catch (error) {
      if (error instanceof ProfitPoolError) return sendProfitPoolError(reply, error);
      throw error;
    }
  });

  app.get('/api/admin/profit-pool/batches/:id', guard, async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    try {
      const pool = await getProfitPoolBatch(id);
      return {
        pool: {
          ...serializeProfitPoolBatch(pool),
          agentSnapshots: pool.agentSnapshots.map(
            (agent: (typeof pool.agentSnapshots)[number]) => ({
            ...agent,
            selfTurnoverCents: String(agent.selfTurnoverCents),
            teamTurnoverCents: String(agent.teamTurnoverCents),
            selfAmountCents: String(agent.selfAmountCents),
            overrideAmountCents: String(agent.overrideAmountCents),
            amountCents: String(agent.amountCents),
            }),
          ),
        },
      };
    } catch (error) {
      if (error instanceof ProfitPoolError) return sendProfitPoolError(reply, error);
      throw error;
    }
  });

  /** 独立不可逆发放动作：PENDING → DISTRIBUTED。 */
  app.post(
    '/api/admin/profit-pool/batches/:id/distribute',
    guard,
    async (req, reply) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      try {
        const pool = await distributeProfitPoolBatch(id, adminId(req), req.ip);
        if (!pool) {
          return reply.code(409).send({
            error: 'POOL_ALREADY_SETTLED',
            message: PROFIT_POOL_ERROR_MESSAGES.POOL_ALREADY_SETTLED,
          });
        }
        return { ok: true, pool: serializeProfitPoolBatch(pool) };
      } catch (error) {
        if (error instanceof ProfitPoolError) return sendProfitPoolError(reply, error);
        throw error;
      }
    },
  );

  app.get('/api/admin/profit-pool/network', guard, async (req, reply) => {
    const { poolId } = z.object({ poolId: z.string().optional() }).parse(req.query);
    try {
      return await getAdminAgentNetwork(poolId);
    } catch (error) {
      if (error instanceof ProfitPoolError) return sendProfitPoolError(reply, error);
      throw error;
    }
  });

  app.get('/api/admin/profit-pool/agents/:id/dashboard', guard, async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const { poolId } = z.object({ poolId: z.string().optional() }).parse(req.query);
    try {
      return await getAdminAgentDashboard(id, poolId);
    } catch (error) {
      if (error instanceof ProfitPoolError) return sendProfitPoolError(reply, error);
      throw error;
    }
  });

  app.get(
    '/api/admin/profit-pool/agents/:id/dashboard/periods',
    guard,
    async (req, reply) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      const { cursor, limit } = z
        .object({
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(20),
        })
        .parse(req.query);
      try {
        return await listAdminAgentDashboardPeriods(id, cursor, limit);
      } catch (error) {
        if (error instanceof ProfitPoolError) return sendProfitPoolError(reply, error);
        throw error;
      }
    },
  );

  app.get(
    '/api/admin/profit-pool/agents/:id/dashboard/players',
    guard,
    async (req, reply) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      const { poolId, cursor, limit } = z
        .object({
          poolId: z.string().optional(),
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(20),
        })
        .parse(req.query);
      try {
        return await listAdminAgentDashboardPlayers(
          id,
          poolId,
          cursor,
          limit,
        );
      } catch (error) {
        if (error instanceof ProfitPoolError) return sendProfitPoolError(reply, error);
        throw error;
      }
    },
  );

  app.get('/api/admin/profit-pool/batches/:id/export.csv', guard, async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    try {
      const pool = await getProfitPoolBatch(id);
      const escape = (value: unknown) => {
        const raw = String(value ?? '');
        const safe =
          typeof value === 'string' && /^\s*[=+\-@]/.test(raw) ? `'${raw}` : raw;
        return `"${safe.replaceAll('"', '""')}"`;
      };
      const lines = [
        ['利润池编号', pool.poolCode],
        ['游戏房间', pool.room.title],
        ['结算局数', `${pool.startSeqNo}-${pool.endSeqNo}`],
        ['总流水(分)', pool.turnoverCents],
        ['总抽水(分)', pool.rakeTotalCents],
        ['公司支出(分)', pool.expenseCents],
        ['最终利润池(分)', pool.netPoolCents],
        ['代理分配(分)', pool.distributedCents],
        ['公司留存(分)', pool.residualCents],
        [],
        [
          '代理账号',
          '展示名',
          '层级',
          '上级代理ID',
          '占成点数',
          '自身流水(分)',
          '团队流水(分)',
          '自身利润(分)',
          '差额利润(分)',
          '合计利润(分)',
          '直属代理',
          '团队代理',
          '直属玩家',
          '团队玩家',
        ],
        ...pool.agentSnapshots.map((agent: (typeof pool.agentSnapshots)[number]) => [
          agent.uid,
          agent.label,
          agent.level,
          agent.parentSourceAgentId ?? '',
          agent.sharePointsSnapshot,
          agent.selfTurnoverCents,
          agent.teamTurnoverCents,
          agent.selfAmountCents,
          agent.overrideAmountCents,
          agent.amountCents,
          agent.directAgentCount,
          agent.teamAgentCount,
          agent.directPlayerCount,
          agent.teamPlayerCount,
        ]),
      ];
      const csv = `\uFEFF${lines.map((line) => line.map(escape).join(',')).join('\r\n')}`;
      return reply
        .type('text/csv; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(pool.poolCode)}.csv"`,
        )
        .send(csv);
    } catch (error) {
      if (error instanceof ProfitPoolError) return sendProfitPoolError(reply, error);
      throw error;
    }
  });

  /** 旧按日报表永久只读，保留完整分页查询供迁移审计。 */
  app.get('/api/admin/profit-pool/legacy/history', guard, async (req) => {
    const query = z
      .object({
        cursor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        status: z.enum(['PENDING', 'SETTLED', 'NO_DISTRIBUTION']).optional(),
      })
      .parse(req.query);
    const rows = await prisma.profitPoolDaily.findMany({
      where: query.status ? { status: query.status } : undefined,
      orderBy: { date: 'desc' },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { date: query.cursor }, skip: 1 } : {}),
      include: { _count: { select: { shares: true } } },
    });
    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items: items.map((item) => ({
        id: item.id,
        date: item.date,
        status: item.status,
        turnoverCents: String(item.turnoverCents),
        rakeTotalCents: String(item.rakeTotalCents),
        expenseCents: String(item.expenseCents),
        netPoolCents: String(item.netPoolCents),
        distributedCents: String(item.distributedCents),
        residualCents: String(item.residualCents),
        shareCount: item._count.shares,
        createdAt: item.createdAt,
        confirmedAt: item.confirmedAt,
      })),
      nextCursor: hasMore ? items.at(-1)?.date ?? null : null,
    };
  });

  app.get('/api/admin/profit-pool/legacy/:date', guard, async (req, reply) => {
    const { date } = z
      .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
      .parse(req.params);
    const pool = await prisma.profitPoolDaily.findUnique({
      where: { date },
      include: {
        shares: {
          orderBy: { amountCents: 'desc' },
          include: {
            agent: {
              select: {
                id: true,
                label: true,
                user: { select: { uid: true, nickname: true } },
              },
            },
          },
        },
      },
    });
    if (!pool) {
      return reply.code(404).send({
        error: 'POOL_NOT_GENERATED',
        message: PROFIT_POOL_ERROR_MESSAGES.POOL_NOT_GENERATED,
      });
    }
    return {
      pool: {
        ...pool,
        rakePlayerCents: String(pool.rakePlayerCents),
        rakeBankerCents: String(pool.rakeBankerCents),
        rakeTotalCents: String(pool.rakeTotalCents),
        turnoverCents: String(pool.turnoverCents),
        expenseCents: String(pool.expenseCents),
        carryInCents: String(pool.carryInCents),
        netPoolCents: String(pool.netPoolCents),
        distributedCents: String(pool.distributedCents),
        residualCents: String(pool.residualCents),
        carryOutCents: String(pool.carryOutCents),
        shares: pool.shares.map((share) => ({
          ...share,
          turnoverCents: String(share.turnoverCents),
          teamTurnoverCents: String(share.teamTurnoverCents),
          companyTurnoverCents: String(share.companyTurnoverCents),
          selfAmountCents: String(share.selfAmountCents),
          overrideAmountCents: String(share.overrideAmountCents),
          amountCents: String(share.amountCents),
        })),
      },
    };
  });

  /** 切换前遗留的 PENDING 日报必须人工删除，避免日池与局数池同时待发。 */
  app.get('/api/admin/profit-pool/legacy/pending', guard, async () => {
    const items = await prisma.profitPoolDaily.findMany({
      where: { status: 'PENDING' },
      orderBy: { date: 'asc' },
      select: {
        id: true,
        date: true,
        turnoverCents: true,
        netPoolCents: true,
        distributedCents: true,
        createdAt: true,
      },
    });
    return {
      items: items.map((item) => ({
        ...item,
        turnoverCents: String(item.turnoverCents),
        netPoolCents: String(item.netPoolCents),
        distributedCents: String(item.distributedCents),
      })),
    };
  });

  app.post(
    '/api/admin/profit-pool/legacy/:date/discard',
    guard,
    async (req, reply) => {
      const { date } = z
        .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
        .parse(req.params);
      try {
        await discardPendingProfitPool(date, adminId(req), req.ip);
        return { ok: true };
      } catch (error) {
        if (error instanceof ProfitPoolError) return sendProfitPoolError(reply, error);
        throw error;
      }
    },
  );

  app.get('/api/admin/profit-pool/config', guard, async () => ({
    config: { ...(await getProfitPoolConfig()), autoSettle: false },
  }));

  app.put('/api/admin/profit-pool/config', guard, async (req, reply) => {
    const patch = { ...configSchema.parse(req.body), autoSettle: false };
    try {
      const config = await setProfitPoolConfig(patch, adminId(req));
      await audit(req, 'PROFIT_POOL_CONFIG_UPDATED', 'profitPool', config);
      return { ok: true, config };
    } catch (error) {
      if (error instanceof ProfitPoolError) return sendProfitPoolError(reply, error);
      throw error;
    }
  });

  app.get('/api/admin/profit-pool/agents', guard, async () => ({
    items: await listAgents(),
  }));

  app.post('/api/admin/profit-pool/agents', guard, async (req, reply) => {
    const body = createAgentSchema.parse(req.body);
    try {
      const agent = await createAgent({ ...body, actorId: adminId(req) });
      await audit(req, 'AGENT_CREATED', agent.id, body);
      return { ok: true, agent };
    } catch (error) {
      if (error instanceof ProfitPoolError) return sendProfitPoolError(reply, error);
      throw error;
    }
  });

  app.patch('/api/admin/profit-pool/agents/:id', guard, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = updateAgentSchema.parse(req.body);
    try {
      const agent = await updateAgent({ agentId: id, ...body });
      await audit(req, 'AGENT_UPDATED', id, body);
      return { ok: true, agent };
    } catch (error) {
      if (error instanceof ProfitPoolError) return sendProfitPoolError(reply, error);
      throw error;
    }
  });

  app.get('/api/admin/profit-pool/agents/:id/players', guard, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    try {
      return { items: await listAgentPlayers(id) };
    } catch (error) {
      if (error instanceof ProfitPoolError) return sendProfitPoolError(reply, error);
      throw error;
    }
  });

  app.post('/api/admin/profit-pool/agents/:id/players', guard, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { uid } = z.object({ uid: z.string().trim().min(1) }).parse(req.body);
    try {
      const binding = await bindAgentPlayer({ agentId: id, uid, actorId: adminId(req) });
      await audit(req, 'AGENT_PLAYER_BOUND', id, { uid });
      return { ok: true, binding };
    } catch (error) {
      if (error instanceof ProfitPoolError) return sendProfitPoolError(reply, error);
      throw error;
    }
  });

  app.delete(
    '/api/admin/profit-pool/agents/:id/players/:userId',
    guard,
    async (req, reply) => {
      const { id, userId } = z
        .object({ id: z.string(), userId: z.string() })
        .parse(req.params);
      try {
        await unbindAgentPlayer(id, userId);
        await audit(req, 'AGENT_PLAYER_UNBOUND', id, { userId });
        return { ok: true };
      } catch (error) {
        if (error instanceof ProfitPoolError) return sendProfitPoolError(reply, error);
        throw error;
      }
    },
  );
}
