/**
 * 玩家端「代理专属」API — 对应《代理称桶制度与上下级分成机制说明文档》
 * 仅代理（Agent.status=ACTIVE）可用：称桶报表 / 玩家列表与升级 / 分成管理。
 * 推荐二维码复用现有 /api/promotion/invite-link（注册绑邀请人时自动归属最近的启用代理）。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { malaysiaDay, previousMalaysiaDay } from '../services/rebates.js';
import {
  ProfitPoolError,
  bucketShareCents,
  computeProfitPool,
  getProfitPoolConfig,
  promoteAgentPlayer,
  updateSubagentPoints,
} from '../services/profitPool.js';
import { PROFIT_POOL_ERROR_MESSAGES } from './profitPool.js';

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

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();

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
      },
    };
  });

  /** 称桶报表（默认昨日；已生成日回放快照，未生成日实时预估） */
  app.get('/api/agent/report', { preHandler: [app.authUser] }, async (req, reply) => {
    const agent = await requireAgent(req, reply);
    if (!agent) return;
    const { date } = z.object({ date: dateSchema }).parse(req.query);
    const day = date ?? previousMalaysiaDay();

    try {
      const pool = await computeProfitPool(day);
      const mine = pool.agents.find((row) => row.agentId === agent.id);
      const sharePoints = mine?.sharePoints ?? agent.sharePoints;
      const bucketBase = pool.bucketBase;

      // 「我的玩家」明细：当前归属玩家在该日的流水与对应利润（按我的占成折算，向下取整）。
      // 注：玩家集合以当前归属为准，历史日期若归属有变动仅影响明细展示，合计以报表快照为准。
      const bindings = await prisma.agentPlayer.findMany({
        where: { agentId: agent.id },
        include: { user: { select: { uid: true, nickname: true, avatarUrl: true } } },
      });
      const playerTurnovers = bindings.length
        ? await prisma.turnoverDaily.groupBy({
            by: ['userId'],
            where: { date: day, userId: { in: bindings.map((b) => b.userId) } },
            _sum: { selfCents: true },
          })
        : [];
      const turnoverByUser = new Map(
        playerTurnovers.map((row) => [row.userId, row._sum.selfCents ?? 0n]),
      );
      const players = bindings
        .map((binding) => {
          const turnover = turnoverByUser.get(binding.userId) ?? 0n;
          return {
            uidMasked: maskUid(binding.user.uid),
            nickname: binding.user.nickname,
            avatarUrl: binding.user.avatarUrl,
            turnoverCents: String(turnover),
            profitCents: String(
              bucketShareCents({
                netPoolCents: pool.netPoolCents,
                agentTurnoverCents: turnover,
                companyTurnoverCents: pool.turnoverCents,
                sharePoints,
                bucketBase,
              }),
            ),
          };
        })
        .sort((a, b) => Number(BigInt(b.turnoverCents) - BigInt(a.turnoverCents)));

      return {
        date: day,
        today: malaysiaDay(),
        status: pool.status,
        company: {
          turnoverCents: String(pool.turnoverCents),
          expenseCents: String(pool.expenseCents),
          rakeTotalCents: String(pool.rakeTotalCents),
          netPoolCents: String(pool.netPoolCents),
        },
        mine: {
          sharePoints,
          bucketBase,
          selfTurnoverCents: String(mine?.selfTurnoverCents ?? 0n),
          teamTurnoverCents: String(mine?.teamTurnoverCents ?? 0n),
          contributionBp: mine?.contributionBp ?? 0,
          selfAmountCents: String(mine?.selfAmountCents ?? 0n),
          overrideAmountCents: String(mine?.overrideAmountCents ?? 0n),
          totalAmountCents: String(mine?.amountCents ?? 0n),
        },
        subagents: (mine?.breakdown ?? []).map((row) => ({
          label: row.label,
          uidMasked: maskUid(row.uid),
          sharePoints: row.sharePoints,
          diffPoints: row.diffPoints,
          teamTurnoverCents: String(row.teamTurnoverCents),
          amountCents: String(row.amountCents),
        })),
        players,
      };
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
