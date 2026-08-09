import { AccountType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { serializable } from '../lib/transaction.js';
import { getGameConfig } from './gameConfig.js';
import { getGameSettings } from './gameSettings.js';
import { malaysiaDay } from './rebates.js';
import { transfer } from './wallet.js';

export type Period = 'daily' | 'weekly' | 'monthly';
export type BoardType = 'points' | 'hands' | 'banker';

interface LeaderboardConfig {
  topN: number;
  maskNames: boolean;
  /** 积分榜固定按目标游戏统计期内的有效流水。 */
  pointsMetric: 'turnover';
  enabledTypes: BoardType[];
  labels: Record<BoardType, string>;
}

const DEFAULT_CONFIG: LeaderboardConfig = {
  topN: 50,
  maskNames: true,
  pointsMetric: 'turnover',
  enabledTypes: ['points', 'hands', 'banker'],
  labels: {
    points: '积分榜',
    hands: '牌型榜',
    banker: '打桩榜',
  },
};

function maskName(value: string | null): string {
  if (!value) return '玩家';
  if (value.length <= 1) return `${value}*`;
  return `${value[0]}${'*'.repeat(Math.min(3, value.length - 1))}`;
}

function isoWeek(day: string): { year: number; week: number; monday: string; sunday: string } {
  const date = new Date(`${day}T00:00:00Z`);
  const weekday = date.getUTCDay() || 7;
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - weekday + 1);
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return {
    year: thursday.getUTCFullYear(),
    week,
    monday: monday.toISOString().slice(0, 10),
    sunday: sunday.toISOString().slice(0, 10),
  };
}

function periodBounds(period: Period, day = malaysiaDay()) {
  if (period === 'daily') return { key: day, start: day, end: day };
  if (period === 'weekly') {
    const week = isoWeek(day);
    return {
      key: `${week.year}-W${String(week.week).padStart(2, '0')}`,
      start: week.monday,
      end: week.sunday,
    };
  }
  const [year, month] = day.split('-').map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    key: `${year}-${String(month).padStart(2, '0')}`,
    start: `${year}-${String(month).padStart(2, '0')}-01`,
    end: `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`,
  };
}

function timestampBounds(start: string, end: string) {
  const from = new Date(`${start}T00:00:00+08:00`);
  const until = new Date(`${end}T00:00:00+08:00`);
  until.setUTCDate(until.getUTCDate() + 1);
  return { from, until };
}

export async function generateLeaderboard(
  gameCode: string,
  type: BoardType,
  period: Period,
) {
  const [config, settings] = await Promise.all([
    getGameConfig(gameCode, 'leaderboard', DEFAULT_CONFIG),
    getGameSettings(gameCode),
  ]);
  if (!config.enabledTypes.includes(type)) {
    throw new Error('LEADERBOARD_TYPE_DISABLED');
  }
  const bounds = periodBounds(period);
  let scores = new Map<string, bigint>();

  if (type === 'points') {
    const { from, until } = timestampBounds(bounds.start, bounds.end);
    const rows = await prisma.settlement.findMany({
      where: {
        outcome: settings.rebate.includeTieBets
          ? { not: 'VOID' }
          : { notIn: ['VOID', 'TIE'] },
        round: {
          room: { gameCode },
          settledAt: { gte: from, lt: until },
        },
      },
      select: {
        userId: true,
        betCents: true,
        round: { select: { bankerId: true } },
      },
    });
    for (const row of rows) {
      scores.set(
        row.userId,
        (scores.get(row.userId) ?? 0n) + row.betCents,
      );
      if (row.round.bankerId) {
        scores.set(
          row.round.bankerId,
          (scores.get(row.round.bankerId) ?? 0n) + row.betCents,
        );
      }
    }
  } else if (type === 'hands') {
    const rows = await prisma.dailyHandProgress.findMany({
      where: {
        gameCode,
        date: { gte: bounds.start, lte: bounds.end },
      },
    });
    for (const row of rows) {
      const counts = row.counts as Record<string, number>;
      const score = ['BAOZI', 'MANNIU', 'FANSHUN', 'SHUNZI', 'DUIZI', 'JINNIU'].reduce(
        (sum, hand) => sum + (counts[hand] ?? 0),
        0,
      );
      scores.set(row.userId, (scores.get(row.userId) ?? 0n) + BigInt(score));
    }
  } else {
    const { from, until } = timestampBounds(bounds.start, bounds.end);
    const rounds = await prisma.round.findMany({
      where: {
        phase: 'FINISHED',
        room: { gameCode },
        bankerId: { not: null },
        settledAt: { gte: from, lt: until },
      },
      select: { bankerId: true },
    });
    for (const round of rounds) {
      if (round.bankerId) scores.set(round.bankerId, (scores.get(round.bankerId) ?? 0n) + 1n);
    }
  }

  const virtualIds = await prisma.user.findMany({
    where: { kind: 'VIRTUAL', id: { in: [...scores.keys()] } },
    select: { id: true },
  });
  for (const row of virtualIds) scores.delete(row.id);

  const sorted = [...scores.entries()]
    .sort((left, right) => (left[1] === right[1] ? 0 : left[1] > right[1] ? -1 : 1))
    .slice(0, config.topN);
  const users = await prisma.user.findMany({
    where: { id: { in: sorted.map(([userId]) => userId) }, kind: 'HUMAN' },
    select: { id: true, uid: true, nickname: true, avatarUrl: true },
  });
  const userMap = new Map(users.map((user) => [user.id, user]));
  const snapshot = sorted.map(([userId, score], index) => {
    const user = userMap.get(userId);
    return {
      rank: index + 1,
      userId, // 仅后台使用（榜单奖励发放）；用户端接口会剔除
      uid: user ? `${user.uid.slice(0, 3)}****${user.uid.slice(-3)}` : '—',
      nickname: config.maskNames ? maskName(user?.nickname ?? null) : user?.nickname ?? '玩家',
      avatarUrl: user?.avatarUrl ?? null,
      score: String(score),
    };
  });
  return prisma.leaderboard.upsert({
    where: {
      gameCode_type_period_periodKey: {
        gameCode,
        type,
        period,
        periodKey: bounds.key,
      },
    },
    create: {
      gameCode,
      type,
      period,
      periodKey: bounds.key,
      rankSnapshot: snapshot as Prisma.InputJsonValue,
    },
    update: {
      rankSnapshot: snapshot as Prisma.InputJsonValue,
      generatedAt: new Date(),
    },
  });
}

export async function generateAllLeaderboards(gameCode: string) {
  const config = await getGameConfig(
    gameCode,
    'leaderboard',
    DEFAULT_CONFIG,
  );
  const results = [];
  for (const period of ['daily', 'weekly', 'monthly'] as const) {
    for (const type of config.enabledTypes) {
      results.push(await generateLeaderboard(gameCode, type, period));
    }
  }
  return results;
}

export async function leaderboardDashboard(
  gameCode: string,
  period: Period = 'daily',
  includeUserIds = false,
) {
  const bounds = periodBounds(period);
  const config = await getGameConfig(
    gameCode,
    'leaderboard',
    DEFAULT_CONFIG,
  );
  const existing = await prisma.leaderboard.findMany({
    where: { gameCode, period, periodKey: bounds.key },
  });
  const boards = new Map(
    existing
      .filter((board) => config.enabledTypes.includes(board.type as BoardType))
      .map((board) => [board.type, board]),
  );
  for (const type of config.enabledTypes) {
    if (!boards.has(type)) {
      boards.set(type, await generateLeaderboard(gameCode, type, period));
    }
  }
  const rankedUserIds = [
    ...new Set(
      [...boards.values()].flatMap((board) =>
        Array.isArray(board.rankSnapshot)
          ? board.rankSnapshot
              .map((row) => (row as { userId?: unknown }).userId)
              .filter((userId): userId is string => typeof userId === 'string')
          : [],
      ),
    ),
  ];
  const currentUsers = rankedUserIds.length
    ? await prisma.user.findMany({
        where: { id: { in: rankedUserIds } },
        select: { id: true, avatarUrl: true },
      })
    : [];
  const currentAvatars = new Map(currentUsers.map((user) => [user.id, user.avatarUrl]));
  const sanitize = (snapshot: Prisma.JsonValue) => {
    if (Array.isArray(snapshot)) {
      return snapshot.map((row) => {
        const { userId, ...rest } = row as Record<string, unknown>;
        const hydrated = {
          ...rest,
          avatarUrl:
            typeof userId === 'string'
              ? currentAvatars.get(userId) ?? null
              : (rest.avatarUrl ?? null),
        };
        return includeUserIds ? { userId, ...hydrated } : hydrated;
      });
    }
    return snapshot;
  };
  return {
    gameCode,
    period,
    periodKey: bounds.key,
    enabledTypes: config.enabledTypes,
    labels: config.labels,
    boards: Object.fromEntries(
      [...boards.entries()].map(([type, board]) => [
        type,
        { generatedAt: board.generatedAt, ranks: sanitize(board.rankSnapshot) },
      ]),
    ),
  };
}

/** 榜单奖励一键发放：按当前快照名次发放到用户可用余额（幂等） */
export async function distributeLeaderboardRewards(params: {
  gameCode: string;
  type: BoardType;
  period: Period;
  prizes: Array<{ rank: number; amountCents: bigint }>;
  operatorId: string;
}) {
  const bounds = periodBounds(params.period);
  const config = await getGameConfig(
    params.gameCode,
    'leaderboard',
    DEFAULT_CONFIG,
  );
  if (!config.enabledTypes.includes(params.type)) {
    throw new Error('LEADERBOARD_TYPE_DISABLED');
  }
  const board = await prisma.leaderboard.findUnique({
    where: {
      gameCode_type_period_periodKey: {
        gameCode: params.gameCode,
        type: params.type,
        period: params.period,
        periodKey: bounds.key,
      },
    },
  });
  if (!board) throw new Error('LEADERBOARD_NOT_GENERATED');
  const ranks = board.rankSnapshot as Array<{ rank: number; userId?: string }>;
  const results: Array<{ rank: number; userId: string; amountCents: string; granted: boolean }> = [];
  for (const prize of params.prizes) {
    const row = ranks.find((item) => item.rank === prize.rank);
    if (!row?.userId || prize.amountCents <= 0n) continue;
    const idempotencyKey = `lb-reward:${params.gameCode}:${params.type}:${params.period}:${bounds.key}:rank${prize.rank}`;
    const existing = await prisma.ledgerEntry.findUnique({
      where: { idempotencyKey: `${idempotencyKey}:in` },
    });
    if (existing) {
      results.push({
        rank: prize.rank,
        userId: row.userId,
        amountCents: String(prize.amountCents),
        granted: false,
      });
      continue;
    }
    await serializable(async (tx) => {
      await transfer(tx, {
        amountCents: prize.amountCents,
        from: { accountType: AccountType.PLATFORM_REWARD },
        to: { userId: row.userId!, accountType: AccountType.USER_AVAILABLE },
        refType: 'leaderboard_reward',
        refId: `${params.gameCode}:${params.type}:${params.period}:${bounds.key}:rank${prize.rank}`,
        idempotencyKey,
        operatorId: params.operatorId,
        memo: `${params.gameCode} ${params.type} ${params.period} ${bounds.key} 第${prize.rank}名奖励`,
      });
    });
    results.push({
      rank: prize.rank,
      userId: row.userId,
      amountCents: String(prize.amountCents),
      granted: true,
    });
  }
  return { gameCode: params.gameCode, periodKey: bounds.key, results };
}
