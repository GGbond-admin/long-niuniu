import { createHash } from 'node:crypto';
import { Prisma, type RoundPhase, type SettleOutcome, type UserKind } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { parseSettingsSnapshot } from './gameSettings.js';
import {
  ProfitPoolError,
  bucketShareCents,
  computeAgentShares,
  type SubagentBreakdown,
} from './profitPool.js';

type DbClient = Prisma.TransactionClient | typeof prisma;

export const MAX_PROFIT_POOL_ROUNDS = 10_000;
const MAX_SEQUENCE_NUMBER = 2_147_483_647;

export interface RangeSettlementRow {
  userId: string;
  betCents: bigint;
  outcome: SettleOutcome;
  rakeCents: bigint;
}

export interface RangeRoundRow {
  id: string;
  seqNo: number;
  phase: RoundPhase;
  bankerId: string | null;
  configSnapshot: Prisma.JsonValue | null;
  finishedAt: Date | null;
  settlements: RangeSettlementRow[];
}

export interface RangeFinancials {
  turnoverPlayerCents: bigint;
  turnoverBankerCents: bigint;
  turnoverCents: bigint;
  rakePlayerCents: bigint;
  rakeBankerCents: bigint;
  rakeTotalCents: bigint;
  turnoverByUser: Map<string, bigint>;
}

export interface RangeAgentComputation {
  agentId: string;
  userId: string;
  parentAgentId: string | null;
  label: string;
  uid: string;
  nickname: string | null;
  avatarUrl: string | null;
  level: number;
  status: string;
  sharePoints: number;
  directAgentCount: number;
  teamAgentCount: number;
  directPlayerCount: number;
  teamPlayerCount: number;
  selfTurnoverCents: bigint;
  teamTurnoverCents: bigint;
  contributionBp: number;
  selfAmountCents: bigint;
  overrideAmountCents: bigint;
  amountCents: bigint;
  breakdown: SubagentBreakdown[];
}

export interface RangePlayerComputation {
  agentId: string;
  userId: string;
  uid: string;
  nickname: string | null;
  avatarUrl: string | null;
  bindingSource: string;
  isAgentSelf: boolean;
  turnoverCents: bigint;
  profitCents: bigint;
}

export interface ProfitPoolRangeComputation {
  room: { id: string; title: string; gameCode: string };
  startSeqNo: number;
  endSeqNo: number;
  roundCount: number;
  finishedRoundCount: number;
  cancelledRoundCount: number;
  rounds: Array<{
    id: string;
    seqNo: number;
    phase: RoundPhase;
    finishedAt: Date | null;
  }>;
  expenseBps: number;
  expenseCents: bigint;
  netPoolCents: bigint;
  bucketBase: number;
  distributedCents: bigint;
  residualCents: bigint;
  companyRemainingPointsHundredths: number;
  financials: RangeFinancials;
  agents: RangeAgentComputation[];
  players: RangePlayerComputation[];
  calculationHash: string;
}

interface HierarchyMetric {
  level: number;
  directAgentCount: number;
  teamAgentCount: number;
  directPlayerCount: number;
  teamPlayerCount: number;
}

function addToMap(target: Map<string, bigint>, key: string, amount: bigint) {
  if (amount <= 0n) return;
  target.set(key, (target.get(key) ?? 0n) + amount);
}

/** 支出百分比使用整数万分点，避免 Float 在财务计算中产生不可审计误差。 */
export function expenseFromBps(turnoverCents: bigint, expenseBps: number): bigint {
  if (!Number.isInteger(expenseBps) || expenseBps < 0 || expenseBps > 10_000) {
    throw new ProfitPoolError('INVALID_EXPENSE_RATIO');
  }
  return (turnoverCents * BigInt(expenseBps) + 5_000n) / 10_000n;
}

/**
 * 按已结算行重建区间有效流水和抽水。
 * 流水沿用既有口径：同一笔对赌分别计入闲家和庄家；平局按该局配置决定。
 */
export function aggregateRangeFinancials(
  rounds: RangeRoundRow[],
  userKinds: Map<string, UserKind>,
): RangeFinancials {
  let turnoverPlayerCents = 0n;
  let turnoverBankerCents = 0n;
  let rakePlayerCents = 0n;
  let rakeBankerCents = 0n;
  const turnoverByUser = new Map<string, bigint>();

  for (const round of rounds) {
    if (round.phase !== 'FINISHED') continue;
    let includeTieBets = false;
    try {
      includeTieBets = parseSettingsSnapshot(round.configSnapshot).rebate.includeTieBets;
    } catch {
      throw new ProfitPoolError('ROUND_CONFIG_SNAPSHOT_MISSING', { seqNo: round.seqNo });
    }

    let bankerTurnover = 0n;
    for (const settlement of round.settlements) {
      if (settlement.outcome === 'PLAYER_WIN') rakePlayerCents += settlement.rakeCents;
      if (settlement.outcome === 'BANKER_WIN') rakeBankerCents += settlement.rakeCents;

      const countsAsTurnover = settlement.outcome !== 'TIE' || includeTieBets;
      if (!countsAsTurnover || settlement.outcome === 'VOID') continue;
      if (userKinds.get(settlement.userId) === 'HUMAN') {
        turnoverPlayerCents += settlement.betCents;
        addToMap(turnoverByUser, settlement.userId, settlement.betCents);
      }
      bankerTurnover += settlement.betCents;
    }
    if (
      bankerTurnover > 0n &&
      round.bankerId &&
      userKinds.get(round.bankerId) === 'HUMAN'
    ) {
      turnoverBankerCents += bankerTurnover;
      addToMap(turnoverByUser, round.bankerId, bankerTurnover);
    }
  }

  return {
    turnoverPlayerCents,
    turnoverBankerCents,
    turnoverCents: turnoverPlayerCents + turnoverBankerCents,
    rakePlayerCents,
    rakeBankerCents,
    rakeTotalCents: rakePlayerCents + rakeBankerCents,
    turnoverByUser,
  };
}

export function computeHierarchyMetrics(
  agents: Array<{
    id: string;
    parentAgentId: string | null;
    directPlayerCount: number;
  }>,
): Map<string, HierarchyMetric> {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const children = new Map<string, string[]>();
  for (const agent of agents) {
    if (!agent.parentAgentId || !byId.has(agent.parentAgentId)) continue;
    const list = children.get(agent.parentAgentId) ?? [];
    list.push(agent.id);
    children.set(agent.parentAgentId, list);
  }

  const levels = new Map<string, number>();
  const levelOf = (id: string, visiting = new Set<string>()): number => {
    const cached = levels.get(id);
    if (cached) return cached;
    if (visiting.has(id)) return 1;
    visiting.add(id);
    const parentId = byId.get(id)?.parentAgentId;
    const level = parentId && byId.has(parentId) ? levelOf(parentId, visiting) + 1 : 1;
    visiting.delete(id);
    levels.set(id, level);
    return level;
  };

  const results = new Map<string, HierarchyMetric>();
  const aggregate = (
    id: string,
    visiting = new Set<string>(),
  ): { agents: number; players: number } => {
    const cached = results.get(id);
    if (cached) {
      return { agents: cached.teamAgentCount, players: cached.teamPlayerCount };
    }
    const agent = byId.get(id);
    if (!agent || visiting.has(id)) return { agents: 0, players: 0 };
    visiting.add(id);
    let teamAgentCount = 0;
    let teamPlayerCount = agent.directPlayerCount;
    for (const childId of children.get(id) ?? []) {
      const child = aggregate(childId, visiting);
      teamAgentCount += 1 + child.agents;
      teamPlayerCount += child.players;
    }
    visiting.delete(id);
    results.set(id, {
      level: levelOf(id),
      directAgentCount: children.get(id)?.length ?? 0,
      teamAgentCount,
      directPlayerCount: agent.directPlayerCount,
      teamPlayerCount,
    });
    return { agents: teamAgentCount, players: teamPlayerCount };
  };

  for (const agent of agents) aggregate(agent.id);
  return results;
}

function stableRangeHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function money(value: bigint): string {
  return value.toString();
}

function missingSeqNos(rounds: RangeRoundRow[], startSeqNo: number, endSeqNo: number): number[] {
  const found = new Set(rounds.map((round) => round.seqNo));
  const missing: number[] = [];
  for (let seq = startSeqNo; seq <= endSeqNo && missing.length < 20; seq += 1) {
    if (!found.has(seq)) missing.push(seq);
  }
  return missing;
}

export async function computeProfitPoolRange(
  params: {
    roomId: string;
    startSeqNo: number;
    endSeqNo: number;
    expenseBps: number;
  },
  db: DbClient = prisma,
): Promise<ProfitPoolRangeComputation> {
  const { roomId, startSeqNo, endSeqNo, expenseBps } = params;
  if (
    !Number.isInteger(startSeqNo) ||
    !Number.isInteger(endSeqNo) ||
    startSeqNo < 1 ||
    startSeqNo > MAX_SEQUENCE_NUMBER ||
    endSeqNo > MAX_SEQUENCE_NUMBER ||
    endSeqNo < startSeqNo
  ) {
    throw new ProfitPoolError('SEQ_RANGE_INVALID');
  }
  const expectedRoundCount = endSeqNo - startSeqNo + 1;
  if (expectedRoundCount > MAX_PROFIT_POOL_ROUNDS) {
    throw new ProfitPoolError('SEQ_RANGE_TOO_LARGE', { maxRounds: MAX_PROFIT_POOL_ROUNDS });
  }
  expenseFromBps(0n, expenseBps);

  const [room, cutover, rounds, locked, config] = await Promise.all([
    db.room.findUnique({
      where: { id: roomId },
      select: { id: true, title: true, gameCode: true },
    }),
    db.profitPoolCutover.findUnique({ where: { roomId } }),
    db.round.findMany({
      where: { roomId, seqNo: { gte: startSeqNo, lte: endSeqNo } },
      orderBy: { seqNo: 'asc' },
      select: {
        id: true,
        seqNo: true,
        phase: true,
        bankerId: true,
        configSnapshot: true,
        finishedAt: true,
        settlements: {
          select: {
            userId: true,
            betCents: true,
            outcome: true,
            rakeCents: true,
          },
        },
      },
    }),
    db.profitPoolRoundLock.findFirst({
      where: { roomId, seqNo: { gte: startSeqNo, lte: endSeqNo } },
      select: { seqNo: true, pool: { select: { poolCode: true } } },
      orderBy: { seqNo: 'asc' },
    }),
    db.gameConfig.findUnique({
      where: { gameCode_key: { gameCode: 'PLATFORM', key: 'profitPool' } },
      select: { value: true },
    }),
  ]);

  if (!room) throw new ProfitPoolError('ROOM_NOT_FOUND');
  if (cutover && startSeqNo <= cutover.maxSeqNo) {
    throw new ProfitPoolError('CUTOVER_SEQ_BLOCKED', { minSeqNo: cutover.maxSeqNo + 1 });
  }
  if (locked) {
    throw new ProfitPoolError('RANGE_OVERLAP', {
      seqNo: locked.seqNo,
      poolCode: locked.pool.poolCode,
    });
  }
  if (rounds.length !== expectedRoundCount) {
    throw new ProfitPoolError('ROUND_RANGE_INCOMPLETE', {
      expected: expectedRoundCount,
      found: rounds.length,
      missingSeqNos: missingSeqNos(rounds, startSeqNo, endSeqNo),
    });
  }
  const nonTerminal = rounds.filter(
    (round) => round.phase !== 'FINISHED' && round.phase !== 'CANCELLED',
  );
  if (nonTerminal.length) {
    throw new ProfitPoolError('ROUNDS_NOT_TERMINAL', {
      rounds: nonTerminal.slice(0, 20).map((round) => ({
        seqNo: round.seqNo,
        phase: round.phase,
      })),
    });
  }

  const participantIds = new Set<string>();
  for (const round of rounds) {
    if (round.bankerId) participantIds.add(round.bankerId);
    for (const settlement of round.settlements) participantIds.add(settlement.userId);
  }
  const participants = participantIds.size
    ? await db.user.findMany({
        where: { id: { in: [...participantIds] } },
        select: { id: true, kind: true },
      })
    : [];
  const userKinds = new Map(participants.map((user) => [user.id, user.kind]));
  const financials = aggregateRangeFinancials(rounds, userKinds);

  const rawConfig =
    config?.value && typeof config.value === 'object' && !Array.isArray(config.value)
      ? (config.value as Record<string, unknown>)
      : {};
  const bucketBase =
    typeof rawConfig.bucketBase === 'number' &&
    Number.isInteger(rawConfig.bucketBase) &&
    rawConfig.bucketBase > 0
      ? rawConfig.bucketBase
      : 130;
  const minReservePoints =
    typeof rawConfig.minReservePoints === 'number' &&
    Number.isInteger(rawConfig.minReservePoints) &&
    rawConfig.minReservePoints >= 0
      ? rawConfig.minReservePoints
      : 5;

  const agents = await db.agent.findMany({
    include: {
      user: { select: { id: true, uid: true, nickname: true, avatarUrl: true } },
      players: {
        include: {
          user: { select: { id: true, uid: true, nickname: true, avatarUrl: true } },
        },
        orderBy: [{ boundAt: 'asc' }, { id: 'asc' }],
      },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  for (const agent of agents) {
    const parent = agent.parentAgentId ? agentsById.get(agent.parentAgentId) : null;
    if (parent && parent.sharePoints - agent.sharePoints < minReservePoints) {
      throw new ProfitPoolError('INVALID_AGENT_HIERARCHY', {
        minReservePoints,
        parentAgentId: parent.id,
        parentSharePoints: parent.sharePoints,
        childAgentId: agent.id,
        childSharePoints: agent.sharePoints,
      });
    }
    const lineage = new Set<string>();
    let cursor: (typeof agents)[number] | undefined = agent;
    while (cursor) {
      if (lineage.has(cursor.id)) {
        throw new ProfitPoolError('INVALID_AGENT_HIERARCHY', {
          cycleAgentId: cursor.id,
        });
      }
      lineage.add(cursor.id);
      cursor = cursor.parentAgentId ? agentsById.get(cursor.parentAgentId) : undefined;
    }
  }
  const boundPlayerIds = new Set(
    agents.flatMap((agent) => agent.players.map((player) => player.userId)),
  );
  const hierarchy = computeHierarchyMetrics(
    agents.map((agent) => ({
      id: agent.id,
      parentAgentId: agent.parentAgentId,
      directPlayerCount: agent.players.length,
    })),
  );

  const expenseCents = expenseFromBps(financials.turnoverCents, expenseBps);
  const netPoolCents = financials.rakeTotalCents - expenseCents;
  const shareInputs = agents.map((agent) => {
    let selfTurnoverCents = agent.players.reduce(
      (total, player) => total + (financials.turnoverByUser.get(player.userId) ?? 0n),
      0n,
    );
    if (!boundPlayerIds.has(agent.userId)) {
      selfTurnoverCents += financials.turnoverByUser.get(agent.userId) ?? 0n;
    }
    return {
      agentId: agent.id,
      parentAgentId: agent.parentAgentId,
      sharePoints: agent.sharePoints,
      status: agent.status,
      selfTurnoverCents,
      label: agent.label,
      uid: agent.user.uid,
    };
  });
  const shareResults = computeAgentShares({
    netPoolCents,
    companyTurnoverCents: financials.turnoverCents,
    bucketBase,
    agents: shareInputs,
  });

  let distributedCents = 0n;
  const agentRows: RangeAgentComputation[] = agents.map((agent, index) => {
    const metrics = hierarchy.get(agent.id) ?? {
      level: 1,
      directAgentCount: 0,
      teamAgentCount: 0,
      directPlayerCount: agent.players.length,
      teamPlayerCount: agent.players.length,
    };
    const result = shareResults.get(agent.id) ?? {
      teamTurnoverCents: 0n,
      selfAmountCents: 0n,
      overrideAmountCents: 0n,
      amountCents: 0n,
      breakdown: [],
    };
    distributedCents += result.amountCents;
    return {
      agentId: agent.id,
      userId: agent.userId,
      parentAgentId: agent.parentAgentId,
      label: agent.label,
      uid: agent.user.uid,
      nickname: agent.user.nickname,
      avatarUrl: agent.user.avatarUrl,
      level: metrics.level,
      status: agent.status,
      sharePoints: agent.sharePoints,
      directAgentCount: metrics.directAgentCount,
      teamAgentCount: metrics.teamAgentCount,
      directPlayerCount: metrics.directPlayerCount,
      teamPlayerCount: metrics.teamPlayerCount,
      selfTurnoverCents: shareInputs[index].selfTurnoverCents,
      teamTurnoverCents: result.teamTurnoverCents,
      contributionBp:
        financials.turnoverCents > 0n
          ? Number((result.teamTurnoverCents * 10_000n) / financials.turnoverCents)
          : 0,
      selfAmountCents: result.selfAmountCents,
      overrideAmountCents: result.overrideAmountCents,
      amountCents: result.amountCents,
      breakdown: result.breakdown,
    };
  });

  const players: RangePlayerComputation[] = [];
  for (const agent of agents) {
    for (const binding of agent.players) {
      const turnoverCents = financials.turnoverByUser.get(binding.userId) ?? 0n;
      players.push({
        agentId: agent.id,
        userId: binding.userId,
        uid: binding.user.uid,
        nickname: binding.user.nickname,
        avatarUrl: binding.user.avatarUrl,
        bindingSource: binding.source,
        isAgentSelf: false,
        turnoverCents,
        profitCents: bucketShareCents({
          netPoolCents,
          agentTurnoverCents: turnoverCents,
          companyTurnoverCents: financials.turnoverCents,
          sharePoints: agent.sharePoints,
          bucketBase,
        }),
      });
    }
    if (!boundPlayerIds.has(agent.userId)) {
      const turnoverCents = financials.turnoverByUser.get(agent.userId) ?? 0n;
      players.push({
        agentId: agent.id,
        userId: agent.userId,
        uid: agent.user.uid,
        nickname: agent.user.nickname,
        avatarUrl: agent.user.avatarUrl,
        bindingSource: 'AGENT_SELF',
        isAgentSelf: true,
        turnoverCents,
        profitCents: bucketShareCents({
          netPoolCents,
          agentTurnoverCents: turnoverCents,
          companyTurnoverCents: financials.turnoverCents,
          sharePoints: agent.sharePoints,
          bucketBase,
        }),
      });
    }
  }

  const distributableCents = netPoolCents > 0n ? netPoolCents : 0n;
  if (distributedCents > distributableCents) {
    throw new ProfitPoolError('DISTRIBUTION_EXCEEDS_POOL', {
      distributableCents: money(distributableCents),
      distributedCents: money(distributedCents),
    });
  }
  const residualCents =
    distributableCents > distributedCents ? distributableCents - distributedCents : 0n;
  const companyRemainingPointsHundredths =
    distributableCents > 0n
      ? Number((residualCents * BigInt(bucketBase) * 100n) / distributableCents)
      : bucketBase * 100;
  const calculationHash = stableRangeHash({
    roomId,
    startSeqNo,
    endSeqNo,
    expenseBps,
    bucketBase,
    rounds: rounds.map((round) => [
      round.id,
      round.seqNo,
      round.phase,
      round.finishedAt?.toISOString() ?? null,
    ]),
    financials: {
      turnoverPlayerCents: money(financials.turnoverPlayerCents),
      turnoverBankerCents: money(financials.turnoverBankerCents),
      rakePlayerCents: money(financials.rakePlayerCents),
      rakeBankerCents: money(financials.rakeBankerCents),
      turnoverByUser: [...financials.turnoverByUser.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, amount]) => [id, money(amount)]),
    },
    agents: agentRows.map((agent) => [
      agent.agentId,
      agent.userId,
      agent.parentAgentId,
      agent.label,
      agent.uid,
      agent.nickname,
      agent.status,
      agent.sharePoints,
      agent.level,
      agent.directAgentCount,
      agent.teamAgentCount,
      agent.directPlayerCount,
      agent.teamPlayerCount,
      money(agent.selfTurnoverCents),
      money(agent.teamTurnoverCents),
      money(agent.amountCents),
    ]),
    players: players.map((player) => [
      player.agentId,
      player.userId,
      player.uid,
      player.nickname,
      player.bindingSource,
      player.isAgentSelf,
      money(player.turnoverCents),
      money(player.profitCents),
    ]),
  });

  return {
    room,
    startSeqNo,
    endSeqNo,
    roundCount: expectedRoundCount,
    finishedRoundCount: rounds.filter((round) => round.phase === 'FINISHED').length,
    cancelledRoundCount: rounds.filter((round) => round.phase === 'CANCELLED').length,
    rounds: rounds.map((round) => ({
      id: round.id,
      seqNo: round.seqNo,
      phase: round.phase,
      finishedAt: round.finishedAt,
    })),
    expenseBps,
    expenseCents,
    netPoolCents,
    bucketBase,
    distributedCents,
    residualCents,
    companyRemainingPointsHundredths,
    financials,
    agents: agentRows,
    players,
    calculationHash,
  };
}

export function serializeRangeBreakdown(breakdown: SubagentBreakdown[]) {
  return breakdown.map((row) => ({
    ...row,
    teamTurnoverCents: String(row.teamTurnoverCents),
    amountCents: String(row.amountCents),
  }));
}
