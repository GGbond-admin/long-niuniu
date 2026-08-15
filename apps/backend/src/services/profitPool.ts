/**
 * 利润池与称桶分配 — 对应《利润池与称桶分配模式说明文档》/《07-利润池与称桶分配》
 *
 * 链路：游戏抽水（玩家赢 3% / 庄家赢 5%，实收入账 PLATFORM_RAKE）
 *   → 当日毛利润 = 实收抽水合计
 *   → 公司支出 = 公司总流水 × 支出比例（默认 2.5%）
 *   → 净利润池 = 毛利润 − 支出 + 前日负结转
 *   → 代理所得 = 净池 × (代理流水 ÷ 公司总流水) × (占成点数 ÷ 称桶基准 130)
 *
 * 口径说明（与推广返水一致）：
 * - 「流水」= 有效下注（闲家计自身注、庄家计对赌闲注，平局按返水配置剔除，虚拟玩家不计）；
 * - 「公司总流水」= 当日全体用户 TurnoverDaily.selfCents 合计，代理贡献比恒 ≤ 100%；
 * - 净池 ≤ 0 当日不分配，负额结转次日；余数（未分满部分）归公司留存。
 */
import { AccountType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { serializable } from '../lib/transaction.js';
import { PLATFORM_CONFIG_SCOPE, getGameConfig, setGameConfig } from './gameConfig.js';
import { pushService } from './push.js';
import { malaysiaDay } from './rebates.js';
import { transfer } from './wallet.js';

export interface ProfitPoolConfig {
  /** 公司支出比例（相对公司总流水），默认 2.5% */
  expenseRatio: number;
  /** 称桶基准，默认 130；实得比例 = 占成点数 ÷ 基准 */
  bucketBase: number;
  /** 是否随后台任务自动结算前一日 */
  autoSettle: boolean;
  /** 占成点数预设（后台快捷选择） */
  tierPresets: Array<{ label: string; points: number }>;
}

export const DEFAULT_PROFIT_POOL_CONFIG: ProfitPoolConfig = {
  expenseRatio: 0.025,
  bucketBase: 130,
  autoSettle: true,
  tierPresets: [
    { label: '普通代理', points: 50 },
    { label: '高级代理', points: 60 },
    { label: '核心代理', points: 65 },
    { label: '股东', points: 70 },
  ],
};

export async function getProfitPoolConfig(): Promise<ProfitPoolConfig> {
  return getGameConfig(
    PLATFORM_CONFIG_SCOPE,
    'profitPool',
    DEFAULT_PROFIT_POOL_CONFIG,
  );
}

export async function setProfitPoolConfig(
  patch: Partial<ProfitPoolConfig>,
  updatedBy?: string,
): Promise<ProfitPoolConfig> {
  const current = await getProfitPoolConfig();
  const next: ProfitPoolConfig = {
    ...current,
    ...patch,
    tierPresets: patch.tierPresets ?? current.tierPresets,
  };
  if (!(next.expenseRatio >= 0 && next.expenseRatio <= 1)) {
    throw new ProfitPoolError('INVALID_EXPENSE_RATIO');
  }
  if (!Number.isInteger(next.bucketBase) || next.bucketBase < 1 || next.bucketBase > 10_000) {
    throw new ProfitPoolError('INVALID_BUCKET_BASE');
  }
  await setGameConfig(PLATFORM_CONFIG_SCOPE, 'profitPool', next, updatedBy);
  return next;
}

export class ProfitPoolError extends Error {
  constructor(
    public code: string,
    public details?: Record<string, unknown>,
  ) {
    super(code);
  }
}

/** YYYY-MM-DD → 马来西亚该日 [00:00, 次日00:00) 的 UTC 窗口 */
export function malaysiaDayWindow(date: string): { gte: Date; lt: Date } {
  const from = new Date(`${date}T00:00:00+08:00`);
  if (Number.isNaN(from.getTime())) throw new ProfitPoolError('INVALID_DATE');
  return { gte: from, lt: new Date(from.getTime() + 86_400_000) };
}

export function previousDay(date: string): string {
  const window = malaysiaDayWindow(date);
  return new Date(window.gte.getTime() - 43_200_000).toLocaleDateString('sv-SE', {
    timeZone: 'Asia/Kuala_Lumpur',
  });
}

/** 称桶公式：净池 × (代理流水 ÷ 公司流水) × (点数 ÷ 基准)，分为单位向下取整 */
export function bucketShareCents(params: {
  netPoolCents: bigint;
  agentTurnoverCents: bigint;
  companyTurnoverCents: bigint;
  sharePoints: number;
  bucketBase: number;
}): bigint {
  const { netPoolCents, agentTurnoverCents, companyTurnoverCents, sharePoints, bucketBase } =
    params;
  if (
    netPoolCents <= 0n ||
    agentTurnoverCents <= 0n ||
    companyTurnoverCents <= 0n ||
    sharePoints <= 0 ||
    bucketBase <= 0
  ) {
    return 0n;
  }
  return (
    (netPoolCents * agentTurnoverCents * BigInt(sharePoints)) /
    (companyTurnoverCents * BigInt(bucketBase))
  );
}

export interface AgentComputation {
  agentId: string;
  label: string;
  status: string;
  userId: string;
  uid: string;
  nickname: string | null;
  sharePoints: number;
  playerCount: number;
  turnoverCents: bigint;
  /** 贡献比（万分比整数，前端换算展示） */
  contributionBp: number;
  amountCents: bigint;
}

export interface PoolComputation {
  date: string;
  rakePlayerCents: bigint;
  rakeBankerCents: bigint;
  rakeTotalCents: bigint;
  turnoverCents: bigint;
  expenseRatio: number;
  expenseCents: bigint;
  carryInCents: bigint;
  netPoolCents: bigint;
  bucketBase: number;
  distributableCents: bigint;
  distributedCents: bigint;
  residualCents: bigint;
  carryOutCents: bigint;
  agents: AgentComputation[];
  settled: boolean;
}

/** 支出 = 流水 × 比例（分为单位四舍五入，与返水佣金同口径） */
export function expenseOf(turnoverCents: bigint, expenseRatio: number): bigint {
  const millionths = BigInt(Math.round(expenseRatio * 1_000_000));
  return (turnoverCents * millionths + 500_000n) / 1_000_000n;
}

/**
 * 计算某日利润池全貌（不落库）。
 * 已结算日：直接回放 ProfitPoolDaily + 分配明细，保证展示与账一致；
 * 未结算日（含当天）：按当前配置实时估算。
 */
export async function computeProfitPool(date: string): Promise<PoolComputation> {
  const existing = await prisma.profitPoolDaily.findUnique({
    where: { date },
    include: {
      shares: {
        include: {
          agent: {
            include: {
              user: { select: { uid: true, nickname: true } },
              _count: { select: { players: true } },
            },
          },
        },
      },
    },
  });
  if (existing) {
    return {
      date,
      rakePlayerCents: existing.rakePlayerCents,
      rakeBankerCents: existing.rakeBankerCents,
      rakeTotalCents: existing.rakeTotalCents,
      turnoverCents: existing.turnoverCents,
      expenseRatio: existing.expenseRatioSnapshot,
      expenseCents: existing.expenseCents,
      carryInCents: existing.carryInCents,
      netPoolCents: existing.netPoolCents,
      bucketBase: existing.bucketBaseSnapshot,
      distributableCents: existing.netPoolCents > 0n ? existing.netPoolCents : 0n,
      distributedCents: existing.distributedCents,
      residualCents: existing.residualCents,
      carryOutCents: existing.carryOutCents,
      agents: existing.shares.map((share) => ({
        agentId: share.agentId,
        label: share.agent.label,
        status: share.agent.status,
        userId: share.agent.userId,
        uid: share.agent.user.uid,
        nickname: share.agent.user.nickname,
        sharePoints: share.sharePointsSnapshot,
        playerCount: share.agent._count.players,
        turnoverCents: share.turnoverCents,
        contributionBp:
          share.companyTurnoverCents > 0n
            ? Number((share.turnoverCents * 10_000n) / share.companyTurnoverCents)
            : 0,
        amountCents: share.amountCents,
      })),
      settled: true,
    };
  }

  const config = await getProfitPoolConfig();
  const window = malaysiaDayWindow(date);
  const [playerRake, bankerRake, turnover, previousPool, agents] = await Promise.all([
    prisma.settlement.aggregate({
      where: { createdAt: window, outcome: 'PLAYER_WIN' },
      _sum: { rakeCents: true },
    }),
    prisma.settlement.aggregate({
      where: { createdAt: window, outcome: 'BANKER_WIN' },
      _sum: { rakeCents: true },
    }),
    prisma.turnoverDaily.aggregate({
      where: { date },
      _sum: { selfCents: true },
    }),
    prisma.profitPoolDaily.findUnique({ where: { date: previousDay(date) } }),
    prisma.agent.findMany({
      include: {
        user: { select: { uid: true, nickname: true } },
        players: { select: { userId: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const rakePlayerCents = playerRake._sum.rakeCents ?? 0n;
  const rakeBankerCents = bankerRake._sum.rakeCents ?? 0n;
  const rakeTotalCents = rakePlayerCents + rakeBankerCents;
  const turnoverCents = turnover._sum.selfCents ?? 0n;
  const expenseCents = expenseOf(turnoverCents, config.expenseRatio);
  const carryInCents = previousPool && previousPool.carryOutCents < 0n
    ? previousPool.carryOutCents
    : 0n;
  const netPoolCents = rakeTotalCents - expenseCents + carryInCents;

  const boundUserIds = agents.flatMap((agent) => agent.players.map((p) => p.userId));
  const turnoverRows = boundUserIds.length
    ? await prisma.turnoverDaily.findMany({
        where: { date, userId: { in: boundUserIds } },
        select: { userId: true, selfCents: true },
      })
    : [];
  const turnoverByUser = new Map<string, bigint>();
  for (const row of turnoverRows) {
    turnoverByUser.set(row.userId, (turnoverByUser.get(row.userId) ?? 0n) + row.selfCents);
  }

  let distributed = 0n;
  const agentRows: AgentComputation[] = agents.map((agent) => {
    const agentTurnover = agent.players.reduce(
      (sum, player) => sum + (turnoverByUser.get(player.userId) ?? 0n),
      0n,
    );
    const eligible = agent.status === 'ACTIVE';
    const amount = eligible
      ? bucketShareCents({
          netPoolCents,
          agentTurnoverCents: agentTurnover,
          companyTurnoverCents: turnoverCents,
          sharePoints: agent.sharePoints,
          bucketBase: config.bucketBase,
        })
      : 0n;
    distributed += amount;
    return {
      agentId: agent.id,
      label: agent.label,
      status: agent.status,
      userId: agent.userId,
      uid: agent.user.uid,
      nickname: agent.user.nickname,
      sharePoints: agent.sharePoints,
      playerCount: agent.players.length,
      turnoverCents: agentTurnover,
      contributionBp:
        turnoverCents > 0n ? Number((agentTurnover * 10_000n) / turnoverCents) : 0,
      amountCents: amount,
    };
  });

  const distributable = netPoolCents > 0n ? netPoolCents : 0n;
  return {
    date,
    rakePlayerCents,
    rakeBankerCents,
    rakeTotalCents,
    turnoverCents,
    expenseRatio: config.expenseRatio,
    expenseCents,
    carryInCents,
    netPoolCents,
    bucketBase: config.bucketBase,
    distributableCents: distributable,
    distributedCents: distributed,
    residualCents: distributable - distributed,
    carryOutCents: netPoolCents <= 0n ? netPoolCents : 0n,
    agents: agentRows,
    settled: false,
  };
}

/**
 * 结算某日利润池：写入池记录与代理分配明细，并把分成转入代理用户可用余额。
 * 幂等：ProfitPoolDaily.date 唯一；转账幂等键 profit-share:{date}:{agentId}。
 * 只允许结算已结束的马来日（date < 今天）。
 */
export async function settleProfitPool(date: string, actorId?: string) {
  if (date >= malaysiaDay()) throw new ProfitPoolError('DATE_NOT_CLOSED');
  const computation = await computeProfitPool(date);
  if (computation.settled) return null;

  const payable = computation.agents.filter((agent) => agent.amountCents > 0n);
  const result = await serializable(async (tx) => {
    const existing = await tx.profitPoolDaily.findUnique({ where: { date } });
    if (existing) return null;
    const pool = await tx.profitPoolDaily.create({
      data: {
        date,
        rakePlayerCents: computation.rakePlayerCents,
        rakeBankerCents: computation.rakeBankerCents,
        rakeTotalCents: computation.rakeTotalCents,
        turnoverCents: computation.turnoverCents,
        expenseRatioSnapshot: computation.expenseRatio,
        expenseCents: computation.expenseCents,
        carryInCents: computation.carryInCents,
        netPoolCents: computation.netPoolCents,
        distributedCents: computation.distributedCents,
        residualCents: computation.residualCents,
        carryOutCents: computation.carryOutCents,
        bucketBaseSnapshot: computation.bucketBase,
        status: computation.netPoolCents > 0n ? 'SETTLED' : 'NO_DISTRIBUTION',
        settledBy: actorId ?? 'SYSTEM',
      },
    });
    for (const agent of payable) {
      const ledgerRef = `profit-share:${date}:${agent.agentId}`;
      await tx.agentProfitShare.create({
        data: {
          poolId: pool.id,
          agentId: agent.agentId,
          date,
          turnoverCents: agent.turnoverCents,
          companyTurnoverCents: computation.turnoverCents,
          sharePointsSnapshot: agent.sharePoints,
          bucketBaseSnapshot: computation.bucketBase,
          amountCents: agent.amountCents,
          ledgerRef,
        },
      });
      await transfer(tx, {
        amountCents: agent.amountCents,
        from: { accountType: AccountType.PLATFORM_PROFIT_POOL },
        to: { userId: agent.userId, accountType: AccountType.USER_AVAILABLE },
        refType: 'profit_share',
        refId: agent.agentId,
        idempotencyKey: ledgerRef,
        operatorId: actorId,
      });
    }
    return pool;
  });

  if (result) {
    for (const agent of payable) {
      const amount = `${agent.amountCents / 100n}.${(agent.amountCents % 100n)
        .toString()
        .padStart(2, '0')}`;
      void pushService.sendCustom(
        agent.userId,
        `💼 ${date} 称桶分成已结算\n占成 ${agent.sharePoints}/${computation.bucketBase}，分成 RM${amount} 已发放到可用余额。`,
      );
    }
  }
  return result;
}

/** 后台任务入口：自动结算前一马来日（配置可关） */
export async function autoSettleProfitPool(date: string) {
  const config = await getProfitPoolConfig();
  if (!config.autoSettle) return null;
  try {
    return await settleProfitPool(date);
  } catch (error) {
    if (error instanceof ProfitPoolError) return null;
    throw error;
  }
}

/** 近 N 日趋势（含未结算日的实时估算），供后台图表 */
export async function profitPoolTrend(days: number, endDate = malaysiaDay()) {
  const dates: string[] = [];
  let cursor = endDate;
  for (let i = 0; i < days; i += 1) {
    dates.push(cursor);
    cursor = previousDay(cursor);
  }
  dates.reverse();
  const settledRows = await prisma.profitPoolDaily.findMany({
    where: { date: { in: dates } },
  });
  const settledByDate = new Map(settledRows.map((row) => [row.date, row]));
  const trend = [] as Array<{
    date: string;
    settled: boolean;
    rakeTotalCents: string;
    turnoverCents: string;
    expenseCents: string;
    netPoolCents: string;
    distributedCents: string;
  }>;
  for (const day of dates) {
    const settledRow = settledByDate.get(day);
    if (settledRow) {
      trend.push({
        date: day,
        settled: true,
        rakeTotalCents: String(settledRow.rakeTotalCents),
        turnoverCents: String(settledRow.turnoverCents),
        expenseCents: String(settledRow.expenseCents),
        netPoolCents: String(settledRow.netPoolCents),
        distributedCents: String(settledRow.distributedCents),
      });
      continue;
    }
    const estimate = await computeProfitPool(day);
    trend.push({
      date: day,
      settled: false,
      rakeTotalCents: String(estimate.rakeTotalCents),
      turnoverCents: String(estimate.turnoverCents),
      expenseCents: String(estimate.expenseCents),
      netPoolCents: String(estimate.netPoolCents),
      distributedCents: String(estimate.distributedCents),
    });
  }
  return trend;
}

const AGENT_INCLUDE = {
  user: { select: { uid: true, nickname: true, avatarUrl: true } },
  _count: { select: { players: true } },
} satisfies Prisma.AgentInclude;

export async function listAgents() {
  return prisma.agent.findMany({
    include: AGENT_INCLUDE,
    orderBy: { createdAt: 'asc' },
  });
}

export async function createAgent(params: {
  uid: string;
  label: string;
  sharePoints: number;
  actorId?: string;
}) {
  const config = await getProfitPoolConfig();
  assertSharePoints(params.sharePoints, config.bucketBase);
  const user = await prisma.user.findUnique({ where: { uid: params.uid } });
  if (!user) throw new ProfitPoolError('USER_NOT_FOUND');
  if (user.kind === 'VIRTUAL') throw new ProfitPoolError('VIRTUAL_NOT_ALLOWED');
  const existing = await prisma.agent.findUnique({ where: { userId: user.id } });
  if (existing) throw new ProfitPoolError('AGENT_ALREADY_EXISTS');
  return prisma.agent.create({
    data: {
      userId: user.id,
      label: params.label.trim() || `代理-${user.uid}`,
      sharePoints: params.sharePoints,
    },
    include: AGENT_INCLUDE,
  });
}

export async function updateAgent(params: {
  agentId: string;
  label?: string;
  sharePoints?: number;
  status?: 'ACTIVE' | 'DISABLED';
}) {
  if (params.sharePoints !== undefined) {
    const config = await getProfitPoolConfig();
    assertSharePoints(params.sharePoints, config.bucketBase);
  }
  const agent = await prisma.agent.findUnique({ where: { id: params.agentId } });
  if (!agent) throw new ProfitPoolError('AGENT_NOT_FOUND');
  return prisma.agent.update({
    where: { id: params.agentId },
    data: {
      label: params.label?.trim() || undefined,
      sharePoints: params.sharePoints,
      status: params.status,
    },
    include: AGENT_INCLUDE,
  });
}

function assertSharePoints(points: number, bucketBase: number) {
  if (!Number.isInteger(points) || points < 0 || points > bucketBase) {
    throw new ProfitPoolError('INVALID_SHARE_POINTS', { bucketBase });
  }
}

export async function bindAgentPlayer(params: {
  agentId: string;
  uid: string;
  actorId?: string;
}) {
  const agent = await prisma.agent.findUnique({ where: { id: params.agentId } });
  if (!agent) throw new ProfitPoolError('AGENT_NOT_FOUND');
  const user = await prisma.user.findUnique({ where: { uid: params.uid } });
  if (!user) throw new ProfitPoolError('USER_NOT_FOUND');
  if (user.kind === 'VIRTUAL') throw new ProfitPoolError('VIRTUAL_NOT_ALLOWED');
  const existing = await prisma.agentPlayer.findUnique({ where: { userId: user.id } });
  if (existing) {
    if (existing.agentId === params.agentId) return existing;
    throw new ProfitPoolError('PLAYER_ALREADY_BOUND');
  }
  return prisma.agentPlayer.create({
    data: { agentId: params.agentId, userId: user.id, boundBy: params.actorId },
  });
}

export async function unbindAgentPlayer(agentId: string, userId: string) {
  const deleted = await prisma.agentPlayer.deleteMany({
    where: { agentId, userId },
  });
  if (deleted.count === 0) throw new ProfitPoolError('BINDING_NOT_FOUND');
}

export async function listAgentPlayers(agentId: string) {
  return prisma.agentPlayer.findMany({
    where: { agentId },
    include: {
      user: { select: { uid: true, nickname: true, avatarUrl: true } },
    },
    orderBy: { boundAt: 'desc' },
  });
}
