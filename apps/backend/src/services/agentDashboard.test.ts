import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    agent: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    profitPoolBatch: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    profitPoolAgentSnapshot: {
      groupBy: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      aggregate: vi.fn(),
    },
    profitPoolPlayerSnapshot: {
      findMany: vi.fn(),
      aggregate: vi.fn(),
    },
    agentProfitShare: {
      groupBy: vi.fn(),
      aggregate: vi.fn(),
    },
    agentPlayer: {
      findMany: vi.fn(),
    },
    roomMember: {
      findMany: vi.fn(),
    },
    gameConfig: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../lib/prisma.js', () => ({ prisma: mocks.prisma }));

import {
  collectDownlineSnapshots,
  getAdminAgentNetwork,
  getAgentSelfDashboard,
  getOrCreateTimedPromise,
} from './agentDashboard.js';

const agents = [
  {
    id: 'agent-a',
    userId: 'user-a',
    parentAgentId: null,
    label: 'A',
    status: 'ACTIVE',
    sharePoints: 65,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    user: { uid: 'A1000001', nickname: '代理 A', avatarUrl: null },
    players: [{ userId: 'player-a1' }, { userId: 'player-a2' }],
    _count: { players: 2 },
  },
  {
    id: 'agent-b',
    userId: 'user-b',
    parentAgentId: 'agent-a',
    label: 'B',
    status: 'DISABLED',
    sharePoints: 55,
    createdAt: new Date('2026-01-02T00:00:00Z'),
    user: { uid: 'B1000001', nickname: '代理 B', avatarUrl: null },
    players: [{ userId: 'player-b1' }],
    _count: { players: 1 },
  },
  {
    id: 'agent-c',
    userId: 'user-c',
    parentAgentId: 'agent-b',
    label: 'C',
    status: 'ACTIVE',
    sharePoints: 45,
    createdAt: new Date('2026-01-03T00:00:00Z'),
    user: { uid: 'C1000001', nickname: '代理 C', avatarUrl: null },
    players: [{ userId: 'player-c1' }, { userId: 'player-c2' }, { userId: 'player-c3' }],
    _count: { players: 3 },
  },
];

const latestBatch = {
  id: 'pool-latest',
  poolCode: 'TB202608190001',
  room: { id: 'room-1', title: '至尊厅', gameCode: 'SUPREME_NIUNIU' },
  startSeqNo: 1,
  endSeqNo: 10,
  status: 'DISTRIBUTED',
  generatedAt: new Date('2026-08-19T00:00:00Z'),
  turnoverCents: 1_000_000n,
  expenseCents: 25_000n,
  netPoolCents: 100_000n,
  distributedCents: 50_000n,
  residualCents: 50_000n,
  bucketBaseSnapshot: 130,
  agentSnapshots: [
    {
      sourceAgentId: 'agent-a',
      selfTurnoverCents: 100_000n,
      teamTurnoverCents: 600_000n,
      selfAmountCents: 10_000n,
      overrideAmountCents: 10_000n,
      amountCents: 20_000n,
      contributionBp: 6_000,
      bucketBaseSnapshot: 130,
    },
    {
      sourceAgentId: 'agent-b',
      selfTurnoverCents: 200_000n,
      teamTurnoverCents: 500_000n,
      selfAmountCents: 0n,
      overrideAmountCents: 0n,
      amountCents: 0n,
      contributionBp: 5_000,
      bucketBaseSnapshot: 130,
    },
    {
      sourceAgentId: 'agent-c',
      selfTurnoverCents: 300_000n,
      teamTurnoverCents: 300_000n,
      selfAmountCents: 30_000n,
      overrideAmountCents: 0n,
      amountCents: 30_000n,
      contributionBp: 3_000,
      bucketBaseSnapshot: 130,
    },
  ],
};

describe('agent network request cache', () => {
  it('coalesces an unresolved build even after its eventual TTL has elapsed', async () => {
    vi.useFakeTimers();
    try {
      const cache = new Map();
      let resolveFirst!: (value: string) => void;
      const firstLoader = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveFirst = resolve;
          }),
      );
      const first = getOrCreateTimedPromise(cache, 'live', 5_000, firstLoader);
      await Promise.resolve();

      vi.advanceTimersByTime(10_000);
      const whilePending = getOrCreateTimedPromise(
        cache,
        'live',
        5_000,
        firstLoader,
      );
      expect(whilePending).toBe(first);
      expect(firstLoader).toHaveBeenCalledOnce();

      resolveFirst('first');
      await expect(first).resolves.toBe('first');
      vi.advanceTimersByTime(4_999);
      expect(
        getOrCreateTimedPromise(cache, 'live', 5_000, firstLoader),
      ).toBe(first);

      vi.advanceTimersByTime(1);
      const secondLoader = vi.fn(async () => 'second');
      const second = getOrCreateTimedPromise(
        cache,
        'live',
        5_000,
        secondLoader,
      );
      expect(second).not.toBe(first);
      await expect(second).resolves.toBe('second');
      expect(secondLoader).toHaveBeenCalledOnce();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe('agent network dashboard aggregation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.agent.findMany.mockResolvedValue(agents);
    mocks.prisma.profitPoolBatch.findFirst.mockResolvedValue(latestBatch);
    mocks.prisma.gameConfig.findUnique.mockResolvedValue(null);
    mocks.prisma.profitPoolAgentSnapshot.groupBy.mockResolvedValue([
      { sourceAgentId: 'agent-a', _sum: { amountCents: 40_000n } },
      { sourceAgentId: 'agent-b', _sum: { amountCents: 0n } },
      { sourceAgentId: 'agent-c', _sum: { amountCents: 60_000n } },
    ]);
    mocks.prisma.agentProfitShare.groupBy.mockResolvedValue([]);
    // Duplicate rows are harmless even if a user is active in more than one room.
    mocks.prisma.roomMember.findMany.mockResolvedValue([
      { userId: 'user-a' },
      { userId: 'user-a' },
      { userId: 'user-c' },
    ]);
  });

  it('computes arbitrary-depth team counts, online totals, and lifetime profit', async () => {
    const result = await getAdminAgentNetwork();
    const root = result.nodes.find((node) => node.id === 'agent-a');
    const disabled = result.nodes.find((node) => node.id === 'agent-b');

    expect(result.mode).toBe('LIVE');
    expect(root).toEqual(
      expect.objectContaining({
        directAgentCount: 1,
        teamAgentCount: 2,
        directPlayerCount: 2,
        teamPlayerCount: 6,
        online: true,
        onlineTeamCount: 2,
        lifetimeProfitCents: '40000',
        teamProfitCents: '100000',
        selfAmountCents: '10000',
        overrideAmountCents: '10000',
      }),
    );
    expect(disabled?.status).toBe('DISABLED');
    expect(result.summary.onlineAgentCount).toBe(2);
    expect(result.summary.teamPlayerCount).toBe(6);
  });

  it('keeps historical hierarchy and money separate from live lifetime totals', async () => {
    mocks.prisma.profitPoolBatch.findUnique.mockResolvedValue({
      ...latestBatch,
      id: 'pool-old',
      poolCode: 'TB202608010001',
      agentSnapshots: [
        {
          sourceAgentId: 'agent-a',
          userId: 'user-a',
          parentSourceAgentId: null,
          label: 'A 旧名',
          uid: 'A1000001',
          nickname: '代理 A',
          avatarUrl: null,
          level: 1,
          statusSnapshot: 'ACTIVE',
          sharePointsSnapshot: 60,
          bucketBaseSnapshot: 130,
          directAgentCount: 0,
          teamAgentCount: 0,
          directPlayerCount: 1,
          teamPlayerCount: 1,
          selfTurnoverCents: 80_000n,
          teamTurnoverCents: 80_000n,
          selfAmountCents: 8_000n,
          overrideAmountCents: 0n,
          amountCents: 8_000n,
          contributionBp: 8_000,
        },
      ],
    });
    mocks.prisma.roomMember.findMany.mockResolvedValue([{ userId: 'user-a' }]);

    const result = await getAdminAgentNetwork('pool-old');
    expect(result.mode).toBe('SNAPSHOT');
    expect(result.nodes[0]).toEqual(
      expect.objectContaining({
        label: 'A 旧名',
        sharePoints: 60,
        profitCents: '8000',
        lifetimeProfitCents: null,
      }),
    );
  });
});

describe('agent self dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.agent.findUnique.mockResolvedValue({
      ...agents[0],
      _count: { players: 2, children: 1 },
    });
    mocks.prisma.agent.findMany.mockResolvedValue(agents);
    mocks.prisma.profitPoolBatch.findFirst.mockResolvedValue(latestBatch);
    mocks.prisma.profitPoolAgentSnapshot.groupBy.mockResolvedValue([
      { sourceAgentId: 'agent-a', _sum: { amountCents: 99_999n } },
    ]);
    mocks.prisma.agentProfitShare.groupBy.mockResolvedValue([]);
    mocks.prisma.roomMember.findMany.mockResolvedValue([{ userId: 'user-a' }]);
    mocks.prisma.profitPoolAgentSnapshot.aggregate.mockResolvedValue({
      _sum: {
        amountCents: 99_999n,
        selfAmountCents: 60_000n,
        overrideAmountCents: 39_999n,
      },
    });
    mocks.prisma.agentProfitShare.aggregate.mockResolvedValue({
      _sum: { amountCents: 1n },
    });
    mocks.prisma.profitPoolAgentSnapshot.findUnique.mockResolvedValue(null);
    mocks.prisma.profitPoolAgentSnapshot.findMany.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) => {
        if (typeof where.poolId === 'string') {
          return [
            {
              sourceAgentId: 'agent-a',
              parentSourceAgentId: null,
              label: 'A',
              uid: 'A1000001',
              sharePointsSnapshot: 65,
              selfTurnoverCents: 100_000n,
              teamTurnoverCents: 600_000n,
              selfAmountCents: 10_000n,
              overrideAmountCents: 10_000n,
              amountCents: 20_000n,
              directAgentCount: 1,
              teamAgentCount: 2,
              directPlayerCount: 2,
              teamPlayerCount: 6,
            },
            {
              sourceAgentId: 'agent-b',
              parentSourceAgentId: 'agent-a',
              label: 'B',
              uid: 'B1000001',
              sharePointsSnapshot: 55,
              directAgentCount: 1,
              teamAgentCount: 1,
              directPlayerCount: 1,
              teamPlayerCount: 4,
              selfTurnoverCents: 200_000n,
              teamTurnoverCents: 500_000n,
              selfAmountCents: 0n,
              overrideAmountCents: 0n,
              amountCents: 0n,
            },
            {
              sourceAgentId: 'agent-c',
              parentSourceAgentId: 'agent-b',
              label: 'C',
              uid: 'C1000001',
              sharePointsSnapshot: 45,
              directAgentCount: 0,
              teamAgentCount: 0,
              directPlayerCount: 3,
              teamPlayerCount: 3,
              selfTurnoverCents: 300_000n,
              teamTurnoverCents: 300_000n,
              selfAmountCents: 5_000n,
              overrideAmountCents: 0n,
              amountCents: 5_000n,
            },
          ];
        }
        return [
          {
            poolId: 'pool-latest',
            sharePointsSnapshot: 65,
            bucketBaseSnapshot: 130,
            directAgentCount: 1,
            teamAgentCount: 2,
            directPlayerCount: 2,
            teamPlayerCount: 6,
            selfTurnoverCents: 100_000n,
            teamTurnoverCents: 600_000n,
            contributionBp: 6_000,
            selfAmountCents: 10_000n,
            overrideAmountCents: 10_000n,
            amountCents: 20_000n,
            breakdown: [{ agentId: 'agent-b', amountCents: '7000' }],
            pool: latestBatch,
          },
        ];
      },
    );
    mocks.prisma.profitPoolPlayerSnapshot.findMany.mockResolvedValue([]);
    mocks.prisma.profitPoolPlayerSnapshot.aggregate.mockResolvedValue({
      _sum: { turnoverCents: 100_000n },
    });
  });

  it('uses an all-history aggregate for lifetime profit and exposes live team presence', async () => {
    mocks.prisma.profitPoolPlayerSnapshot.findMany.mockResolvedValue(
      Array.from({ length: 51 }, (_, index) => ({
        userId: `player-${index}`,
        uid: `P${String(index).padStart(7, '0')}`,
        nickname: `玩家 ${index}`,
        avatarUrl: null,
        turnoverCents: BigInt(10_000 - index),
        profitCents: 100n,
      })),
    );
    const result = await getAgentSelfDashboard('user-a');

    expect(result.profile).toEqual(
      expect.objectContaining({
        lifetimeProfitCents: '100000',
        lifetimeSelfAmountCents: '60000',
        lifetimeOverrideAmountCents: '39999',
        lifetimeLegacyCents: '1',
        bucketBase: 130,
        online: true,
        onlineTeamCount: 1,
        teamAgentCount: 2,
        teamPlayerCount: 6,
      }),
    );
    expect(result.selected?.mine).toEqual(
      expect.objectContaining({
        teamAgentCount: 2,
        teamPlayerCount: 6,
        totalAmountCents: '20000',
      }),
    );
    expect(result.selected?.subagents[0]).toEqual(
      expect.objectContaining({
        ownAmountCents: '0',
        contributionAmountCents: '7000',
      }),
    );
    expect(result.selected?.downline).toEqual([
      expect.objectContaining({
        agentId: 'agent-b',
        parentAgentId: 'agent-a',
        amountCents: '0',
        selfTurnoverCents: '200000',
      }),
      expect.objectContaining({
        agentId: 'agent-c',
        parentAgentId: 'agent-b',
        amountCents: '5000',
        selfAmountCents: '5000',
      }),
    ]);
    expect(result.selected?.pool).toEqual(
      expect.objectContaining({
        turnoverCents: '1000000',
        expenseCents: '25000',
        netPoolCents: '100000',
        generatedDate: '2026-08-19',
      }),
    );
    expect(result.selected?.mine.directTurnoverCents).toBe('100000');
    expect(result.profile.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.selected?.players).toHaveLength(50);
    expect(result.selected?.playersNextCursor).toBe('player-49');
    expect(mocks.prisma.profitPoolAgentSnapshot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { pool: { generatedAt: 'desc' } },
          { poolId: 'desc' },
        ],
        take: 51,
      }),
    );
  });

  it('returns live team totals even before the agent has any batch snapshot', async () => {
    mocks.prisma.profitPoolAgentSnapshot.findMany.mockResolvedValue([]);

    const result = await getAgentSelfDashboard('user-a');

    expect(result.selected).toBeNull();
    expect(result.profile).toEqual(
      expect.objectContaining({
        directAgentCount: 1,
        teamAgentCount: 2,
        directPlayerCount: 2,
        teamPlayerCount: 6,
      }),
    );
  });
});

describe('collectDownlineSnapshots', () => {
  it('keeps only the viewer tree and excludes the viewer and other lines', () => {
    const rows = [
      { sourceAgentId: 'a', parentSourceAgentId: null },
      { sourceAgentId: 'b', parentSourceAgentId: 'a' },
      { sourceAgentId: 'c', parentSourceAgentId: 'b' },
      { sourceAgentId: 'x', parentSourceAgentId: null },
      { sourceAgentId: 'y', parentSourceAgentId: 'x' },
    ];
    expect(collectDownlineSnapshots(rows, 'a').map((row) => row.sourceAgentId)).toEqual([
      'b',
      'c',
    ]);
    expect(collectDownlineSnapshots(rows, 'x').map((row) => row.sourceAgentId)).toEqual(['y']);
  });
});
