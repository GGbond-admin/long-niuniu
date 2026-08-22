import { describe, expect, it } from 'vitest';
import {
  aggregateRangeFinancials,
  computeProfitPoolRange,
  computeHierarchyMetrics,
  expenseFromBps,
  type RangeRoundRow,
} from './profitPoolRange.js';

function round(
  seqNo: number,
  options: Partial<RangeRoundRow> = {},
): RangeRoundRow {
  return {
    id: `round-${seqNo}`,
    seqNo,
    phase: 'FINISHED',
    bankerId: 'banker',
    configSnapshot: { rebate: { includeTieBets: false } },
    finishedAt: new Date(`2026-08-19T00:00:0${seqNo}Z`),
    settlements: [],
    ...options,
  };
}

describe('round-range profit pool calculations', () => {
  it('uses exact basis points and half-up cent rounding for company expenses', () => {
    expect(expenseFromBps(100_000_000n, 100)).toBe(1_000_000n);
    expect(expenseFromBps(10_000_000n, 250)).toBe(250_000n);
    expect(expenseFromBps(101n, 5_000)).toBe(51n);
  });

  it('rejects invalid expense basis points', () => {
    expect(() => expenseFromBps(100n, -1)).toThrow('INVALID_EXPENSE_RATIO');
    expect(() => expenseFromBps(100n, 10_001)).toThrow('INVALID_EXPENSE_RATIO');
    expect(() => expenseFromBps(100n, 1.5)).toThrow('INVALID_EXPENSE_RATIO');
  });

  it('aggregates player and banker turnover and splits rake by winner', () => {
    const result = aggregateRangeFinancials(
      [
        round(1, {
          settlements: [
            {
              userId: 'p1',
              betCents: 10_000n,
              outcome: 'PLAYER_WIN',
              rakeCents: 300n,
            },
            {
              userId: 'p2',
              betCents: 20_000n,
              outcome: 'BANKER_WIN',
              rakeCents: 1_000n,
            },
            {
              userId: 'p3',
              betCents: 30_000n,
              outcome: 'TIE',
              rakeCents: 0n,
            },
          ],
        }),
        round(2, { phase: 'CANCELLED', bankerId: null, configSnapshot: null }),
      ],
      new Map([
        ['banker', 'HUMAN'],
        ['p1', 'HUMAN'],
        ['p2', 'HUMAN'],
        ['p3', 'HUMAN'],
      ]),
    );

    expect(result.turnoverPlayerCents).toBe(30_000n);
    expect(result.turnoverBankerCents).toBe(30_000n);
    expect(result.turnoverCents).toBe(60_000n);
    expect(result.rakePlayerCents).toBe(300n);
    expect(result.rakeBankerCents).toBe(1_000n);
    expect(result.rakeTotalCents).toBe(1_300n);
    expect(result.turnoverByUser).toEqual(
      new Map([
        ['p1', 10_000n],
        ['p2', 20_000n],
        ['banker', 30_000n],
      ]),
    );
  });

  it('adds round-level banker profit rake from the scoreboard and keeps legacy pair rake', () => {
    const result = aggregateRangeFinancials(
      [
        round(1, {
          bankerRakeCents: 2_500n,
          settlements: [
            { userId: 'p1', betCents: 10_000n, outcome: 'BANKER_WIN', rakeCents: 0n },
            { userId: 'p2', betCents: 20_000n, outcome: 'PLAYER_WIN', rakeCents: 600n },
          ],
        }),
        round(2, {
          settlements: [
            { userId: 'p3', betCents: 8_000n, outcome: 'BANKER_WIN', rakeCents: 400n },
          ],
        }),
      ],
      new Map([
        ['banker', 'HUMAN'],
        ['p1', 'HUMAN'],
        ['p2', 'HUMAN'],
        ['p3', 'HUMAN'],
      ]),
    );

    expect(result.rakePlayerCents).toBe(600n);
    expect(result.rakeBankerCents).toBe(2_900n);
    expect(result.rakeTotalCents).toBe(3_500n);
  });

  it('honors per-round tie configuration and excludes virtual users from user turnover', () => {
    const result = aggregateRangeFinancials(
      [
        round(1, {
          configSnapshot: { rebate: { includeTieBets: true } },
          settlements: [
            { userId: 'human', betCents: 100n, outcome: 'TIE', rakeCents: 0n },
            { userId: 'virtual', betCents: 200n, outcome: 'TIE', rakeCents: 0n },
          ],
        }),
      ],
      new Map([
        ['banker', 'HUMAN'],
        ['human', 'HUMAN'],
        ['virtual', 'VIRTUAL'],
      ]),
    );

    expect(result.turnoverPlayerCents).toBe(100n);
    // 庄家口径计本局全部有效对赌注，即使对手为虚拟玩家。
    expect(result.turnoverBankerCents).toBe(300n);
    expect(result.turnoverByUser.get('virtual')).toBeUndefined();
    expect(result.turnoverByUser.get('banker')).toBe(300n);
  });
});

describe('agent hierarchy metrics', () => {
  it('computes direct and recursive agent/player counts at arbitrary depth', () => {
    const metrics = computeHierarchyMetrics([
      { id: 'a', parentAgentId: null, directPlayerCount: 2 },
      { id: 'b', parentAgentId: 'a', directPlayerCount: 3 },
      { id: 'c', parentAgentId: 'b', directPlayerCount: 5 },
      { id: 'd', parentAgentId: 'a', directPlayerCount: 7 },
    ]);

    expect(metrics.get('a')).toEqual({
      level: 1,
      directAgentCount: 2,
      teamAgentCount: 3,
      directPlayerCount: 2,
      teamPlayerCount: 17,
    });
    expect(metrics.get('b')).toEqual({
      level: 2,
      directAgentCount: 1,
      teamAgentCount: 1,
      directPlayerCount: 3,
      teamPlayerCount: 8,
    });
    expect(metrics.get('c')?.level).toBe(3);
    expect(metrics.get('d')?.teamAgentCount).toBe(0);
  });
});

describe('round-range validation against persisted rounds', () => {
  function dbWith(options: {
    rounds: RangeRoundRow[];
    cutover?: { maxSeqNo: number } | null;
    locked?: { seqNo: number; pool: { poolCode: string } } | null;
    bucketBase?: number;
    agents?: Array<Record<string, unknown>>;
  }) {
    return {
      room: {
        findUnique: async () => ({
          id: 'room-1',
          title: '至尊厅',
          gameCode: 'SUPREME_NIUNIU',
        }),
      },
      profitPoolCutover: {
        findUnique: async () => options.cutover ?? null,
      },
      round: {
        findMany: async () => options.rounds,
      },
      profitPoolRoundLock: {
        findFirst: async () => options.locked ?? null,
      },
      gameConfig: {
        findUnique: async () => ({ value: { bucketBase: options.bucketBase ?? 130 } }),
      },
      user: { findMany: async () => [] },
      agent: { findMany: async () => options.agents ?? [] },
    };
  }

  it('rejects sequence numbers outside the database integer range', async () => {
    await expect(
      computeProfitPoolRange(
        {
          roomId: 'room-1',
          startSeqNo: 2_147_483_648,
          endSeqNo: 2_147_483_648,
          expenseBps: 0,
        },
        dbWith({ rounds: [] }) as never,
      ),
    ).rejects.toThrow('SEQ_RANGE_INVALID');
  });

  it('includes the current bucket base in the preview fingerprint', async () => {
    const input = { roomId: 'room-1', startSeqNo: 1, endSeqNo: 1, expenseBps: 0 };
    const first = await computeProfitPoolRange(
      input,
      dbWith({ rounds: [round(1)], bucketBase: 130 }) as never,
    );
    const changed = await computeProfitPoolRange(
      input,
      dbWith({ rounds: [round(1)], bucketBase: 140 }) as never,
    );

    expect(changed.calculationHash).not.toBe(first.calculationHash);
  });

  it('rejects an agent tree that violates the configured reserve gap', async () => {
    const user = (id: string) => ({
      id: `user-${id}`,
      uid: `UID-${id}`,
      nickname: id,
      avatarUrl: null,
    });
    await expect(
      computeProfitPoolRange(
        { roomId: 'room-1', startSeqNo: 1, endSeqNo: 1, expenseBps: 0 },
        dbWith({
          rounds: [round(1)],
          agents: [
            {
              id: 'parent',
              userId: 'user-parent',
              parentAgentId: null,
              label: 'parent',
              status: 'ACTIVE',
              sharePoints: 95,
              createdAt: new Date(),
              user: user('parent'),
              players: [],
            },
            {
              id: 'child',
              userId: 'user-child',
              parentAgentId: 'parent',
              label: 'child',
              status: 'ACTIVE',
              sharePoints: 105,
              createdAt: new Date(),
              user: user('child'),
              players: [],
            },
          ],
        }) as never,
      ),
    ).rejects.toThrow('INVALID_AGENT_HIERARCHY');
  });

  it('settles finished rounds when cancelled or missing sequence numbers sit in the range', async () => {
    const result = await computeProfitPoolRange(
      { roomId: 'room-1', startSeqNo: 1, endSeqNo: 4, expenseBps: 0 },
      dbWith({
        rounds: [
          round(1),
          round(2, { phase: 'CANCELLED', bankerId: null, configSnapshot: null }),
          round(4, { phase: 'WAITING', bankerId: null, configSnapshot: null, finishedAt: null }),
        ],
      }) as never,
    );

    expect(result.startSeqNo).toBe(1);
    expect(result.endSeqNo).toBe(1);
    expect(result.roundCount).toBe(1);
    expect(result.finishedRoundCount).toBe(1);
    expect(result.cancelledRoundCount).toBe(1);
    expect(result.rounds.map((item) => item.seqNo)).toEqual([1]);
  });

  it('prefers a reopened finished round over a cancelled round with the same sequence number', async () => {
    const result = await computeProfitPoolRange(
      { roomId: 'room-1', startSeqNo: 18, endSeqNo: 18, expenseBps: 0 },
      dbWith({
        rounds: [
          round(18, {
            id: 'cancelled-18',
            phase: 'CANCELLED',
            bankerId: null,
            configSnapshot: null,
          }),
          round(18, { id: 'finished-18', finishedAt: new Date('2026-08-19T00:00:18Z') }),
        ],
      }) as never,
    );

    expect(result.rounds).toEqual([
      expect.objectContaining({ id: 'finished-18', seqNo: 18, phase: 'FINISHED' }),
    ]);
  });

  it('rejects a range that has no finished rounds', async () => {
    await expect(
      computeProfitPoolRange(
        { roomId: 'room-1', startSeqNo: 1, endSeqNo: 2, expenseBps: 0 },
        dbWith({
          rounds: [round(1, { phase: 'CANCELLED', bankerId: null, configSnapshot: null })],
        }) as never,
      ),
    ).rejects.toThrow('ROUND_RANGE_INCOMPLETE');
  });

  it('rejects non-terminal rounds before calculating money', async () => {
    await expect(
      computeProfitPoolRange(
        { roomId: 'room-1', startSeqNo: 1, endSeqNo: 1, expenseBps: 0 },
        dbWith({ rounds: [round(1, { phase: 'BETTING' })] }) as never,
      ),
    ).rejects.toThrow('ROUNDS_NOT_TERMINAL');
  });

  it('rejects legacy cutover and already locked ranges', async () => {
    await expect(
      computeProfitPoolRange(
        { roomId: 'room-1', startSeqNo: 5, endSeqNo: 5, expenseBps: 0 },
        dbWith({ rounds: [round(5)], cutover: { maxSeqNo: 5 } }) as never,
      ),
    ).rejects.toThrow('CUTOVER_SEQ_BLOCKED');

    await expect(
      computeProfitPoolRange(
        { roomId: 'room-1', startSeqNo: 6, endSeqNo: 6, expenseBps: 0 },
        dbWith({
          rounds: [round(6)],
          locked: { seqNo: 6, pool: { poolCode: 'TB202608190001' } },
        }) as never,
      ),
    ).rejects.toThrow('RANGE_OVERLAP');
  });
});
