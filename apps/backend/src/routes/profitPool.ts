/**
 * 后台「利润池与称桶分配」API — 对应《利润池与称桶分配模式说明文档》
 * 权限：SUPER / FINANCE
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { malaysiaDay } from '../services/rebates.js';
import {
  ProfitPoolError,
  bindAgentPlayer,
  computeProfitPool,
  confirmProfitPool,
  createAgent,
  discardPendingProfitPool,
  generateProfitPool,
  getProfitPoolConfig,
  listAgentPlayers,
  listAgents,
  profitPoolTrend,
  setProfitPoolConfig,
  unbindAgentPlayer,
  updateAgent,
} from '../services/profitPool.js';
import { houseInviteLinks } from '../services/houseInviter.js';

export const PROFIT_POOL_ERROR_MESSAGES: Record<string, string> = {
  INVALID_DATE: '日期格式无效',
  DATE_NOT_CLOSED: '只能生成已结束日期的报表（马来西亚时区次日起可结）',
  INVALID_EXPENSE_RATIO: '支出比例必须在 0–100% 之间',
  INVALID_BUCKET_BASE: '称桶基准必须为 1–10000 的整数',
  INVALID_MIN_RESERVE: '最低预留点数必须为 0 到称桶基准之间的整数',
  INVALID_SHARE_POINTS: '占成点数必须为 0 到称桶基准之间的整数',
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
  POOL_NOT_GENERATED: '该日报表尚未生成',
  POOL_NOT_CONFIRMABLE: '该日报表状态不允许发放（负池不分配日无需发放）',
  POOL_ALREADY_SETTLED: '该日报表已确认发放，不能作废',
};

function sendProfitPoolError(reply: FastifyReply, error: ProfitPoolError) {
  return reply.code(400).send({
    error: error.code,
    message: PROFIT_POOL_ERROR_MESSAGES[error.code] ?? error.code,
    details: error.details,
  });
}

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();

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

  /** 池况总览：当日（或指定日）计算 + 近 14 日趋势 + 配置 */
  app.get('/api/admin/profit-pool/overview', guard, async (req, reply) => {
    const { date } = z.object({ date: dateSchema }).parse(req.query);
    const day = date ?? malaysiaDay();
    try {
      const [pool, trend, config, accounts, houseInvite] = await Promise.all([
        computeProfitPool(day),
        profitPoolTrend(14),
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
        today: malaysiaDay(),
        pool,
        trend,
        config,
        houseInvite,
        accountBalances: Object.fromEntries(
          accounts.map((account) => [account.accountType, String(account.balanceCents)]),
        ),
      };
    } catch (error) {
      if (error instanceof ProfitPoolError) return sendProfitPoolError(reply, error);
      throw error;
    }
  });

  /** 分配历史（已结算的池，含代理明细） */
  app.get('/api/admin/profit-pool/history', guard, async (req) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(90).default(30) })
      .parse(req.query);
    const pools = await prisma.profitPoolDaily.findMany({
      orderBy: { date: 'desc' },
      take: limit,
      include: {
        shares: {
          include: {
            agent: {
              include: { user: { select: { uid: true, nickname: true } } },
            },
          },
          orderBy: { amountCents: 'desc' },
        },
      },
    });
    return { items: pools };
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

  /** 第一阶段：生成指定日期的称桶报表（PENDING 待确认；后台任务默认也会自动生成前一日） */
  app.post('/api/admin/profit-pool/generate', guard, async (req, reply) => {
    const { date } = z
      .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
      .parse(req.body);
    try {
      const pool = await generateProfitPool(date, adminId(req));
      if (!pool) {
        return reply.code(409).send({
          error: 'ALREADY_GENERATED',
          message: `${date} 的称桶报表已生成过`,
        });
      }
      await audit(req, 'PROFIT_POOL_GENERATED', date, {
        netPoolCents: String(pool.netPoolCents),
        distributedCents: String(pool.distributedCents),
        status: pool.status,
      });
      return { ok: true, pool };
    } catch (error) {
      if (error instanceof ProfitPoolError) return sendProfitPoolError(reply, error);
      throw error;
    }
  });

  /** 第二阶段：确认发放（PENDING → SETTLED，逐笔转账 + 推送） */
  app.post('/api/admin/profit-pool/confirm', guard, async (req, reply) => {
    const { date } = z
      .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
      .parse(req.body);
    try {
      const pool = await confirmProfitPool(date, adminId(req));
      if (!pool) {
        return reply.code(409).send({
          error: 'ALREADY_SETTLED',
          message: `${date} 的称桶分成已发放过`,
        });
      }
      await audit(req, 'PROFIT_POOL_CONFIRMED', date, {
        netPoolCents: String(pool.netPoolCents),
        distributedCents: String(pool.distributedCents),
      });
      return { ok: true, pool };
    } catch (error) {
      if (error instanceof ProfitPoolError) return sendProfitPoolError(reply, error);
      throw error;
    }
  });

  /** 作废待确认报表（未转账，可安全重算：先作废再重新生成） */
  app.post('/api/admin/profit-pool/discard', guard, async (req, reply) => {
    const { date } = z
      .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
      .parse(req.body);
    try {
      const pool = await discardPendingProfitPool(date);
      await audit(req, 'PROFIT_POOL_DISCARDED', date, {
        netPoolCents: String(pool.netPoolCents),
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof ProfitPoolError) return sendProfitPoolError(reply, error);
      throw error;
    }
  });

  app.get('/api/admin/profit-pool/config', guard, async () => ({
    config: await getProfitPoolConfig(),
  }));

  app.put('/api/admin/profit-pool/config', guard, async (req, reply) => {
    const patch = configSchema.parse(req.body);
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
