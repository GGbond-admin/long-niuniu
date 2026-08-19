import { prisma } from '../lib/prisma.js';
import { getProfitPoolConfig, ProfitPoolError } from './profitPool.js';
import { computeHierarchyMetrics } from './profitPoolRange.js';

export const AGENT_ONLINE_WINDOW_MS = 90_000;

async function onlineUserIds(userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const rows = await prisma.roomMember.findMany({
    where: {
      userId: { in: [...new Set(userIds)] },
      status: 'ACTIVE',
      lastSeenAt: { gte: new Date(Date.now() - AGENT_ONLINE_WINDOW_MS) },
    },
    distinct: ['userId'],
    select: { userId: true },
  });
  return new Set(rows.map((row) => row.userId));
}

function aggregateTeamMoney(
  nodes: Array<{ id: string; parentId: string | null; own: bigint }>,
): Map<string, bigint> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId || !byId.has(node.parentId)) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node.id);
    children.set(node.parentId, list);
  }
  const totals = new Map<string, bigint>();
  const visit = (id: string, visiting = new Set<string>()): bigint => {
    const cached = totals.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0n;
    visiting.add(id);
    let total = byId.get(id)?.own ?? 0n;
    for (const childId of children.get(id) ?? []) total += visit(childId, visiting);
    visiting.delete(id);
    totals.set(id, total);
    return total;
  };
  for (const node of nodes) visit(node.id);
  return totals;
}

function remainingPointsHundredths(params: {
  residualCents: bigint;
  netPoolCents: bigint;
  bucketBase: number;
}) {
  return params.netPoolCents > 0n
    ? Number(
        (params.residualCents * BigInt(params.bucketBase) * 100n) /
          params.netPoolCents,
      )
    : params.bucketBase * 100;
}

function contributionByChild(value: unknown): Map<string, bigint> {
  if (!Array.isArray(value)) return new Map();
  const result = new Map<string, bigint>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.agentId !== 'string') continue;
    try {
      result.set(row.agentId, BigInt(String(row.amountCents ?? 0)));
    } catch {
      result.set(row.agentId, 0n);
    }
  }
  return result;
}

async function buildAdminAgentNetwork(poolId?: string) {
  if (poolId) {
    const batch = await prisma.profitPoolBatch.findUnique({
      where: { id: poolId },
      include: {
        room: { select: { id: true, title: true, gameCode: true } },
        agentSnapshots: { orderBy: [{ level: 'asc' }, { label: 'asc' }] },
      },
    });
    if (!batch) throw new ProfitPoolError('POOL_NOT_GENERATED');
    const online = await onlineUserIds(batch.agentSnapshots.map((agent) => agent.userId));
    const nodes = batch.agentSnapshots.map((agent) => ({
      id: agent.sourceAgentId,
      userId: agent.userId,
      parentId: agent.parentSourceAgentId,
      label: agent.label,
      uid: agent.uid,
      nickname: agent.nickname,
      avatarUrl: agent.avatarUrl,
      level: agent.level,
      status: agent.statusSnapshot,
      online: online.has(agent.userId),
      sharePoints: agent.sharePointsSnapshot,
      bucketBase: agent.bucketBaseSnapshot,
      directAgentCount: agent.directAgentCount,
      teamAgentCount: agent.teamAgentCount,
      directPlayerCount: agent.directPlayerCount,
      teamPlayerCount: agent.teamPlayerCount,
      onlineTeamCount: 0,
      turnoverCents: String(agent.selfTurnoverCents),
      teamTurnoverCents: String(agent.teamTurnoverCents),
      selfAmountCents: String(agent.selfAmountCents),
      overrideAmountCents: String(agent.overrideAmountCents),
      profitCents: String(agent.amountCents),
      teamProfitCents: String(agent.amountCents),
      lifetimeProfitCents: null,
      contributionBp: agent.contributionBp,
    }));
    const subtreeOnline = new Map<string, number>();
    const children = new Map<string, string[]>();
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const node of nodes) {
      if (!node.parentId || !byId.has(node.parentId)) continue;
      const list = children.get(node.parentId) ?? [];
      list.push(node.id);
      children.set(node.parentId, list);
    }
    const countOnline = (id: string): number => {
      const cached = subtreeOnline.get(id);
      if (cached !== undefined) return cached;
      const node = byId.get(id);
      let count = node?.online ? 1 : 0;
      for (const childId of children.get(id) ?? []) count += countOnline(childId);
      subtreeOnline.set(id, count);
      return count;
    };
    for (const node of nodes) node.onlineTeamCount = countOnline(node.id);

    const teamProfit = aggregateTeamMoney(
      batch.agentSnapshots.map((agent) => ({
        id: agent.sourceAgentId,
        parentId: agent.parentSourceAgentId,
        own: agent.amountCents,
      })),
    );
    for (const node of nodes) node.teamProfitCents = String(teamProfit.get(node.id) ?? 0n);

    return {
      mode: 'SNAPSHOT' as const,
      generatedAt: new Date().toISOString(),
      batch: {
        id: batch.id,
        poolCode: batch.poolCode,
        room: batch.room,
        startSeqNo: batch.startSeqNo,
        endSeqNo: batch.endSeqNo,
        status: batch.status,
        generatedAt: batch.generatedAt,
        turnoverCents: String(batch.turnoverCents),
        netPoolCents: String(batch.netPoolCents),
        distributedCents: String(batch.distributedCents),
        residualCents: String(batch.residualCents),
        bucketBase: batch.bucketBaseSnapshot,
        companyRemainingPointsHundredths: remainingPointsHundredths({
          residualCents: batch.residualCents,
          netPoolCents: batch.netPoolCents,
          bucketBase: batch.bucketBaseSnapshot,
        }),
      },
      summary: {
        agentCount: nodes.length,
        onlineAgentCount: nodes.filter((node) => node.online).length,
        rootAgentCount: nodes.filter((node) => !node.parentId).length,
        teamPlayerCount: nodes
          .filter((node) => !node.parentId)
          .reduce((total, node) => total + node.teamPlayerCount, 0),
      },
      nodes,
    };
  }

  const [agents, latestBatch, lifetimeRows, legacyLifetimeRows, config] =
    await Promise.all([
      prisma.agent.findMany({
        include: {
          user: { select: { uid: true, nickname: true, avatarUrl: true } },
          _count: { select: { players: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.profitPoolBatch.findFirst({
        orderBy: { generatedAt: 'desc' },
        include: {
          agentSnapshots: true,
          room: { select: { id: true, title: true, gameCode: true } },
        },
      }),
      prisma.profitPoolAgentSnapshot.groupBy({
        by: ['sourceAgentId'],
        where: { pool: { status: 'DISTRIBUTED' } },
        _sum: { amountCents: true },
      }),
      prisma.agentProfitShare.groupBy({
        by: ['agentId'],
        where: { pool: { status: 'SETTLED' } },
        _sum: { amountCents: true },
      }),
      getProfitPoolConfig(),
    ]);
  const metrics = computeHierarchyMetrics(
    agents.map((agent) => ({
      id: agent.id,
      parentAgentId: agent.parentAgentId,
      directPlayerCount: agent._count.players,
    })),
  );
  const online = await onlineUserIds(agents.map((agent) => agent.userId));
  const latestByAgent = new Map(
    latestBatch?.agentSnapshots.map((snapshot) => [snapshot.sourceAgentId, snapshot]) ?? [],
  );
  const lifetimeByAgent = new Map(
    lifetimeRows.map((row) => [row.sourceAgentId, row._sum.amountCents ?? 0n]),
  );
  for (const row of legacyLifetimeRows) {
    lifetimeByAgent.set(
      row.agentId,
      (lifetimeByAgent.get(row.agentId) ?? 0n) + (row._sum.amountCents ?? 0n),
    );
  }
  const teamLifetime = aggregateTeamMoney(
    agents.map((agent) => ({
      id: agent.id,
      parentId: agent.parentAgentId,
      own: lifetimeByAgent.get(agent.id) ?? 0n,
    })),
  );
  const children = new Map<string, string[]>();
  for (const agent of agents) {
    if (!agent.parentAgentId) continue;
    const list = children.get(agent.parentAgentId) ?? [];
    list.push(agent.id);
    children.set(agent.parentAgentId, list);
  }
  const byAgent = new Map(agents.map((agent) => [agent.id, agent]));
  const onlineTeam = new Map<string, number>();
  const countOnline = (id: string, visiting = new Set<string>()): number => {
    const cached = onlineTeam.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let count = online.has(byAgent.get(id)?.userId ?? '') ? 1 : 0;
    for (const childId of children.get(id) ?? []) count += countOnline(childId, visiting);
    visiting.delete(id);
    onlineTeam.set(id, count);
    return count;
  };

  const nodes = agents.map((agent) => {
    const metric = metrics.get(agent.id)!;
    const latest = latestByAgent.get(agent.id);
    return {
      id: agent.id,
      userId: agent.userId,
      parentId: agent.parentAgentId,
      label: agent.label,
      uid: agent.user.uid,
      nickname: agent.user.nickname,
      avatarUrl: agent.user.avatarUrl,
      level: metric.level,
      status: agent.status,
      online: online.has(agent.userId),
      sharePoints: agent.sharePoints,
      bucketBase: config.bucketBase,
      directAgentCount: metric.directAgentCount,
      teamAgentCount: metric.teamAgentCount,
      directPlayerCount: metric.directPlayerCount,
      teamPlayerCount: metric.teamPlayerCount,
      onlineTeamCount: countOnline(agent.id),
      turnoverCents: String(latest?.selfTurnoverCents ?? 0n),
      teamTurnoverCents: String(latest?.teamTurnoverCents ?? 0n),
      selfAmountCents: String(latest?.selfAmountCents ?? 0n),
      overrideAmountCents: String(latest?.overrideAmountCents ?? 0n),
      profitCents: String(latest?.amountCents ?? 0n),
      teamProfitCents: String(teamLifetime.get(agent.id) ?? 0n),
      lifetimeProfitCents: String(lifetimeByAgent.get(agent.id) ?? 0n),
      contributionBp: latest?.contributionBp ?? 0,
    };
  });

  return {
    mode: 'LIVE' as const,
    generatedAt: new Date().toISOString(),
    batch: latestBatch
      ? {
          id: latestBatch.id,
          poolCode: latestBatch.poolCode,
          room: latestBatch.room,
          startSeqNo: latestBatch.startSeqNo,
          endSeqNo: latestBatch.endSeqNo,
          status: latestBatch.status,
          generatedAt: latestBatch.generatedAt,
          turnoverCents: String(latestBatch.turnoverCents),
          netPoolCents: String(latestBatch.netPoolCents),
          distributedCents: String(latestBatch.distributedCents),
          residualCents: String(latestBatch.residualCents),
          bucketBase: latestBatch.bucketBaseSnapshot,
          companyRemainingPointsHundredths: remainingPointsHundredths({
            residualCents: latestBatch.residualCents,
            netPoolCents: latestBatch.netPoolCents,
            bucketBase: latestBatch.bucketBaseSnapshot,
          }),
        }
      : null,
    summary: {
      agentCount: nodes.length,
      onlineAgentCount: nodes.filter((node) => node.online).length,
      rootAgentCount: nodes.filter((node) => !node.parentId).length,
      teamPlayerCount: nodes
        .filter((node) => !node.parentId)
        .reduce((total, node) => total + node.teamPlayerCount, 0),
    },
    nodes,
  };
}

type AgentNetworkResult = Awaited<ReturnType<typeof buildAdminAgentNetwork>>;
type PromiseCacheEntry<T> = {
  expiresAt: number | null;
  promise: Promise<T>;
};

export function getOrCreateTimedPromise<T>(
  cache: Map<string, PromiseCacheEntry<T>>,
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const cached = cache.get(key);
  if (
    cached
    && (cached.expiresAt === null || cached.expiresAt > Date.now())
  ) {
    return cached.promise;
  }

  const promise = Promise.resolve().then(loader);
  const entry: PromiseCacheEntry<T> = { expiresAt: null, promise };
  cache.set(key, entry);
  void promise.then(
    () => {
      if (cache.get(key)?.promise !== promise) return;
      entry.expiresAt = Date.now() + ttlMs;
      setTimeout(() => {
        if (cache.get(key)?.promise === promise) cache.delete(key);
      }, ttlMs).unref();
    },
    () => {
      if (cache.get(key)?.promise === promise) cache.delete(key);
    },
  );
  return promise;
}

const agentNetworkCache = new Map<
  string,
  PromiseCacheEntry<AgentNetworkResult>
>();

export async function getAdminAgentNetwork(poolId?: string) {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    return buildAdminAgentNetwork(poolId);
  }
  const key = poolId ?? '__live__';
  const ttlMs = poolId ? 60_000 : 5_000;
  return getOrCreateTimedPromise(
    agentNetworkCache,
    key,
    ttlMs,
    () => buildAdminAgentNetwork(poolId),
  );
}

export async function getAdminAgentDashboard(agentId: string, poolId?: string) {
  const network = await getAdminAgentNetwork(poolId);
  const agent = network.nodes.find((node) => node.id === agentId);
  if (!agent) throw new ProfitPoolError('AGENT_NOT_FOUND');
  const [periods, players] = await Promise.all([
    prisma.profitPoolAgentSnapshot.findMany({
      where: { sourceAgentId: agentId },
      include: {
        pool: {
          include: { room: { select: { id: true, title: true, gameCode: true } } },
        },
      },
      orderBy: [{ pool: { generatedAt: 'desc' } }, { poolId: 'desc' }],
      take: 13,
    }),
    poolId
      ? prisma.profitPoolPlayerSnapshot.findMany({
          where: { poolId, sourceAgentId: agentId, isAgentSelf: false },
          orderBy: [{ turnoverCents: 'desc' }, { userId: 'asc' }],
          take: 21,
        })
      : prisma.agentPlayer.findMany({
          where: { agentId },
          include: {
            user: {
              select: {
                id: true,
                uid: true,
                nickname: true,
                avatarUrl: true,
                status: true,
                createdAt: true,
              },
            },
          },
          orderBy: [{ boundAt: 'desc' }, { id: 'desc' }],
          take: 21,
        }),
  ]);
  const visiblePeriods = periods.slice(0, 12);
  const visiblePlayers = players.slice(0, 20);
  const lastPlayer = visiblePlayers.at(-1);
  return {
    mode: network.mode,
    batch: network.batch,
    agent,
    children: network.nodes.filter((node) => node.parentId === agentId),
    periods: visiblePeriods.map((period) => ({
      poolId: period.poolId,
      poolCode: period.pool.poolCode,
      room: period.pool.room,
      startSeqNo: period.pool.startSeqNo,
      endSeqNo: period.pool.endSeqNo,
      status: period.pool.status,
      generatedAt: period.pool.generatedAt,
      turnoverCents: String(period.selfTurnoverCents),
      teamTurnoverCents: String(period.teamTurnoverCents),
      amountCents: String(period.amountCents),
    })),
    periodsNextCursor:
      periods.length > visiblePeriods.length
        ? visiblePeriods.at(-1)?.poolId ?? null
        : null,
    players: visiblePlayers.map((player) => {
      if ('turnoverCents' in player) {
        return {
          userId: player.userId,
          uid: player.uid,
          nickname: player.nickname,
          avatarUrl: player.avatarUrl,
          source: player.bindingSource,
          turnoverCents: String(player.turnoverCents),
          profitCents: String(player.profitCents),
        };
      }
      return {
        userId: player.userId,
        uid: player.user.uid,
        nickname: player.user.nickname,
        avatarUrl: player.user.avatarUrl,
        source: player.source,
        status: player.user.status,
        joinedAt: player.user.createdAt,
        boundAt: player.boundAt,
      };
    }),
    playersNextCursor:
      players.length > visiblePlayers.length
        ? lastPlayer && 'turnoverCents' in lastPlayer
          ? lastPlayer.userId
          : lastPlayer?.id ?? null
        : null,
  };
}

export async function listAdminAgentDashboardPeriods(
  agentId: string,
  cursor?: string,
  limit = 20,
) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true },
  });
  if (!agent) throw new ProfitPoolError('AGENT_NOT_FOUND');
  const rows = await prisma.profitPoolAgentSnapshot.findMany({
    where: { sourceAgentId: agentId },
    include: {
      pool: {
        include: { room: { select: { id: true, title: true, gameCode: true } } },
      },
    },
    orderBy: [{ pool: { generatedAt: 'desc' } }, { poolId: 'desc' }],
    take: limit + 1,
    ...(cursor
      ? {
          cursor: {
            poolId_sourceAgentId: {
              poolId: cursor,
              sourceAgentId: agentId,
            },
          },
          skip: 1,
        }
      : {}),
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: items.map((period) => ({
      poolId: period.poolId,
      poolCode: period.pool.poolCode,
      room: period.pool.room,
      startSeqNo: period.pool.startSeqNo,
      endSeqNo: period.pool.endSeqNo,
      status: period.pool.status,
      generatedAt: period.pool.generatedAt,
      turnoverCents: String(period.selfTurnoverCents),
      teamTurnoverCents: String(period.teamTurnoverCents),
      amountCents: String(period.amountCents),
    })),
    nextCursor: hasMore ? items.at(-1)?.poolId ?? null : null,
  };
}

export async function listAdminAgentDashboardPlayers(
  agentId: string,
  poolId?: string,
  cursor?: string,
  limit = 20,
) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true },
  });
  if (!agent) throw new ProfitPoolError('AGENT_NOT_FOUND');

  if (poolId) {
    const rows = await prisma.profitPoolPlayerSnapshot.findMany({
      where: { poolId, sourceAgentId: agentId, isAgentSelf: false },
      orderBy: [{ turnoverCents: 'desc' }, { userId: 'asc' }],
      take: limit + 1,
      ...(cursor
        ? {
            cursor: { poolId_userId: { poolId, userId: cursor } },
            skip: 1,
          }
        : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: items.map((player) => ({
        userId: player.userId,
        uid: player.uid,
        nickname: player.nickname,
        avatarUrl: player.avatarUrl,
        source: player.bindingSource,
        turnoverCents: String(player.turnoverCents),
        profitCents: String(player.profitCents),
      })),
      nextCursor: hasMore ? items.at(-1)?.userId ?? null : null,
    };
  }

  const rows = await prisma.agentPlayer.findMany({
    where: { agentId },
    include: {
      user: {
        select: {
          id: true,
          uid: true,
          nickname: true,
          avatarUrl: true,
          status: true,
          createdAt: true,
        },
      },
    },
    orderBy: [{ boundAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: items.map((player) => ({
      userId: player.userId,
      uid: player.user.uid,
      nickname: player.user.nickname,
      avatarUrl: player.user.avatarUrl,
      source: player.source,
      status: player.user.status,
      joinedAt: player.user.createdAt,
      boundAt: player.boundAt,
    })),
    nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
  };
}

export async function getAgentSelfDashboard(userId: string, requestedPoolId?: string) {
  const agent = await prisma.agent.findUnique({
    where: { userId },
    include: {
      user: { select: { uid: true, nickname: true, avatarUrl: true } },
      _count: { select: { players: true, children: true } },
    },
  });
  if (!agent || agent.status !== 'ACTIVE') throw new ProfitPoolError('AGENT_NOT_FOUND');

  const [
    periods,
    lifetimeAggregate,
    legacyLifetimeAggregate,
    requestedSnapshot,
    liveNetwork,
  ] = await Promise.all([
    prisma.profitPoolAgentSnapshot.findMany({
      where: { sourceAgentId: agent.id },
      include: {
        pool: {
          include: { room: { select: { id: true, title: true, gameCode: true } } },
        },
      },
      orderBy: [{ pool: { generatedAt: 'desc' } }, { poolId: 'desc' }],
      take: 51,
    }),
    prisma.profitPoolAgentSnapshot.aggregate({
      where: {
        sourceAgentId: agent.id,
        pool: { status: 'DISTRIBUTED' },
      },
      _sum: { amountCents: true },
    }),
    prisma.agentProfitShare.aggregate({
      where: {
        agentId: agent.id,
        pool: { status: 'SETTLED' },
      },
      _sum: { amountCents: true },
    }),
    requestedPoolId
      ? prisma.profitPoolAgentSnapshot.findUnique({
          where: {
            poolId_sourceAgentId: {
              poolId: requestedPoolId,
              sourceAgentId: agent.id,
            },
          },
          include: {
            pool: {
              include: { room: { select: { id: true, title: true, gameCode: true } } },
            },
          },
        })
      : Promise.resolve(null),
    getAdminAgentNetwork(),
  ]);
  const selected = requestedPoolId
    ? requestedSnapshot
    : periods[0] ?? null;
  const visiblePeriods = periods.slice(0, 50);
  const periodsNextCursor =
    periods.length > visiblePeriods.length
      ? visiblePeriods.at(-1)?.poolId ?? null
      : null;
  if (requestedPoolId && !selected) throw new ProfitPoolError('POOL_NOT_GENERATED');
  const displayPeriods =
    selected && !visiblePeriods.some((period) => period.poolId === selected.poolId)
      ? [...visiblePeriods, selected]
      : visiblePeriods;
  const lifetime =
    (lifetimeAggregate._sum.amountCents ?? 0n)
    + (legacyLifetimeAggregate._sum.amountCents ?? 0n);
  const liveNode = liveNetwork.nodes.find((node) => node.id === agent.id);

  if (!selected) {
    return {
      profile: {
        id: agent.id,
        label: agent.label,
        uidMasked: maskUid(agent.user.uid),
        nickname: agent.user.nickname,
        avatarUrl: agent.user.avatarUrl,
        sharePoints: agent.sharePoints,
        directAgentCount: agent._count.children,
        teamAgentCount: liveNode?.teamAgentCount ?? agent._count.children,
        directPlayerCount: agent._count.players,
        teamPlayerCount: liveNode?.teamPlayerCount ?? agent._count.players,
        online: liveNode?.online ?? false,
        onlineTeamCount: liveNode?.onlineTeamCount ?? 0,
        lifetimeProfitCents: String(lifetime),
      },
      periods: [],
      periodsNextCursor: null,
      selected: null,
    };
  }

  const [children, players] = await Promise.all([
    prisma.profitPoolAgentSnapshot.findMany({
      where: { poolId: selected.poolId, parentSourceAgentId: agent.id },
      orderBy: { amountCents: 'desc' },
    }),
    prisma.profitPoolPlayerSnapshot.findMany({
      where: { poolId: selected.poolId, sourceAgentId: agent.id, isAgentSelf: false },
      orderBy: [{ turnoverCents: 'desc' }, { userId: 'asc' }],
      take: 51,
    }),
  ]);
  const childContributions = contributionByChild(selected.breakdown);
  const visiblePlayers = players.slice(0, 50);
  const playersNextCursor =
    players.length > visiblePlayers.length
      ? visiblePlayers.at(-1)?.userId ?? null
      : null;

  return {
    profile: {
      id: agent.id,
      label: agent.label,
      uidMasked: maskUid(agent.user.uid),
      nickname: agent.user.nickname,
      avatarUrl: agent.user.avatarUrl,
      sharePoints: agent.sharePoints,
      directAgentCount: agent._count.children,
      teamAgentCount: liveNode?.teamAgentCount ?? agent._count.children,
      directPlayerCount: agent._count.players,
      teamPlayerCount: liveNode?.teamPlayerCount ?? agent._count.players,
      online: liveNode?.online ?? false,
      onlineTeamCount: liveNode?.onlineTeamCount ?? 0,
      lifetimeProfitCents: String(lifetime),
    },
    periods: displayPeriods.map((period) => ({
      poolId: period.poolId,
      poolCode: period.pool.poolCode,
      room: period.pool.room,
      startSeqNo: period.pool.startSeqNo,
      endSeqNo: period.pool.endSeqNo,
      status: period.pool.status,
      generatedAt: period.pool.generatedAt,
      amountCents: String(period.amountCents),
    })),
    periodsNextCursor,
    selected: {
      pool: {
        id: selected.pool.id,
        poolCode: selected.pool.poolCode,
        room: selected.pool.room,
        startSeqNo: selected.pool.startSeqNo,
        endSeqNo: selected.pool.endSeqNo,
        status: selected.pool.status,
        generatedAt: selected.pool.generatedAt,
      },
      mine: {
        sharePoints: selected.sharePointsSnapshot,
        bucketBase: selected.bucketBaseSnapshot,
        directAgentCount: selected.directAgentCount,
        teamAgentCount: selected.teamAgentCount,
        directPlayerCount: selected.directPlayerCount,
        teamPlayerCount: selected.teamPlayerCount,
        selfTurnoverCents: String(selected.selfTurnoverCents),
        teamTurnoverCents: String(selected.teamTurnoverCents),
        contributionBp: selected.contributionBp,
        selfAmountCents: String(selected.selfAmountCents),
        overrideAmountCents: String(selected.overrideAmountCents),
        totalAmountCents: String(selected.amountCents),
        lifetimeProfitCents: String(lifetime),
      },
      subagents: children.map((child) => ({
        agentId: child.sourceAgentId,
        label: child.label,
        uidMasked: maskUid(child.uid),
        sharePoints: child.sharePointsSnapshot,
        diffPoints: Math.max(0, selected.sharePointsSnapshot - child.sharePointsSnapshot),
        directAgentCount: child.directAgentCount,
        teamAgentCount: child.teamAgentCount,
        directPlayerCount: child.directPlayerCount,
        teamPlayerCount: child.teamPlayerCount,
        teamTurnoverCents: String(child.teamTurnoverCents),
        ownAmountCents: String(child.amountCents),
        contributionAmountCents: String(
          childContributions.get(child.sourceAgentId) ?? 0n,
        ),
      })),
      players: visiblePlayers.map((player) => ({
        userId: player.userId,
        uidMasked: maskUid(player.uid),
        nickname: player.nickname,
        avatarUrl: player.avatarUrl,
        turnoverCents: String(player.turnoverCents),
        profitCents: String(player.profitCents),
      })),
      playersNextCursor,
    },
  };
}

export async function listAgentDashboardPeriods(
  userId: string,
  cursor?: string,
  limit = 50,
) {
  const agent = await prisma.agent.findUnique({
    where: { userId },
    select: { id: true, status: true },
  });
  if (!agent || agent.status !== 'ACTIVE') throw new ProfitPoolError('AGENT_NOT_FOUND');
  const rows = await prisma.profitPoolAgentSnapshot.findMany({
    where: { sourceAgentId: agent.id },
    include: {
      pool: {
        include: { room: { select: { id: true, title: true, gameCode: true } } },
      },
    },
    orderBy: [{ pool: { generatedAt: 'desc' } }, { poolId: 'desc' }],
    take: limit + 1,
    ...(cursor
      ? {
          cursor: {
            poolId_sourceAgentId: {
              poolId: cursor,
              sourceAgentId: agent.id,
            },
          },
          skip: 1,
        }
      : {}),
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: items.map((period) => ({
      poolId: period.poolId,
      poolCode: period.pool.poolCode,
      room: period.pool.room,
      startSeqNo: period.pool.startSeqNo,
      endSeqNo: period.pool.endSeqNo,
      status: period.pool.status,
      generatedAt: period.pool.generatedAt,
      amountCents: String(period.amountCents),
    })),
    nextCursor: hasMore ? items.at(-1)?.poolId ?? null : null,
  };
}

export async function listAgentDashboardPlayers(
  userId: string,
  poolId: string,
  cursor?: string,
  limit = 50,
) {
  const agent = await prisma.agent.findUnique({
    where: { userId },
    select: { id: true, status: true },
  });
  if (!agent || agent.status !== 'ACTIVE') throw new ProfitPoolError('AGENT_NOT_FOUND');
  const ownSnapshot = await prisma.profitPoolAgentSnapshot.findUnique({
    where: {
      poolId_sourceAgentId: {
        poolId,
        sourceAgentId: agent.id,
      },
    },
    select: { id: true },
  });
  if (!ownSnapshot) throw new ProfitPoolError('POOL_NOT_GENERATED');
  const rows = await prisma.profitPoolPlayerSnapshot.findMany({
    where: { poolId, sourceAgentId: agent.id, isAgentSelf: false },
    orderBy: [{ turnoverCents: 'desc' }, { userId: 'asc' }],
    take: limit + 1,
    ...(cursor
      ? {
          cursor: {
            poolId_userId: {
              poolId,
              userId: cursor,
            },
          },
          skip: 1,
        }
      : {}),
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: items.map((player) => ({
      userId: player.userId,
      uidMasked: maskUid(player.uid),
      nickname: player.nickname,
      avatarUrl: player.avatarUrl,
      turnoverCents: String(player.turnoverCents),
      profitCents: String(player.profitCents),
    })),
    nextCursor: hasMore ? items.at(-1)?.userId ?? null : null,
  };
}

export function maskUid(uid: string): string {
  if (uid.length <= 6) return uid;
  return `${uid.slice(0, 3)}****${uid.slice(-3)}`;
}
