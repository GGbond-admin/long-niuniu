/**
 * 利润池与称桶分配 — 对应《07-利润池与称桶分配》与
 * 《代理称桶制度与上下级分成机制说明文档》（2026-08-17 升级：代理树 + 占成差额制 + 两阶段结算）
 *
 * 链路：游戏抽水（闲家赢按该笔盈利 3% / 庄家按本局对赌毛利 5%，实收入账 PLATFORM_RAKE）
 *   → 当日毛利润 = 实收抽水合计
 *   → 公司支出 = 公司总流水 × 支出比例（默认 2.5%）
 *   → 净利润池 = 毛利润 − 支出 + 前日负结转
 *   → 占成差额制分配：
 *     自身利润 = 净池 × (直属玩家流水 ÷ 公司总流水) × (占成点数 ÷ 称桶基准 130)
 *     差额利润 = Σ 净池 × (直属下级团队流水 ÷ 公司总流水) × ((自身占成 − 下级占成) ÷ 基准)
 *   → 上级给下级设占成时必须至少预留 minReservePoints（默认 5）点差额。
 *
 * 当前正式结算由 profitPoolRange / profitPoolBatches 按“房间 + 连续局号区间”
 * 手动预览、生成并发放。下方 ProfitPoolDaily 代码仅用于保留旧日报、迁移待处理
 * 报表及复用称桶纯函数，不再由后台任务自动生成。
 *
 * 口径说明（与推广返水一致）：
 * - 「流水」= 有效下注（闲家计自身注、庄家计对赌闲注，平局按返水配置剔除，虚拟玩家不计）；
 * - 「自身流水」= 直属玩家流水 + 代理本人流水；「团队流水」= 自身流水 + 所有下级团队流水；
 * - 净池 ≤ 0 当日不分配（NO_DISTRIBUTION），负额结转次日；余数与停用代理份额归公司留存。
 */
import { AccountType, Prisma, UserStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { serializable } from '../lib/transaction.js';
import { bankerRakeCentsFromSummary } from '../engine/settlement.js';
import {
  PLATFORM_CONFIG_SCOPE,
  getGameConfig,
  getGameConfigInTransaction,
  setGameConfigInTransaction,
} from './gameConfig.js';
import { HOUSE_INVITER_NOTE } from './houseInviter.js';
import { pushService } from './push.js';
import { malaysiaDay } from './rebates.js';
import { transfer } from './wallet.js';

export interface ProfitPoolConfig {
  /** 公司支出比例（相对公司总流水），默认 2.5% */
  expenseRatio: number;
  /** 称桶基准，默认 130；实得比例 = 占成点数 ÷ 基准 */
  bucketBase: number;
  /** 上级给下级设占成时必须预留的最低点数差，默认 5 */
  minReservePoints: number;
  /** 是否随后台任务自动生成前一日报表（发放始终需后台确认） */
  autoSettle: boolean;
  /** 占成点数预设（后台快捷选择） */
  tierPresets: Array<{ label: string; points: number }>;
}

export const DEFAULT_PROFIT_POOL_CONFIG: ProfitPoolConfig = {
  expenseRatio: 0.025,
  bucketBase: 130,
  minReservePoints: 5,
  autoSettle: false,
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

async function lockProfitPoolStructure(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(784526190817::bigint)`;
}

export async function setProfitPoolConfig(
  patch: Partial<ProfitPoolConfig>,
  updatedBy?: string,
): Promise<ProfitPoolConfig> {
  return serializable(async (tx) => {
    await lockProfitPoolStructure(tx);
    const current = await getGameConfigInTransaction(
      tx,
      PLATFORM_CONFIG_SCOPE,
      'profitPool',
      DEFAULT_PROFIT_POOL_CONFIG,
    );
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
    if (
      !Number.isInteger(next.minReservePoints) ||
      next.minReservePoints < 0 ||
      next.minReservePoints > next.bucketBase
    ) {
      throw new ProfitPoolError('INVALID_MIN_RESERVE');
    }
    if (next.tierPresets.some((preset) => preset.points < 0 || preset.points > next.bucketBase)) {
      throw new ProfitPoolError('INVALID_TIER_PRESET_POINTS', {
        bucketBase: next.bucketBase,
      });
    }
    if (next.bucketBase !== current.bucketBase) {
      const incompatibleAgent = await tx.agent.findFirst({
        where: { sharePoints: { gt: next.bucketBase } },
        select: { id: true, sharePoints: true },
      });
      if (incompatibleAgent) {
        throw new ProfitPoolError('BUCKET_BASE_BELOW_EXISTING_AGENT_POINTS', {
          bucketBase: next.bucketBase,
          agentId: incompatibleAgent.id,
          sharePoints: incompatibleAgent.sharePoints,
        });
      }
    }
    if (next.minReservePoints !== current.minReservePoints) {
      const agentsWithParents = await tx.agent.findMany({
        where: { parentAgentId: { not: null } },
        select: {
          id: true,
          sharePoints: true,
          parent: { select: { id: true, sharePoints: true } },
        },
      });
      const incompatibleEdge = agentsWithParents.find(
        (agent) =>
          agent.parent
          && agent.parent.sharePoints - agent.sharePoints < next.minReservePoints,
      );
      if (incompatibleEdge?.parent) {
        throw new ProfitPoolError('MIN_RESERVE_BREAKS_EXISTING_TREE', {
          minReservePoints: next.minReservePoints,
          parentAgentId: incompatibleEdge.parent.id,
          parentSharePoints: incompatibleEdge.parent.sharePoints,
          childAgentId: incompatibleEdge.id,
          childSharePoints: incompatibleEdge.sharePoints,
        });
      }
    }
    await setGameConfigInTransaction(
      tx,
      PLATFORM_CONFIG_SCOPE,
      'profitPool',
      next,
      updatedBy,
    );
    return next;
  });
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

/** 称桶公式：净池 × (流水 ÷ 公司流水) × (点数 ÷ 基准)，分为单位向下取整 */
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

/** 差额明细：某个直属下级团队为上级贡献的占成差额利润 */
export interface SubagentBreakdown {
  agentId: string;
  label: string;
  uid: string;
  sharePoints: number;
  /** 上级占成 − 该下级占成（上级实得比例） */
  diffPoints: number;
  teamTurnoverCents: bigint;
  amountCents: bigint;
}

export interface AgentShareInput {
  agentId: string;
  parentAgentId: string | null;
  sharePoints: number;
  status: string;
  /** 自身流水 = 直属玩家 + 代理本人 */
  selfTurnoverCents: bigint;
  label?: string;
  uid?: string;
}

export interface AgentShareResult {
  teamTurnoverCents: bigint;
  selfAmountCents: bigint;
  overrideAmountCents: bigint;
  amountCents: bigint;
  breakdown: SubagentBreakdown[];
}

/**
 * 占成差额制核心计算（纯函数，可单测）：
 * - 团队流水自底向上聚合；
 * - 每个 ACTIVE 代理：自身利润（直属玩家流水 × 自身占成）+ 差额利润（下级团队流水 × 占成差）；
 * - DISABLED 代理不领取（份额归公司留存），但其团队流水照常向上聚合、上级照常按差额领取。
 */
export function computeAgentShares(params: {
  netPoolCents: bigint;
  companyTurnoverCents: bigint;
  bucketBase: number;
  agents: AgentShareInput[];
}): Map<string, AgentShareResult> {
  const { netPoolCents, companyTurnoverCents, bucketBase, agents } = params;
  if (!Number.isInteger(bucketBase) || bucketBase <= 0) {
    throw new ProfitPoolError('INVALID_BUCKET_BASE');
  }
  const invalidAgent = agents.find(
    (agent) =>
      !Number.isInteger(agent.sharePoints)
      || agent.sharePoints < 0
      || agent.sharePoints > bucketBase,
  );
  if (invalidAgent) {
    throw new ProfitPoolError('INVALID_SHARE_POINTS', {
      agentId: invalidAgent.agentId,
      sharePoints: invalidAgent.sharePoints,
      bucketBase,
    });
  }
  const byId = new Map(agents.map((agent) => [agent.agentId, agent]));
  const children = new Map<string, AgentShareInput[]>();
  for (const agent of agents) {
    if (agent.parentAgentId && byId.has(agent.parentAgentId)) {
      const list = children.get(agent.parentAgentId) ?? [];
      list.push(agent);
      children.set(agent.parentAgentId, list);
    }
  }

  // 团队流水：后序遍历聚合（迭代实现 + 访问保护，防御脏数据成环）
  const teamTurnover = new Map<string, bigint>();
  const computeTeam = (agentId: string, visiting: Set<string>): bigint => {
    const cached = teamTurnover.get(agentId);
    if (cached !== undefined) return cached;
    if (visiting.has(agentId)) return 0n;
    visiting.add(agentId);
    const agent = byId.get(agentId);
    if (!agent) return 0n;
    let total = agent.selfTurnoverCents;
    for (const child of children.get(agentId) ?? []) {
      total += computeTeam(child.agentId, visiting);
    }
    visiting.delete(agentId);
    teamTurnover.set(agentId, total);
    return total;
  };
  for (const agent of agents) computeTeam(agent.agentId, new Set());

  const results = new Map<string, AgentShareResult>();
  for (const agent of agents) {
    const selfAmount =
      agent.status === 'ACTIVE'
        ? bucketShareCents({
            netPoolCents,
            agentTurnoverCents: agent.selfTurnoverCents,
            companyTurnoverCents,
            sharePoints: agent.sharePoints,
            bucketBase,
          })
        : 0n;
    const breakdown: SubagentBreakdown[] = [];
    let overrideAmount = 0n;
    if (agent.status === 'ACTIVE') {
      for (const child of children.get(agent.agentId) ?? []) {
        const diffPoints = agent.sharePoints - child.sharePoints;
        const childTeam = teamTurnover.get(child.agentId) ?? 0n;
        const amount =
          diffPoints > 0
            ? bucketShareCents({
                netPoolCents,
                agentTurnoverCents: childTeam,
                companyTurnoverCents,
                sharePoints: diffPoints,
                bucketBase,
              })
            : 0n;
        overrideAmount += amount;
        breakdown.push({
          agentId: child.agentId,
          label: child.label ?? '',
          uid: child.uid ?? '',
          sharePoints: child.sharePoints,
          diffPoints: Math.max(0, diffPoints),
          teamTurnoverCents: childTeam,
          amountCents: amount,
        });
      }
    }
    results.set(agent.agentId, {
      teamTurnoverCents: teamTurnover.get(agent.agentId) ?? 0n,
      selfAmountCents: selfAmount,
      overrideAmountCents: overrideAmount,
      amountCents: selfAmount + overrideAmount,
      breakdown,
    });
  }
  return results;
}

export type PoolStatus = 'ESTIMATED' | 'PENDING' | 'SETTLED' | 'NO_DISTRIBUTION';

export interface AgentComputation {
  agentId: string;
  label: string;
  status: string;
  userId: string;
  uid: string;
  nickname: string | null;
  sharePoints: number;
  parentAgentId: string | null;
  playerCount: number;
  /** 自身流水（直属玩家 + 本人） */
  selfTurnoverCents: bigint;
  /** 团队流水（自身 + 所有下级团队） */
  teamTurnoverCents: bigint;
  /** 团队流水贡献比（万分比整数，前端换算展示） */
  contributionBp: number;
  selfAmountCents: bigint;
  overrideAmountCents: bigint;
  amountCents: bigint;
  breakdown: SubagentBreakdown[];
}

export interface PoolComputation {
  date: string;
  status: PoolStatus;
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
  /** 数据是否已锁定（报表已生成，含待确认/已发放/不分配） */
  settled: boolean;
}

/** 支出 = 流水 × 比例（分为单位四舍五入，与返水佣金同口径） */
export function expenseOf(turnoverCents: bigint, expenseRatio: number): bigint {
  const millionths = BigInt(Math.round(expenseRatio * 1_000_000));
  return (turnoverCents * millionths + 500_000n) / 1_000_000n;
}

type StoredBreakdown = Array<{
  agentId: string;
  label: string;
  uid: string;
  sharePoints: number;
  diffPoints: number;
  teamTurnoverCents: string;
  amountCents: string;
}>;

function serializeBreakdown(breakdown: SubagentBreakdown[]): StoredBreakdown {
  return breakdown.map((row) => ({
    ...row,
    teamTurnoverCents: String(row.teamTurnoverCents),
    amountCents: String(row.amountCents),
  }));
}

function deserializeBreakdown(value: unknown): SubagentBreakdown[] {
  if (!Array.isArray(value)) return [];
  return (value as StoredBreakdown).map((row) => ({
    agentId: row.agentId,
    label: row.label,
    uid: row.uid,
    sharePoints: row.sharePoints,
    diffPoints: row.diffPoints,
    teamTurnoverCents: BigInt(row.teamTurnoverCents ?? 0),
    amountCents: BigInt(row.amountCents ?? 0),
  }));
}

/**
 * 计算某日利润池全貌（不落库）。
 * 已生成日（PENDING/SETTLED/NO_DISTRIBUTION）：回放 ProfitPoolDaily + 分配明细，保证展示与账一致；
 * 未生成日（含当天）：按当前配置与代理树实时估算。
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
    const status = (existing.status as PoolStatus) ?? 'SETTLED';
    return {
      date,
      status,
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
        parentAgentId: share.agent.parentAgentId,
        playerCount: share.agent._count.players,
        selfTurnoverCents: share.turnoverCents,
        teamTurnoverCents: share.teamTurnoverCents,
        contributionBp:
          share.companyTurnoverCents > 0n
            ? Number((share.teamTurnoverCents * 10_000n) / share.companyTurnoverCents)
            : 0,
        selfAmountCents: share.selfAmountCents,
        overrideAmountCents: share.overrideAmountCents,
        amountCents: share.amountCents,
        breakdown: deserializeBreakdown(share.breakdown),
      })),
      settled: true,
    };
  }

  const config = await getProfitPoolConfig();
  const window = malaysiaDayWindow(date);
  const [playerRake, bankerPairRake, bankerSummaries, turnover, previousPool, agents] = await Promise.all([
    prisma.settlement.aggregate({
      where: { createdAt: window, outcome: 'PLAYER_WIN' },
      _sum: { rakeCents: true },
    }),
    prisma.settlement.aggregate({
      where: { createdAt: window, outcome: 'BANKER_WIN' },
      _sum: { rakeCents: true },
    }),
    prisma.roundScoreboard.findMany({
      where: { round: { settledAt: window } },
      select: { bankerSummary: true },
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
  const rakeBankerCents =
    (bankerPairRake._sum.rakeCents ?? 0n) +
    bankerSummaries.reduce(
      (sum, row) => sum + bankerRakeCentsFromSummary(row.bankerSummary),
      0n,
    );
  const rakeTotalCents = rakePlayerCents + rakeBankerCents;
  const turnoverCents = turnover._sum.selfCents ?? 0n;
  const expenseCents = expenseOf(turnoverCents, config.expenseRatio);
  const carryInCents = previousPool && previousPool.carryOutCents < 0n
    ? previousPool.carryOutCents
    : 0n;
  const netPoolCents = rakeTotalCents - expenseCents + carryInCents;

  // 需要流水的用户：所有归属玩家 + 代理本人（本人若被绑为他人玩家则只计一次）
  const boundPlayerIds = new Set(
    agents.flatMap((agent) => agent.players.map((p) => p.userId)),
  );
  const turnoverUserIds = new Set(boundPlayerIds);
  for (const agent of agents) turnoverUserIds.add(agent.userId);
  const turnoverRows = turnoverUserIds.size
    ? await prisma.turnoverDaily.findMany({
        where: { date, userId: { in: [...turnoverUserIds] } },
        select: { userId: true, selfCents: true },
      })
    : [];
  const turnoverByUser = new Map<string, bigint>();
  for (const row of turnoverRows) {
    turnoverByUser.set(row.userId, (turnoverByUser.get(row.userId) ?? 0n) + row.selfCents);
  }

  const shareInputs: AgentShareInput[] = agents.map((agent) => {
    let selfTurnover = agent.players.reduce(
      (sum, player) => sum + (turnoverByUser.get(player.userId) ?? 0n),
      0n,
    );
    // 代理本人的流水计入自身流水（除非本人被绑定为其他代理的归属玩家，避免重复计算）
    if (!boundPlayerIds.has(agent.userId)) {
      selfTurnover += turnoverByUser.get(agent.userId) ?? 0n;
    }
    return {
      agentId: agent.id,
      parentAgentId: agent.parentAgentId,
      sharePoints: agent.sharePoints,
      status: agent.status,
      selfTurnoverCents: selfTurnover,
      label: agent.label,
      uid: agent.user.uid,
    };
  });

  const shareResults = computeAgentShares({
    netPoolCents,
    companyTurnoverCents: turnoverCents,
    bucketBase: config.bucketBase,
    agents: shareInputs,
  });

  let distributed = 0n;
  const agentRows: AgentComputation[] = agents.map((agent, index) => {
    const input = shareInputs[index];
    const result = shareResults.get(agent.id) ?? {
      teamTurnoverCents: 0n,
      selfAmountCents: 0n,
      overrideAmountCents: 0n,
      amountCents: 0n,
      breakdown: [],
    };
    distributed += result.amountCents;
    return {
      agentId: agent.id,
      label: agent.label,
      status: agent.status,
      userId: agent.userId,
      uid: agent.user.uid,
      nickname: agent.user.nickname,
      sharePoints: agent.sharePoints,
      parentAgentId: agent.parentAgentId,
      playerCount: agent.players.length,
      selfTurnoverCents: input.selfTurnoverCents,
      teamTurnoverCents: result.teamTurnoverCents,
      contributionBp:
        turnoverCents > 0n
          ? Number((result.teamTurnoverCents * 10_000n) / turnoverCents)
          : 0,
      selfAmountCents: result.selfAmountCents,
      overrideAmountCents: result.overrideAmountCents,
      amountCents: result.amountCents,
      breakdown: result.breakdown,
    };
  });

  const distributable = netPoolCents > 0n ? netPoolCents : 0n;
  return {
    date,
    status: 'ESTIMATED',
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
 * 第一阶段：生成某日称桶报表（PENDING，待后台确认；净池 ≤ 0 直接落 NO_DISTRIBUTION）。
 * 不做任何转账。幂等：ProfitPoolDaily.date 唯一。只允许生成已结束的马来日。
 */
export async function generateProfitPool(date: string, actorId?: string) {
  if (date >= malaysiaDay()) throw new ProfitPoolError('DATE_NOT_CLOSED');
  const computation = await computeProfitPool(date);
  if (computation.status !== 'ESTIMATED') return null;

  return serializable(async (tx) => {
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
        status: computation.netPoolCents > 0n ? 'PENDING' : 'NO_DISTRIBUTION',
        settledBy: actorId ?? 'SYSTEM',
      },
    });
    // 全量存 ACTIVE 代理明细（含 0 金额），保证前台报表回放完整
    for (const agent of computation.agents) {
      if (agent.status !== 'ACTIVE') continue;
      await tx.agentProfitShare.create({
        data: {
          poolId: pool.id,
          agentId: agent.agentId,
          date,
          turnoverCents: agent.selfTurnoverCents,
          teamTurnoverCents: agent.teamTurnoverCents,
          companyTurnoverCents: computation.turnoverCents,
          sharePointsSnapshot: agent.sharePoints,
          bucketBaseSnapshot: computation.bucketBase,
          selfAmountCents: agent.selfAmountCents,
          overrideAmountCents: agent.overrideAmountCents,
          amountCents: agent.amountCents,
          breakdown: serializeBreakdown(agent.breakdown) as Prisma.InputJsonValue,
          ledgerRef:
            agent.amountCents > 0n ? `profit-share:${date}:${agent.agentId}` : null,
        },
      });
    }
    return pool;
  });
}

/**
 * 第二阶段：确认发放。PENDING → SETTLED，逐笔从 PLATFORM_PROFIT_POOL 转入代理可用余额。
 * 幂等：状态条件更新 + 转账幂等键 profit-share:{date}:{agentId}。
 */
export async function confirmProfitPool(date: string, adminId: string) {
  const pool = await prisma.profitPoolDaily.findUnique({ where: { date } });
  if (!pool) throw new ProfitPoolError('POOL_NOT_GENERATED');
  if (pool.status === 'SETTLED') return null;
  if (pool.status !== 'PENDING') throw new ProfitPoolError('POOL_NOT_CONFIRMABLE');
  const distributableCents = pool.netPoolCents > 0n ? pool.netPoolCents : 0n;
  if (pool.distributedCents > distributableCents) {
    throw new ProfitPoolError('DISTRIBUTION_EXCEEDS_POOL', {
      distributableCents: String(distributableCents),
      distributedCents: String(pool.distributedCents),
    });
  }

  const result = await serializable(async (tx) => {
    const updated = await tx.profitPoolDaily.updateMany({
      where: { id: pool.id, status: 'PENDING' },
      data: { status: 'SETTLED', confirmedBy: adminId, confirmedAt: new Date() },
    });
    if (updated.count !== 1) return null;
    const shares = await tx.agentProfitShare.findMany({
      where: { poolId: pool.id, amountCents: { gt: 0n } },
      include: { agent: { select: { userId: true, sharePoints: true } } },
    });
    for (const share of shares) {
      await transfer(tx, {
        amountCents: share.amountCents,
        from: { accountType: AccountType.PLATFORM_PROFIT_POOL },
        to: { userId: share.agent.userId, accountType: AccountType.USER_AVAILABLE },
        refType: 'profit_share',
        refId: share.agentId,
        idempotencyKey: share.ledgerRef ?? `profit-share:${date}:${share.agentId}`,
        operatorId: adminId,
      });
    }
    return { pool, shares };
  });

  if (result) {
    for (const share of result.shares) {
      const amount = `${share.amountCents / 100n}.${(share.amountCents % 100n)
        .toString()
        .padStart(2, '0')}`;
      void pushService
        .sendCustom(
          share.agent.userId,
          `💼 ${date} 称桶分成已发放\n占成 ${share.sharePointsSnapshot}/${share.bucketBaseSnapshot}，分成 ${amount} 已发放到可用余额。`,
        )
        .catch(() => undefined);
    }
    return result.pool;
  }
  return null;
}

/** 作废待确认报表（未发生转账，可安全删除后重新生成） */
export async function discardPendingProfitPool(
  date: string,
  actorId = 'SYSTEM',
  auditIp?: string,
) {
  const discarded = await serializable(async (tx) => {
    const pool = await tx.profitPoolDaily.findUnique({ where: { date } });
    if (!pool) throw new ProfitPoolError('POOL_NOT_GENERATED');
    if (pool.status !== 'PENDING') throw new ProfitPoolError('POOL_NOT_CONFIRMABLE');
    await tx.$executeRawUnsafe(
      "SELECT set_config('app.allow_legacy_pending_discard', 'on', true)",
    );
    await tx.agentProfitShare.deleteMany({ where: { poolId: pool.id } });
    const deleted = await tx.profitPoolDaily.deleteMany({
      where: { id: pool.id, status: 'PENDING' },
    });
    if (deleted.count !== 1) throw new ProfitPoolError('POOL_NOT_CONFIRMABLE');
    await tx.auditLog.create({
      data: {
        adminId: actorId,
        action: 'LEGACY_PROFIT_POOL_DISCARDED_FOR_CUTOVER',
        target: pool.id,
        after: {
          date,
          netPoolCents: String(pool.netPoolCents),
        },
        ip: auditIp,
      },
    });
    return pool;
  });
  return discarded;
}

/** 后台任务入口：自动生成前一马来日报表（配置可关；发放始终需后台确认） */
export async function autoGenerateProfitPool(date: string) {
  const config = await getProfitPoolConfig();
  if (!config.autoSettle) return null;
  try {
    return await generateProfitPool(date);
  } catch (error) {
    if (error instanceof ProfitPoolError) return null;
    throw error;
  }
}

/** 近 N 日趋势（含未生成日的实时估算），供后台图表 */
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
    status: string;
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
        status: settledRow.status,
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
      status: 'ESTIMATED',
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
  parent: { select: { id: true, label: true, sharePoints: true } },
  _count: { select: { players: true, children: true } },
} satisfies Prisma.AgentInclude;

export async function listAgents() {
  return prisma.agent.findMany({
    include: AGENT_INCLUDE,
    orderBy: { createdAt: 'asc' },
  });
}

export async function getAgentByUserId(userId: string) {
  return prisma.agent.findUnique({
    where: { userId },
    include: AGENT_INCLUDE,
  });
}

/** 后台建立第一层代理（无上级；下级代理由上级在前台升级产生） */
export async function createAgent(params: {
  uid: string;
  label: string;
  sharePoints: number;
  actorId?: string;
}) {
  return serializable(async (tx) => {
    await lockProfitPoolStructure(tx);
    const config = await getGameConfigInTransaction(
      tx,
      PLATFORM_CONFIG_SCOPE,
      'profitPool',
      DEFAULT_PROFIT_POOL_CONFIG,
    );
    assertSharePoints(params.sharePoints, config.bucketBase);
    const user = await tx.user.findUnique({
      where: { uid: params.uid },
      include: { agentBinding: true },
    });
    if (!user) throw new ProfitPoolError('USER_NOT_FOUND');
    if (user.kind === 'VIRTUAL') throw new ProfitPoolError('VIRTUAL_NOT_ALLOWED');
    if (user.adminNote === HOUSE_INVITER_NOTE) {
      throw new ProfitPoolError('HOUSE_INVITER_NOT_ALLOWED');
    }
    if (user.status === UserStatus.BANNED) throw new ProfitPoolError('USER_BANNED');
    const existing = await tx.agent.findUnique({ where: { userId: user.id } });
    if (existing) throw new ProfitPoolError('AGENT_ALREADY_EXISTS');
    if (user.agentBinding) throw new ProfitPoolError('USER_IS_BOUND_PLAYER');
    const agent = await tx.agent.create({
      data: {
        userId: user.id,
        label: params.label.trim() || `代理-${user.uid}`,
        sharePoints: params.sharePoints,
        createdBy: params.actorId ?? 'ADMIN',
      },
      include: AGENT_INCLUDE,
    });
    // 加成代理前已经邀请过的直属好友，补绑到该代理名下，避免只对「之后」的邀请生效
    const invitees = await tx.user.findMany({
      where: {
        inviterId: user.id,
        kind: 'HUMAN',
        agentProfile: { is: null },
        agentBinding: { is: null },
      },
      select: { id: true },
    });
    if (invitees.length) {
      await tx.agentPlayer.createMany({
        data: invitees.map((invitee) => ({
          agentId: agent.id,
          userId: invitee.id,
          boundBy: params.actorId ?? 'ADMIN',
          source: 'REFERRAL',
        })),
        skipDuplicates: true,
      });
    }
    return agent;
  });
}

/**
 * 校验代理点数在树中的合法区间：
 * - 有上级：点数 ≤ 上级点数 − 最低预留；
 * - 有下级：点数 ≥ 最大下级点数 + 最低预留。
 */
async function assertPointsInTree(params: {
  points: number;
  parentPoints: number | null;
  agentId?: string;
  config: ProfitPoolConfig;
  tx?: Prisma.TransactionClient;
}) {
  const { points, parentPoints, agentId, config, tx } = params;
  assertSharePoints(points, config.bucketBase);
  const max =
    parentPoints !== null ? parentPoints - config.minReservePoints : config.bucketBase;
  let min = 0;
  if (agentId) {
    const topChild = tx
      ? await tx.agent.findFirst({
          where: { parentAgentId: agentId },
          orderBy: { sharePoints: 'desc' },
          select: { sharePoints: true },
        })
      : await prisma.agent.findFirst({
          where: { parentAgentId: agentId },
          orderBy: { sharePoints: 'desc' },
          select: { sharePoints: true },
        });
    if (topChild) min = topChild.sharePoints + config.minReservePoints;
  }
  if (points > max || points < min) {
    throw new ProfitPoolError('SHARE_POINTS_OUT_OF_RANGE', {
      min,
      max: Math.max(min, max),
      minReservePoints: config.minReservePoints,
    });
  }
}

export async function updateAgent(params: {
  agentId: string;
  label?: string;
  sharePoints?: number;
  status?: 'ACTIVE' | 'DISABLED';
}) {
  return serializable(async (tx) => {
    await lockProfitPoolStructure(tx);
    const agent = await tx.agent.findUnique({
      where: { id: params.agentId },
      include: { parent: { select: { sharePoints: true } } },
    });
    if (!agent) throw new ProfitPoolError('AGENT_NOT_FOUND');
    if (params.sharePoints !== undefined) {
      const config = await getGameConfigInTransaction(
        tx,
        PLATFORM_CONFIG_SCOPE,
        'profitPool',
        DEFAULT_PROFIT_POOL_CONFIG,
      );
      await assertPointsInTree({
        points: params.sharePoints,
        parentPoints: agent.parent?.sharePoints ?? null,
        agentId: agent.id,
        config,
        tx,
      });
    }
    return tx.agent.update({
      where: { id: params.agentId },
      data: {
        label: params.label?.trim() || undefined,
        sharePoints: params.sharePoints,
        status: params.status,
      },
      include: AGENT_INCLUDE,
    });
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
  source?: 'MANUAL' | 'REFERRAL';
}) {
  const agent = await prisma.agent.findUnique({ where: { id: params.agentId } });
  if (!agent) throw new ProfitPoolError('AGENT_NOT_FOUND');
  const user = await prisma.user.findUnique({
    where: { uid: params.uid },
    include: { agentProfile: true },
  });
  if (!user) throw new ProfitPoolError('USER_NOT_FOUND');
  if (user.kind === 'VIRTUAL') throw new ProfitPoolError('VIRTUAL_NOT_ALLOWED');
  if (user.agentProfile) throw new ProfitPoolError('AGENT_CANNOT_BE_PLAYER');
  const existing = await prisma.agentPlayer.findUnique({ where: { userId: user.id } });
  if (existing) {
    if (existing.agentId === params.agentId) return existing;
    throw new ProfitPoolError('PLAYER_ALREADY_BOUND');
  }
  return prisma.agentPlayer.create({
    data: {
      agentId: params.agentId,
      userId: user.id,
      boundBy: params.actorId,
      source: params.source ?? 'MANUAL',
    },
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

/**
 * 上级代理把直属玩家升级为下级代理：
 * - 占成 ≤ 上级占成 − 最低预留；
 * - 原玩家归属记录转换为代理（删除 AgentPlayer，其后续流水计入自己名下）。
 */
export async function promoteAgentPlayer(params: {
  parentAgentId: string;
  playerUserId: string;
  sharePoints: number;
  label?: string;
  actorId?: string;
}) {
  return serializable(async (tx) => {
    await lockProfitPoolStructure(tx);
    const config = await getGameConfigInTransaction(
      tx,
      PLATFORM_CONFIG_SCOPE,
      'profitPool',
      DEFAULT_PROFIT_POOL_CONFIG,
    );
    const parent = await tx.agent.findUnique({ where: { id: params.parentAgentId } });
    if (!parent || parent.status !== 'ACTIVE') throw new ProfitPoolError('AGENT_NOT_FOUND');
    await assertPointsInTree({
      points: params.sharePoints,
      parentPoints: parent.sharePoints,
      config,
      tx,
    });
    const binding = await tx.agentPlayer.findUnique({
      where: { userId: params.playerUserId },
      include: { user: { select: { uid: true, nickname: true, kind: true } } },
    });
    if (!binding || binding.agentId !== params.parentAgentId) {
      throw new ProfitPoolError('BINDING_NOT_FOUND');
    }
    if (binding.user.kind === 'VIRTUAL') throw new ProfitPoolError('VIRTUAL_NOT_ALLOWED');
    const existingAgent = await tx.agent.findUnique({
      where: { userId: params.playerUserId },
    });
    if (existingAgent) throw new ProfitPoolError('AGENT_ALREADY_EXISTS');
    await tx.agentPlayer.delete({ where: { id: binding.id } });
    return tx.agent.create({
      data: {
        userId: params.playerUserId,
        label:
          params.label?.trim() ||
          binding.user.nickname?.trim() ||
          `代理-${binding.user.uid}`,
        sharePoints: params.sharePoints,
        parentAgentId: params.parentAgentId,
        createdBy: params.actorId ?? params.parentAgentId,
      },
      include: { user: { select: { uid: true, nickname: true } } },
    });
  });
}

/** 上级调整直属下级占成（分成管理） */
export async function updateSubagentPoints(params: {
  parentAgentId: string;
  subagentId: string;
  sharePoints: number;
}) {
  return serializable(async (tx) => {
    await lockProfitPoolStructure(tx);
    const config = await getGameConfigInTransaction(
      tx,
      PLATFORM_CONFIG_SCOPE,
      'profitPool',
      DEFAULT_PROFIT_POOL_CONFIG,
    );
    const [parent, child] = await Promise.all([
      tx.agent.findUnique({ where: { id: params.parentAgentId } }),
      tx.agent.findUnique({ where: { id: params.subagentId } }),
    ]);
    if (!parent || parent.status !== 'ACTIVE') throw new ProfitPoolError('AGENT_NOT_FOUND');
    if (!child || child.parentAgentId !== params.parentAgentId) {
      throw new ProfitPoolError('SUBAGENT_NOT_FOUND');
    }
    await assertPointsInTree({
      points: params.sharePoints,
      parentPoints: parent.sharePoints,
      agentId: child.id,
      config,
      tx,
    });
    return tx.agent.update({
      where: { id: child.id },
      data: { sharePoints: params.sharePoints },
      include: { user: { select: { uid: true, nickname: true } } },
    });
  });
}

/**
 * 推荐注册自动归属：沿邀请链向上找最近的 ACTIVE 代理（含邀请人本人），
 * 找到则把新玩家自动绑定到该代理名下。已被绑定/本人是代理时跳过。
 * 在绑定邀请人的事务内调用，失败不阻断注册主流程（由调用方兜底）。
 */
export async function autoBindReferralPlayer(
  tx: Prisma.TransactionClient,
  userId: string,
  inviterId: string,
): Promise<{ agentId: string } | null> {
  const [existingBinding, selfAgent] = await Promise.all([
    tx.agentPlayer.findUnique({ where: { userId } }),
    tx.agent.findUnique({ where: { userId } }),
  ]);
  if (existingBinding || selfAgent) return null;

  let cursor: string | null = inviterId;
  for (let depth = 0; cursor && depth < 20; depth += 1) {
    const agent: { id: string; status: string } | null = await tx.agent.findUnique({
      where: { userId: cursor },
      select: { id: true, status: true },
    });
    if (agent?.status === 'ACTIVE') {
      await tx.agentPlayer.create({
        data: { agentId: agent.id, userId, boundBy: 'REFERRAL', source: 'REFERRAL' },
      });
      return { agentId: agent.id };
    }
    const upline: { inviterId: string | null } | null = await tx.user.findUnique({
      where: { id: cursor },
      select: { inviterId: true },
    });
    cursor = upline?.inviterId ?? null;
  }
  return null;
}
