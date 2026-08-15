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
  createAgent,
  getProfitPoolConfig,
  listAgentPlayers,
  listAgents,
  profitPoolTrend,
  setProfitPoolConfig,
  settleProfitPool,
  unbindAgentPlayer,
  updateAgent,
} from '../services/profitPool.js';

const PROFIT_POOL_ERROR_MESSAGES: Record<string, string> = {
  INVALID_DATE: '日期格式无效',
  DATE_NOT_CLOSED: '只能结算已结束的日期（马来西亚时区次日起可结）',
  INVALID_EXPENSE_RATIO: '支出比例必须在 0–100% 之间',
  INVALID_BUCKET_BASE: '称桶基准必须为 1–10000 的整数',
  INVALID_SHARE_POINTS: '占成点数必须为 0 到称桶基准之间的整数',
  USER_NOT_FOUND: '未找到该 UID 对应的用户',
  VIRTUAL_NOT_ALLOWED: '虚拟玩家不能作为代理或归属玩家',
  AGENT_ALREADY_EXISTS: '该用户已经是代理',
  AGENT_NOT_FOUND: '代理不存在',
  PLAYER_ALREADY_BOUND: '该玩家已归属其他代理，请先解绑',
  BINDING_NOT_FOUND: '未找到该归属关系',
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
      const [pool, trend, config, accounts] = await Promise.all([
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
      ]);
      return {
        today: malaysiaDay(),
        pool,
        trend,
        config,
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

  /** 手动结算指定日期（幂等；后台任务默认也会自动结前一日） */
  app.post('/api/admin/profit-pool/settle', guard, async (req, reply) => {
    const { date } = z
      .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
      .parse(req.body);
    try {
      const pool = await settleProfitPool(date, adminId(req));
      if (!pool) {
        return reply.code(409).send({
          error: 'ALREADY_SETTLED',
          message: `${date} 的利润池已结算过`,
        });
      }
      await audit(req, 'PROFIT_POOL_SETTLED', date, {
        netPoolCents: String(pool.netPoolCents),
        distributedCents: String(pool.distributedCents),
      });
      return { ok: true, pool };
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
