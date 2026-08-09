import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { DEFAULT_REBATE_CONFIG } from '../engine/rebate.js';
import { getGameConfig } from '../services/gameConfig.js';
import { estimatedCommission } from '../services/rebates.js';
import {
  SUPPORTED_GAME_CODES,
  SUPREME_NIUNIU_GAME_CODE,
} from '../services/gameCatalog.js';

const dateSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

function todayKey(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kuala_Lumpur' });
}

export async function promotionRoutes(app: FastifyInstance) {
  /** 「我的推广」页数据（P-PRM-01~05） */
  app.get('/api/promotion', { preHandler: [app.authUser] }, async (req) => {
    const userId = (req.user as { sub: string }).sub;
    const { date } = dateSchema.parse(req.query);
    const day = date ?? todayKey();

    const rebateConfigs = new Map(
      await Promise.all(
        SUPPORTED_GAME_CODES.map(async (scopedGameCode) => [
          scopedGameCode,
          await getGameConfig(
            scopedGameCode,
            'rebate',
            DEFAULT_REBATE_CONFIG,
          ),
        ] as const),
      ),
    );
    const rebateConfig =
      rebateConfigs.get(SUPREME_NIUNIU_GAME_CODE) ?? DEFAULT_REBATE_CONFIG;
    const [currentYear, currentMonth] = todayKey().split('-');
    const monthStart = new Date(`${currentYear}-${currentMonth}-01T00:00:00+08:00`);

    const [turnovers, settlements, invitedTotal, invitedThisMonth, downlines] = await Promise.all([
      prisma.turnoverDaily.findMany({ where: { userId, date: day } }),
      prisma.rebateSettlement.findMany({ where: { userId, date: day } }),
      prisma.user.count({ where: { inviterId: userId } }),
      prisma.user.count({
        where: {
          inviterId: userId,
          inviterBoundAt: { gte: monthStart },
        },
      }),
      prisma.user.findMany({
        where: { inviterId: userId },
        select: { id: true, uid: true, nickname: true, avatarUrl: true, inviterBoundAt: true },
        orderBy: { inviterBoundAt: 'desc' },
        take: 50,
      }),
    ]);
    const contributionRows = await prisma.turnoverDaily.findMany({
      where: { userId: { in: downlines.map((downline) => downline.id) }, date: day },
      select: { userId: true, selfCents: true },
    });
    const contributions = new Map(
      contributionRows.reduce<Array<[string, bigint]>>((items, row) => {
        const existing = items.find(([userId]) => userId === row.userId);
        if (existing) existing[1] += row.selfCents;
        else items.push([row.userId, row.selfCents]);
        return items;
      }, []),
    );
    const commission = await estimatedCommission(userId, day);
    const settlementByGame = new Map(
      settlements.map((settlement) => [settlement.gameCode, settlement]),
    );
    const totalTurnover = turnovers.reduce(
      (total, row) => ({
        selfCents: total.selfCents + row.selfCents,
        l1Cents: total.l1Cents + row.l1Cents,
        l2Cents: total.l2Cents + row.l2Cents,
      }),
      { selfCents: 0n, l1Cents: 0n, l2Cents: 0n },
    );
    const fullySettled =
      turnovers.length > 0 &&
      turnovers.every((row) => settlementByGame.has(row.gameCode));

    return {
      rates: {
        self: rebateConfig.selfRate,
        l1: rebateConfig.l1Rate,
        l2: rebateConfig.l2Rate,
      },
      date: day,
      commissionCents: String(commission),
      commissionStatus: fullySettled ? 'PAID' : 'ESTIMATED',
      turnover: {
        selfCents: String(totalTurnover.selfCents),
        l1Cents: String(totalTurnover.l1Cents),
        l2Cents: String(totalTurnover.l2Cents),
      },
      gameBreakdown: turnovers.map((turnover) => {
        const config =
          rebateConfigs.get(
            turnover.gameCode as (typeof SUPPORTED_GAME_CODES)[number],
          ) ?? DEFAULT_REBATE_CONFIG;
        return {
          gameCode: turnover.gameCode,
          rates: {
            self: config.selfRate,
            l1: config.l1Rate,
            l2: config.l2Rate,
          },
          selfCents: String(turnover.selfCents),
          l1Cents: String(turnover.l1Cents),
          l2Cents: String(turnover.l2Cents),
          commissionCents: String(
            settlementByGame.get(turnover.gameCode)?.commissionCents ?? 0n,
          ),
          status: settlementByGame.has(turnover.gameCode)
            ? 'PAID'
            : 'ESTIMATED',
        };
      }),
      invitedTotal,
      invitedThisMonth,
      downlines: downlines.map((d) => ({
        uid: `${d.uid.slice(0, 3)}****${d.uid.slice(-3)}`,
        nickname: d.nickname,
        avatarUrl: d.avatarUrl,
        boundAt: d.inviterBoundAt,
        contributionCents: String(contributions.get(d.id) ?? 0n),
      })),
    };
  });

  /** 「邀请好友」页：专属链接（前端据此生成二维码） */
  app.get('/api/promotion/invite-link', { preHandler: [app.authUser] }, async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const bot =
      (await prisma.telegramBot.findFirst({ where: { isDefault: true, status: 'ACTIVE' } })) ??
      (await prisma.telegramBot.findFirst({ where: { status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } })) ??
      (await prisma.telegramBot.findFirst({ orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] }));
    const username =
      bot?.username?.trim() ||
      process.env.DEFAULT_BOT_USERNAME?.trim() ||
      '';
    if (!username) {
      return reply.code(503).send({
        error: 'NO_DEFAULT_BOT',
        message: '尚未配置默认 Bot，请在后台「Bot 管理」添加并设为默认入口',
      });
    }
    return {
      uid: user.uid,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      deepLink: `https://t.me/${username}?startapp=ref_${user.uid}`,
      botLink: `https://t.me/${username}?start=ref_${user.uid}`,
    };
  });
}
