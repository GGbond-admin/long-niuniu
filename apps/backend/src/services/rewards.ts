import { AccountType, Prisma, RewardTab } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { serializable } from '../lib/transaction.js';
import { gameBus } from './gameBus.js';
import { pushService } from './push.js';
import { transfer } from './wallet.js';
import { SUPPORTED_GAME_CODES } from './gameCatalog.js';

const DEFAULT_REWARDS: Array<{
  tab: RewardTab;
  code: string;
  title: string;
  conditions: Prisma.InputJsonValue;
  amountCents: bigint;
  dailyQuota: number;
}> = [
  {
    tab: 'CHESS',
    code: 'weird_hand',
    title: '怪牌奖励',
    conditions: {
      kind: 'hand_combo',
      required: { BAOZI: 1, SHUNZI: 1, FANSHUN: 1, MANNIU: 1 },
    },
    amountCents: 38_888n,
    dailyQuota: 3,
  },
  {
    tab: 'CHESS',
    code: 'baozi_king',
    title: '豹子王',
    conditions: { kind: 'hand_count', handType: 'BAOZI', count: 3 },
    amountCents: 28_888n,
    dailyQuota: 3,
  },
  {
    tab: 'CHESS',
    code: 'manniu_king',
    title: '满牛王',
    conditions: { kind: 'hand_count', handType: 'MANNIU', count: 3 },
    amountCents: 28_888n,
    dailyQuota: 3,
  },
  {
    tab: 'CHESS',
    code: 'shunzi_king',
    title: '顺子王',
    conditions: { kind: 'hand_count', handType: 'SHUNZI', count: 3 },
    amountCents: 18_888n,
    dailyQuota: 3,
  },
  {
    tab: 'CHESS',
    code: 'fanshun_king',
    title: '反顺王',
    conditions: { kind: 'hand_count', handType: 'FANSHUN', count: 3 },
    amountCents: 18_888n,
    dailyQuota: 3,
  },
  ...[
    [18, 28_800],
    [28, 38_800],
    [58, 88_800],
    [88, 138_800],
    [108, 188_800],
  ].map(([count, amount]) => ({
    tab: RewardTab.BANKER,
    code: `banker_ladder_${count}`,
    title: `做庄 ${count} 次奖励`,
    conditions: { kind: 'banker_rounds', count },
    amountCents: BigInt(amount),
    dailyQuota: 0,
  })),
  {
    tab: 'BANKER',
    code: 'banker_instant',
    title: '庄家秒杀奖励',
    conditions: { kind: 'banker_instant', count: 3, amountCents: 1 },
    amountCents: 58_800n,
    dailyQuota: 1,
  },
];

function malaysiaDay(date = new Date()): string {
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kuala_Lumpur' });
}

export async function ensureRewardDefaults() {
  for (const gameCode of SUPPORTED_GAME_CODES) {
    for (const reward of DEFAULT_REWARDS) {
      await prisma.rewardConfig.upsert({
        where: { gameCode_code: { gameCode, code: reward.code } },
        create: { ...reward, gameCode },
        update: {},
      });
    }
  }
}

function conditionMet(conditions: Prisma.JsonValue, counts: Record<string, number>): boolean {
  if (!conditions || typeof conditions !== 'object' || Array.isArray(conditions)) return false;
  const condition = conditions as Record<string, unknown>;
  if (condition.kind === 'hand_count') {
    return (counts[String(condition.handType)] ?? 0) >= Number(condition.count ?? 0);
  }
  if (condition.kind === 'hand_combo') {
    const required = condition.required;
    if (!required || typeof required !== 'object' || Array.isArray(required)) return false;
    return Object.entries(required as Record<string, unknown>).every(
      ([hand, count]) => (counts[hand] ?? 0) >= Number(count),
    );
  }
  if (condition.kind === 'banker_rounds') {
    return (counts.BANKER_ROUNDS ?? 0) >= Number(condition.count ?? 0);
  }
  if (condition.kind === 'banker_instant') {
    return (counts.BANKER_INSTANT ?? 0) >= Number(condition.count ?? 0);
  }
  return false;
}

export async function grantReward(
  configId: string,
  userId: string,
  date = malaysiaDay(),
  operatorId?: string,
) {
  const granted = await serializable(async (tx) => {
    const config = await tx.rewardConfig.findUnique({ where: { id: configId } });
    if (!config || config.status !== 'ACTIVE') return null;
    const existing = await tx.rewardGrant.findUnique({
      where: { configId_userId_date: { configId, userId, date } },
    });
    if (existing) return null;
    if (config.dailyQuota > 0) {
      const used = await tx.rewardGrant.count({ where: { configId, date } });
      if (used >= config.dailyQuota) return null;
    }
    const grant = await tx.rewardGrant.create({
      data: {
        configId,
        userId,
        date,
        amountCents: config.amountCents,
      },
    });
    await transfer(tx, {
      amountCents: config.amountCents,
      from: { accountType: AccountType.PLATFORM_REWARD },
      to: { userId, accountType: AccountType.USER_AVAILABLE },
      refType: 'reward',
      refId: grant.id,
      idempotencyKey: `reward:${grant.id}`,
      operatorId,
    });
    await tx.rewardGrant.update({
      where: { id: grant.id },
      data: { ledgerRef: `reward:${grant.id}` },
    });
    return { grant, config };
  });
  if (granted) {
    const amount = `${granted.config.amountCents / 100n}.${(granted.config.amountCents % 100n)
      .toString()
      .padStart(2, '0')}`;
    void pushService
      .notifyRewardGranted(userId, granted.config.title, amount)
      .catch(() => undefined);
    gameBus.rewardGranted({
      userId,
      title: granted.config.title,
      amountCents: String(granted.config.amountCents),
    });
  }
  return granted;
}

export async function processRoundRewards(roundId: string) {
  const round = await prisma.round.findUnique({
    where: { id: roundId },
    include: { bets: true, room: { select: { gameCode: true } } },
  });
  if (!round || round.phase !== 'FINISHED' || !round.bankerId) return [];
  const date = malaysiaDay(round.settledAt ?? new Date());
  const userIds = [...new Set([...round.bets.map((bet) => bet.userId), round.bankerId])];
  const [configs, progressRows] = await Promise.all([
    prisma.rewardConfig.findMany({
      where: { gameCode: round.room.gameCode, status: 'ACTIVE' },
    }),
    prisma.dailyHandProgress.findMany({
      where: {
        gameCode: round.room.gameCode,
        userId: { in: userIds },
        date,
      },
    }),
  ]);
  const progress = new Map(
    progressRows.map((row) => [row.userId, row.counts as Record<string, number>]),
  );
  const results = [];
  for (const userId of userIds) {
    const counts = progress.get(userId) ?? {};
    for (const config of configs) {
      if (conditionMet(config.conditions, counts)) {
        const result = await grantReward(config.id, userId, date);
        if (result) results.push(result.grant);
      }
    }
  }
  const marker = await prisma.roundEvent.findFirst({
    where: { roundId, type: 'ROUND_REWARDS_PROCESSED' },
    select: { id: true },
  });
  if (!marker) {
    await prisma.roundEvent.create({
      data: {
        roundId,
        type: 'ROUND_REWARDS_PROCESSED',
        payload: { processedAt: new Date().toISOString() },
        actorId: 'SYSTEM',
      },
    });
  }
  return results;
}

/** 结算成功但奖励后处理失败时补偿；grantReward 按用户、规则和业务日幂等。 */
export async function retryPendingRoundRewards(
  now = new Date(),
  limit = 50,
): Promise<number> {
  const rounds = await prisma.round.findMany({
    where: {
      phase: 'FINISHED',
      settledAt: { gte: new Date(now.getTime() - 7 * 24 * 60 * 60_000) },
      events: { none: { type: 'ROUND_REWARDS_PROCESSED' } },
    },
    select: { id: true },
    orderBy: { settledAt: 'asc' },
    take: limit,
  });
  let processed = 0;
  for (const round of rounds) {
    try {
      await processRoundRewards(round.id);
      processed += 1;
    } catch (error) {
      console.error('[rewards] retry round failed', round.id, error);
    }
  }
  return processed;
}

function maskNickname(value: string | null): string {
  if (!value) return '玩家***';
  if (value.length <= 1) return `${value}**`;
  return `${value[0]}${'*'.repeat(Math.min(3, value.length - 1))}`;
}

export async function rewardDashboard(
  gameCode: string,
  userId: string,
  date = malaysiaDay(),
) {
  const [configs, progress, grants, quotaCounts, todayWinners] = await Promise.all([
    prisma.rewardConfig.findMany({
      where: { gameCode, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.dailyHandProgress.findUnique({
      where: { gameCode_userId_date: { gameCode, userId, date } },
    }),
    prisma.rewardGrant.findMany({
      where: { userId, date, config: { gameCode } },
      include: { config: { select: { code: true, title: true, tab: true } } },
    }),
    prisma.rewardGrant.groupBy({
      by: ['configId'],
      where: { date, config: { gameCode } },
      _count: { _all: true },
    }),
    prisma.rewardGrant.findMany({
      where: { date, config: { gameCode } },
      include: {
        config: { select: { title: true, tab: true } },
        user: { select: { uid: true, nickname: true, avatarUrl: true } },
      },
      orderBy: { grantedAt: 'desc' },
      take: 50,
    }),
  ]);
  const used = new Map(quotaCounts.map((row) => [row.configId, row._count._all]));
  return {
    gameCode,
    date,
    winners: todayWinners.map((grant) => ({
      title: grant.config.title,
      tab: grant.config.tab,
      nickname: maskNickname(grant.user.nickname),
      uid: `${grant.user.uid.slice(0, 2)}****`,
      avatarUrl: grant.user.avatarUrl,
      amountCents: String(grant.amountCents),
      grantedAt: grant.grantedAt,
    })),
    counts: (progress?.counts as Record<string, number> | undefined) ?? {},
    items: configs.map((config) => ({
      id: config.id,
      tab: config.tab,
      code: config.code,
      title: config.title,
      conditions: config.conditions,
      amountCents: String(config.amountCents),
      dailyQuota: config.dailyQuota,
      remaining:
        config.dailyQuota === 0
          ? null
          : Math.max(0, config.dailyQuota - (used.get(config.id) ?? 0)),
      achieved: conditionMet(
        config.conditions,
        (progress?.counts as Record<string, number> | undefined) ?? {},
      ),
      granted: grants.some((grant) => grant.configId === config.id),
    })),
    grants,
  };
}
