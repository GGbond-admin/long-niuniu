/**
 * 玩家端「代理专属」API — 对应《代理称桶制度与上下级分成机制说明文档》
 * 仅代理（Agent.status=ACTIVE）可用：称桶报表 / 玩家列表与升级 / 分成管理。
 * 推荐二维码复用现有 /api/promotion/invite-link（注册绑邀请人时自动归属最近的启用代理）。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import {
  ProfitPoolError,
  getProfitPoolConfig,
  promoteAgentPlayer,
  updateSubagentPoints,
} from '../services/profitPool.js';
import { PROFIT_POOL_ERROR_MESSAGES } from './profitPool.js';
import {
  listAgentDashboardPlayers,
  getAgentSelfDashboard,
  listAgentDashboardPeriods,
} from '../services/agentDashboard.js';

function maskUid(uid: string): string {
  if (uid.length <= 6) return uid;
  return `${uid.slice(0, 3)}****${uid.slice(-3)}`;
}

function sendAgentError(reply: FastifyReply, error: ProfitPoolError) {
  return reply.code(400).send({
    error: error.code,
    message: PROFIT_POOL_ERROR_MESSAGES[error.code] ?? error.code,
    details: error.details,
  });
}

export async function agentRoutes(app: FastifyInstance) {
  async function requireAgent(req: { user: unknown }, reply: FastifyReply) {
    const userId = (req.user as { sub: string }).sub;
    const agent = await prisma.agent.findUnique({
      where: { userId },
      include: {
        _count: { select: { players: true, children: true } },
      },
    });
    if (!agent || agent.status !== 'ACTIVE') {
      await reply.code(403).send({
        error: 'NOT_AGENT',
        message: '该功能仅限代理或以上级别使用',
      });
      return null;
    }
    return agent;
  }

  /** 代理身份与入口显隐（非代理返回 agent: null，不报错） */
  app.get('/api/agent/me', { preHandler: [app.authUser] }, async (req) => {
    const userId = (req.user as { sub: string }).sub;
    const [agent, config] = await Promise.all([
      prisma.agent.findUnique({
        where: { userId },
        include: { _count: { select: { players: true, children: true } } },
      }),
      getProfitPoolConfig(),
    ]);
    if (!agent || agent.status !== 'ACTIVE') return { agent: null };
    const latestReport = await prisma.profitPoolAgentSnapshot.findFirst({
      where: { sourceAgentId: agent.id, pool: { status: { not: 'VOIDED' } } },
      orderBy: [{ pool: { generatedAt: 'desc' } }, { poolId: 'desc' }],
      select: {
        poolId: true,
        pool: {
          select: {
            poolCode: true,
            generatedAt: true,
            status: true,
            room: { select: { title: true, gameCode: true } },
          },
        },
      },
    });
    return {
      agent: {
        id: agent.id,
        label: agent.label,
        sharePoints: agent.sharePoints,
        bucketBase: config.bucketBase,
        minReservePoints: config.minReservePoints,
        maxChildPoints: Math.max(0, agent.sharePoints - config.minReservePoints),
        playerCount: agent._count.players,
        subagentCount: agent._count.children,
        latestReport: latestReport
          ? {
              poolId: latestReport.poolId,
              poolCode: latestReport.pool.poolCode,
              generatedAt: latestReport.pool.generatedAt.toISOString(),
              status: latestReport.pool.status,
              room: latestReport.pool.room,
            }
          : null,
      },
    };
  });

  /** 代理专属看板：按正式利润池批次回放不可变快照，默认最新批次。 */
  app.get(
    '/api/agent/report/history',
    { preHandler: [app.authUser] },
    async (req, reply) => {
      const userId = (req.user as { sub: string }).sub;
      const { cursor, limit } = z
        .object({
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .parse(req.query);
      try {
        return await listAgentDashboardPeriods(userId, cursor, limit);
      } catch (error) {
        if (error instanceof ProfitPoolError) return sendAgentError(reply, error);
        throw error;
      }
    },
  );

  app.get(
    '/api/agent/report/players',
    { preHandler: [app.authUser] },
    async (req, reply) => {
      const userId = (req.user as { sub: string }).sub;
      const { poolId, cursor, limit } = z
        .object({
          poolId: z.string().min(1),
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .parse(req.query);
      try {
        return await listAgentDashboardPlayers(
          userId,
          poolId,
          cursor,
          limit,
        );
      } catch (error) {
        if (error instanceof ProfitPoolError) return sendAgentError(reply, error);
        throw error;
      }
    },
  );

  app.get('/api/agent/report', { preHandler: [app.authUser] }, async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const { poolId } = z.object({ poolId: z.string().optional() }).parse(req.query);
    try {
      return await getAgentSelfDashboard(userId, poolId);
    } catch (error) {
      if (error instanceof ProfitPoolError) return sendAgentError(reply, error);
      throw error;
    }
  });

  app.get('/api/agent/dashboard', { preHandler: [app.authUser] }, async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const { poolId } = z.object({ poolId: z.string().optional() }).parse(req.query);
    try {
      return await getAgentSelfDashboard(userId, poolId);
    } catch (error) {
      if (error instanceof ProfitPoolError) return sendAgentError(reply, error);
      throw error;
    }
  });

  /** 直属玩家列表（供查看与升级为代理） */
  app.get('/api/agent/players', { preHandler: [app.authUser] }, async (req, reply) => {
    const agent = await requireAgent(req, reply);
    if (!agent) return;
    const bindings = await prisma.agentPlayer.findMany({
      where: { agentId: agent.id },
      include: {
        user: {
          select: { uid: true, nickname: true, avatarUrl: true, createdAt: true },
        },
      },
      orderBy: { boundAt: 'desc' },
    });
    const totals = bindings.length
      ? await prisma.turnoverDaily.groupBy({
          by: ['userId'],
          where: { userId: { in: bindings.map((b) => b.userId) } },
          _sum: { selfCents: true },
        })
      : [];
    const totalByUser = new Map(totals.map((row) => [row.userId, row._sum.selfCents ?? 0n]));
    const config = await getProfitPoolConfig();
    return {
      maxChildPoints: Math.max(0, agent.sharePoints - config.minReservePoints),
      bucketBase: config.bucketBase,
      items: bindings.map((binding) => ({
        playerId: binding.userId,
        uidMasked: maskUid(binding.user.uid),
        nickname: binding.user.nickname,
        avatarUrl: binding.user.avatarUrl,
        joinedAt: binding.user.createdAt,
        boundAt: binding.boundAt,
        source: binding.source,
        totalTurnoverCents: String(totalByUser.get(binding.userId) ?? 0n),
      })),
    };
  });

  /** 升级直属玩家为下级代理（占成 ≤ 我的占成 − 最低预留） */
  app.post(
    '/api/agent/players/:playerId/promote',
    { preHandler: [app.authUser] },
    async (req, reply) => {
      const agent = await requireAgent(req, reply);
      if (!agent) return;
      const { playerId } = z.object({ playerId: z.string() }).parse(req.params);
      const { sharePoints, label } = z
        .object({
          sharePoints: z.number().int().min(0).max(10_000),
          label: z.string().trim().min(1).max(30).optional(),
        })
        .parse(req.body);
      try {
        const subagent = await promoteAgentPlayer({
          parentAgentId: agent.id,
          playerUserId: playerId,
          sharePoints,
          label,
          actorId: agent.id,
        });
        app.pushService
          ?.sendCustom(
            playerId,
            `🎉 您已被升级为代理\n称桶占成 ${sharePoints} 点。现在可以在「我的账号 → 代理专属」查看称桶报表、发展下级并管理分成。`,
          )
          .catch(() => {});
        return { ok: true, subagent };
      } catch (error) {
        if (error instanceof ProfitPoolError) return sendAgentError(reply, error);
        throw error;
      }
    },
  );

  /** 分成管理：直属下级代理列表 */
  app.get('/api/agent/subagents', { preHandler: [app.authUser] }, async (req, reply) => {
    const agent = await requireAgent(req, reply);
    if (!agent) return;
    const [children, config] = await Promise.all([
      prisma.agent.findMany({
        where: { parentAgentId: agent.id },
        include: {
          user: { select: { uid: true, nickname: true, avatarUrl: true } },
          _count: { select: { players: true, children: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      getProfitPoolConfig(),
    ]);
    return {
      mine: {
        sharePoints: agent.sharePoints,
        bucketBase: config.bucketBase,
        minReservePoints: config.minReservePoints,
        maxChildPoints: Math.max(0, agent.sharePoints - config.minReservePoints),
      },
      items: children.map((child) => ({
        agentId: child.id,
        label: child.label,
        uidMasked: maskUid(child.user.uid),
        nickname: child.user.nickname,
        avatarUrl: child.user.avatarUrl,
        sharePoints: child.sharePoints,
        status: child.status,
        playerCount: child._count.players,
        subagentCount: child._count.children,
        myDiffPoints: Math.max(0, agent.sharePoints - child.sharePoints),
        createdAt: child.createdAt,
      })),
    };
  });

  /** 分成管理：调整直属下级占成 */
  app.patch(
    '/api/agent/subagents/:id',
    { preHandler: [app.authUser] },
    async (req, reply) => {
      const agent = await requireAgent(req, reply);
      if (!agent) return;
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const { sharePoints } = z
        .object({ sharePoints: z.number().int().min(0).max(10_000) })
        .parse(req.body);
      try {
        const subagent = await updateSubagentPoints({
          parentAgentId: agent.id,
          subagentId: id,
          sharePoints,
        });
        return { ok: true, subagent };
      } catch (error) {
        if (error instanceof ProfitPoolError) return sendAgentError(reply, error);
        throw error;
      }
    },
  );
}
