import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    profitPoolDaily: { count: vi.fn() },
    profitPoolSequence: { upsert: vi.fn() },
    profitPoolBatch: {
      create: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    profitPoolRoundLock: { createMany: vi.fn(), deleteMany: vi.fn() },
    wallet: { findMany: vi.fn() },
    profitPoolAgentSnapshot: { createMany: vi.fn(), deleteMany: vi.fn() },
    profitPoolPlayerSnapshot: { createMany: vi.fn(), deleteMany: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return {
    tx,
    computeProfitPoolRange: vi.fn(),
    transfer: vi.fn(),
    sendCustom: vi.fn(),
  };
});

vi.mock('../lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../lib/transaction.js', () => ({
  serializable: vi.fn(async (run: (tx: typeof mocks.tx) => unknown) => run(mocks.tx)),
}));
vi.mock('./profitPoolRange.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./profitPoolRange.js')>();
  return {
    ...actual,
    computeProfitPoolRange: mocks.computeProfitPoolRange,
  };
});
vi.mock('./wallet.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./wallet.js')>();
  return {
    ...actual,
    transfer: mocks.transfer,
  };
});
vi.mock('./push.js', () => ({
  pushService: { sendCustom: mocks.sendCustom },
}));

import {
  buildProfitPoolCode,
  discardProfitPoolBatch,
  deleteProfitPoolBatch,
  distributeProfitPoolBatch,
  generateProfitPoolBatch,
} from './profitPoolBatches.js';

const HASH = 'a'.repeat(64);

function computation() {
  return {
    room: { id: 'room-1', title: '至尊厅', gameCode: 'SUPREME_NIUNIU' },
    startSeqNo: 101,
    endSeqNo: 102,
    roundCount: 2,
    finishedRoundCount: 1,
    cancelledRoundCount: 1,
    rounds: [
      {
        id: 'round-101',
        seqNo: 101,
        phase: 'FINISHED',
        finishedAt: new Date('2026-08-19T00:00:00Z'),
      },
      {
        id: 'round-102',
        seqNo: 102,
        phase: 'CANCELLED',
        finishedAt: new Date('2026-08-19T00:01:00Z'),
      },
    ],
    expenseBps: 250,
    expenseCents: 5_000n,
    netPoolCents: 20_000n,
    bucketBase: 130,
    distributedCents: 10_000n,
    residualCents: 10_000n,
    companyRemainingPointsHundredths: 6_500,
    financials: {
      turnoverPlayerCents: 100_000n,
      turnoverBankerCents: 100_000n,
      turnoverCents: 200_000n,
      rakePlayerCents: 10_000n,
      rakeBankerCents: 15_000n,
      rakeTotalCents: 25_000n,
      turnoverByUser: new Map([['agent-user', 100_000n]]),
    },
    agents: [
      {
        agentId: 'agent-1',
        userId: 'agent-user',
        parentAgentId: null,
        label: '一级代理',
        uid: 'AG1001',
        nickname: '代理甲',
        avatarUrl: null,
        level: 1,
        status: 'ACTIVE',
        sharePoints: 65,
        directAgentCount: 0,
        teamAgentCount: 0,
        directPlayerCount: 1,
        teamPlayerCount: 1,
        selfTurnoverCents: 100_000n,
        teamTurnoverCents: 100_000n,
        contributionBp: 5_000,
        selfAmountCents: 10_000n,
        overrideAmountCents: 0n,
        amountCents: 10_000n,
        breakdown: [],
      },
    ],
    players: [
      {
        agentId: 'agent-1',
        userId: 'player-1',
        uid: 'P1001',
        nickname: '玩家甲',
        avatarUrl: null,
        bindingSource: 'MANUAL',
        isAgentSelf: false,
        turnoverCents: 100_000n,
        profitCents: 10_000n,
      },
    ],
    calculationHash: HASH,
  };
}

describe('profit pool batch codes', () => {
  it('prefixes the daily serial with the catalog game code', () => {
    expect(buildProfitPoolCode('ZZNN', '2026-08-22', 3)).toBe('ZZNN202608220003');
    expect(buildProfitPoolCode('TB', '2026-08-22', 3)).toBe('TB202608220003');
  });
});

describe('round-range profit pool batch lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tx.profitPoolDaily.count.mockResolvedValue(0);
    mocks.tx.profitPoolSequence.upsert.mockResolvedValue({ value: 7 });
    mocks.tx.profitPoolBatch.create.mockImplementation(async ({ data }) => ({
      id: 'pool-1',
      ...data,
    }));
    mocks.tx.profitPoolBatch.findUniqueOrThrow.mockResolvedValue({
      id: 'pool-1',
      poolCode: 'TB202608190007',
      roomId: 'room-1',
      agentSnapshots: [],
    });
    mocks.tx.profitPoolRoundLock.createMany.mockResolvedValue({ count: 2 });
    mocks.tx.profitPoolRoundLock.deleteMany.mockResolvedValue({ count: 2 });
    mocks.tx.wallet.findMany.mockResolvedValue([]);
    mocks.tx.profitPoolAgentSnapshot.createMany.mockResolvedValue({ count: 1 });
    mocks.tx.profitPoolPlayerSnapshot.createMany.mockResolvedValue({ count: 1 });
    mocks.tx.auditLog.create.mockResolvedValue({ id: 'audit-1' });
    mocks.computeProfitPoolRange.mockResolvedValue(computation());
    mocks.transfer.mockResolvedValue(undefined);
    mocks.sendCustom.mockResolvedValue(undefined);
  });

  it('recomputes, permanently locks rounds, and stores complete snapshots atomically', async () => {
    await generateProfitPoolBatch({
      roomId: 'room-1',
      startSeqNo: 101,
      endSeqNo: 102,
      expenseBps: 250,
      calculationHash: HASH,
      actorId: 'admin-1',
    });

    expect(mocks.computeProfitPoolRange).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: 'room-1',
        startSeqNo: 101,
        endSeqNo: 102,
        expenseBps: 250,
      }),
      mocks.tx,
    );
    expect(mocks.tx.profitPoolSequence.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: expect.stringMatching(/^PROFIT_POOL:ZZNN:\d{8}$/) },
      }),
    );
    expect(mocks.tx.profitPoolBatch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        poolCode: expect.stringMatching(/^ZZNN\d{12}$/),
        roomId: 'room-1',
        startSeqNo: 101,
        endSeqNo: 102,
        status: 'PENDING',
        calculationHash: HASH,
      }),
    });
    expect(mocks.tx.profitPoolRoundLock.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ poolId: 'pool-1', roundId: 'round-101', seqNo: 101 }),
        expect.objectContaining({ poolId: 'pool-1', roundId: 'round-102', seqNo: 102 }),
      ],
    });
    expect(mocks.tx.profitPoolAgentSnapshot.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          sourceAgentId: 'agent-1',
          parentSourceAgentId: null,
          amountCents: 10_000n,
          ledgerRef: expect.stringMatching(/^profit-share:ZZNN\d{12}:agent-1$/),
        }),
      ],
    });
    expect(mocks.tx.profitPoolPlayerSnapshot.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          sourceAgentId: 'agent-1',
          userId: 'player-1',
          turnoverCents: 100_000n,
        }),
      ],
    });
    expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        adminId: 'admin-1',
        action: 'PROFIT_POOL_BATCH_GENERATED',
        target: 'pool-1',
      }),
    });
  });

  it('rejects a stale preview before creating or locking a batch', async () => {
    mocks.computeProfitPoolRange.mockResolvedValue({
      ...computation(),
      calculationHash: 'b'.repeat(64),
    });

    await expect(
      generateProfitPoolBatch({
        roomId: 'room-1',
        startSeqNo: 101,
        endSeqNo: 102,
        expenseBps: 250,
        calculationHash: HASH,
        actorId: 'admin-1',
      }),
    ).rejects.toThrow('PREVIEW_STALE');

    expect(mocks.tx.profitPoolBatch.create).not.toHaveBeenCalled();
    expect(mocks.tx.profitPoolRoundLock.createMany).not.toHaveBeenCalled();
  });

  it('blocks cutover while a legacy daily report remains pending', async () => {
    mocks.tx.profitPoolDaily.count.mockResolvedValue(1);

    await expect(
      generateProfitPoolBatch({
        roomId: 'room-1',
        startSeqNo: 101,
        endSeqNo: 102,
        expenseBps: 250,
        calculationHash: HASH,
        actorId: 'admin-1',
      }),
    ).rejects.toThrow('LEGACY_PENDING_EXISTS');

    expect(mocks.computeProfitPoolRange).not.toHaveBeenCalled();
  });

  it('locks and archives a non-positive pool without making it distributable', async () => {
    mocks.computeProfitPoolRange.mockResolvedValue({
      ...computation(),
      netPoolCents: -5_000n,
      distributedCents: 0n,
      residualCents: 0n,
      agents: [],
      players: [],
    });

    await generateProfitPoolBatch({
      roomId: 'room-1',
      startSeqNo: 101,
      endSeqNo: 102,
      expenseBps: 250,
      calculationHash: HASH,
      actorId: 'admin-1',
    });

    expect(mocks.tx.profitPoolBatch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'NO_DISTRIBUTION' }),
    });
    expect(mocks.tx.profitPoolRoundLock.createMany).toHaveBeenCalledOnce();
    expect(mocks.tx.profitPoolAgentSnapshot.createMany).not.toHaveBeenCalled();
  });

  it('translates a concurrent round-lock collision into a range overlap error', async () => {
    mocks.tx.profitPoolRoundLock.createMany.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate round lock', {
        code: 'P2002',
        clientVersion: '6.19.3',
        meta: { target: ['round_id'] },
      }),
    );

    await expect(
      generateProfitPoolBatch({
        roomId: 'room-1',
        startSeqNo: 101,
        endSeqNo: 102,
        expenseBps: 250,
        calculationHash: HASH,
        actorId: 'admin-1',
      }),
    ).rejects.toThrow('RANGE_OVERLAP');
  });

  it('translates PostgreSQL exclusion conflicts surfaced as unknown Prisma errors', async () => {
    mocks.tx.profitPoolBatch.create.mockRejectedValueOnce(
      new Error(
        'conflicting key value violates exclusion constraint "profit_pool_batches_room_seq_range_excl"',
      ),
    );

    await expect(
      generateProfitPoolBatch({
        roomId: 'room-1',
        startSeqNo: 101,
        endSeqNo: 102,
        expenseBps: 250,
        calculationHash: HASH,
        actorId: 'admin-1',
      }),
    ).rejects.toThrow('RANGE_OVERLAP');
  });

  it('translates the old continuous-range count check into a batch constraint error', async () => {
    mocks.tx.profitPoolBatch.create.mockRejectedValueOnce(
      new Error(
        'new row for relation "profit_pool_batches" violates check constraint "profit_pool_batches_round_count_check"',
      ),
    );

    await expect(
      generateProfitPoolBatch({
        roomId: 'room-1',
        startSeqNo: 101,
        endSeqNo: 102,
        expenseBps: 250,
        calculationHash: HASH,
        actorId: 'admin-1',
      }),
    ).rejects.toThrow('BATCH_COUNT_CONSTRAINT');
  });

  it('uses the frozen ledger key and a status CAS for one-time distribution', async () => {
    const batch = {
      id: 'pool-1',
      poolCode: 'TB202608190007',
      status: 'PENDING',
      startSeqNo: 101,
      endSeqNo: 102,
      netPoolCents: 20_000n,
      distributedCents: 10_000n,
      agentSnapshots: [
        {
          sourceAgentId: 'agent-1',
          userId: 'agent-user',
          amountCents: 10_000n,
          sharePointsSnapshot: 65,
          bucketBaseSnapshot: 130,
          ledgerRef: 'profit-share:TB202608190007:agent-1',
        },
      ],
    };
    mocks.tx.profitPoolBatch.findUnique.mockResolvedValue(batch);
    mocks.tx.profitPoolBatch.updateMany.mockResolvedValue({ count: 1 });

    const result = await distributeProfitPoolBatch('pool-1', 'admin-1');
    expect(result).toEqual(
      expect.objectContaining({
        id: 'pool-1',
        status: 'DISTRIBUTED',
        distributedBy: 'admin-1',
      }),
    );
    expect(result).not.toHaveProperty('agentSnapshots');

    expect(mocks.tx.profitPoolBatch.updateMany).toHaveBeenCalledWith({
      where: { id: 'pool-1', status: 'PENDING' },
      data: expect.objectContaining({
        status: 'DISTRIBUTED',
        distributedBy: 'admin-1',
      }),
    });
    expect(mocks.transfer).toHaveBeenCalledOnce();
    expect(mocks.transfer).toHaveBeenCalledWith(
      mocks.tx,
      expect.objectContaining({
        amountCents: 10_000n,
        refType: 'profit_share',
        refId: 'agent-1',
        idempotencyKey: 'profit-share:TB202608190007:agent-1',
      }),
    );
    expect(mocks.sendCustom).toHaveBeenCalledWith(
      'agent-user',
      expect.stringContaining('TB202608190007'),
    );
    expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        adminId: 'admin-1',
        action: 'PROFIT_POOL_BATCH_DISTRIBUTED',
        target: 'pool-1',
      }),
    });
  });

  it('does not transfer when another request wins the distribution CAS', async () => {
    mocks.tx.profitPoolBatch.findUnique.mockResolvedValue({
      id: 'pool-1',
      poolCode: 'TB202608190007',
      status: 'PENDING',
      netPoolCents: 20_000n,
      distributedCents: 10_000n,
      agentSnapshots: [{ amountCents: 10_000n }],
    });
    mocks.tx.profitPoolBatch.updateMany.mockResolvedValue({ count: 0 });

    await expect(distributeProfitPoolBatch('pool-1', 'admin-1')).resolves.toBeNull();
    expect(mocks.transfer).not.toHaveBeenCalled();
  });

  it('refuses payout when frozen snapshot totals do not match the batch', async () => {
    mocks.tx.profitPoolBatch.findUnique.mockResolvedValue({
      id: 'pool-1',
      poolCode: 'TB202608190007',
      status: 'PENDING',
      netPoolCents: 10_000n,
      distributedCents: 10_000n,
      agentSnapshots: [{ amountCents: 11_000n }],
    });

    await expect(
      distributeProfitPoolBatch('pool-1', 'admin-1'),
    ).rejects.toThrow('DISTRIBUTION_SNAPSHOT_MISMATCH');
    expect(mocks.tx.profitPoolBatch.updateMany).not.toHaveBeenCalled();
    expect(mocks.transfer).not.toHaveBeenCalled();
  });

  it('treats a repeated request for an already distributed batch as a no-op', async () => {
    mocks.tx.profitPoolBatch.findUnique.mockResolvedValue({
      id: 'pool-1',
      status: 'DISTRIBUTED',
      agentSnapshots: [{ amountCents: 10_000n }],
    });

    await expect(distributeProfitPoolBatch('pool-1', 'admin-1')).resolves.toBeNull();
    expect(mocks.tx.profitPoolBatch.updateMany).not.toHaveBeenCalled();
    expect(mocks.transfer).not.toHaveBeenCalled();
  });

  it('voids a pending batch, deletes round locks, and keeps the snapshot', async () => {
    mocks.tx.profitPoolBatch.findUnique.mockResolvedValue({
      id: 'pool-1',
      poolCode: 'TB202608190007',
      status: 'PENDING',
      roomId: 'room-1',
      startSeqNo: 101,
      endSeqNo: 102,
      netPoolCents: 20_000n,
    });
    mocks.tx.profitPoolBatch.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.profitPoolBatch.findUniqueOrThrow.mockResolvedValue({
      id: 'pool-1',
      poolCode: 'TB202608190007',
      status: 'VOIDED',
      room: { id: 'room-1', title: '至尊厅', gameCode: 'SUPREME_NIUNIU' },
    });

    const result = await discardProfitPoolBatch('pool-1', 'admin-1');
    expect(result.status).toBe('VOIDED');
    expect(mocks.tx.profitPoolBatch.updateMany).toHaveBeenCalledWith({
      where: { id: 'pool-1', status: 'PENDING' },
      data: expect.objectContaining({
        status: 'VOIDED',
        discardedBy: 'admin-1',
      }),
    });
    expect(mocks.tx.profitPoolRoundLock.deleteMany).toHaveBeenCalledWith({
      where: { poolId: 'pool-1' },
    });
    expect(mocks.tx.profitPoolAgentSnapshot.createMany).not.toHaveBeenCalled();
    expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        adminId: 'admin-1',
        action: 'PROFIT_POOL_BATCH_VOIDED',
        target: 'pool-1',
      }),
    });
  });

  it('force-voids a distributed batch by clawing funds back to the platform pool', async () => {
    mocks.tx.profitPoolBatch.findUnique.mockResolvedValue({
      id: 'pool-1',
      poolCode: 'TB202608190007',
      status: 'DISTRIBUTED',
      roomId: 'room-1',
      startSeqNo: 101,
      endSeqNo: 102,
      netPoolCents: 20_000n,
      agentSnapshots: [
        {
          sourceAgentId: 'agent-1',
          userId: 'agent-user',
          label: '一级代理',
          uid: 'AG1001',
          amountCents: 10_000n,
        },
      ],
    });
    mocks.tx.wallet.findMany.mockResolvedValue([
      { userId: 'agent-user', availableCents: 10_000n },
    ]);
    mocks.tx.profitPoolBatch.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.profitPoolBatch.findUniqueOrThrow.mockResolvedValue({
      id: 'pool-1',
      poolCode: 'TB202608190007',
      status: 'VOIDED',
      room: { id: 'room-1', title: '至尊厅', gameCode: 'SUPREME_NIUNIU' },
    });

    const result = await discardProfitPoolBatch('pool-1', 'admin-1');
    expect(result.status).toBe('VOIDED');
    expect(mocks.transfer).toHaveBeenCalledWith(
      mocks.tx,
      expect.objectContaining({
        amountCents: 10_000n,
        from: { userId: 'agent-user', accountType: 'USER_AVAILABLE' },
        to: { accountType: 'PLATFORM_PROFIT_POOL' },
        refType: 'profit_share_clawback',
        idempotencyKey: 'profit-share-clawback:TB202608190007:agent-1',
      }),
    );
    expect(mocks.tx.profitPoolRoundLock.deleteMany).toHaveBeenCalledWith({
      where: { poolId: 'pool-1' },
    });
    expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'PROFIT_POOL_BATCH_FORCE_VOIDED',
      }),
    });
    expect(mocks.sendCustom).toHaveBeenCalledWith(
      'agent-user',
      expect.stringContaining('强制撤回'),
    );
  });

  it('refuses a forced clawback when an agent no longer has enough available balance', async () => {
    mocks.tx.profitPoolBatch.findUnique.mockResolvedValue({
      id: 'pool-1',
      poolCode: 'TB202608190007',
      status: 'DISTRIBUTED',
      agentSnapshots: [
        {
          sourceAgentId: 'agent-1',
          userId: 'agent-user',
          label: '一级代理',
          uid: 'AG1001',
          amountCents: 10_000n,
        },
      ],
    });
    mocks.tx.wallet.findMany.mockResolvedValue([
      {
        userId: 'agent-user',
        availableCents: 1_000n,
        freezeBankerCents: 0n,
        freezeBetCents: 0n,
        freezeWithdrawCents: 0n,
      },
    ]);

    await expect(discardProfitPoolBatch('pool-1', 'admin-1')).rejects.toThrow(
      'CLAWBACK_INSUFFICIENT_BALANCE',
    );
    expect(mocks.transfer).not.toHaveBeenCalled();
    expect(mocks.tx.profitPoolRoundLock.deleteMany).not.toHaveBeenCalled();
  });

  it('reports frozen banker funds when forced clawback cannot take available balance', async () => {
    mocks.tx.profitPoolBatch.findUnique.mockResolvedValue({
      id: 'pool-1',
      poolCode: 'TB202608190007',
      status: 'DISTRIBUTED',
      agentSnapshots: [
        {
          sourceAgentId: 'agent-1',
          userId: 'agent-user',
          label: '一级代理',
          uid: 'AG1001',
          amountCents: 10_000n,
        },
      ],
    });
    mocks.tx.wallet.findMany.mockResolvedValue([
      {
        userId: 'agent-user',
        availableCents: 1_000n,
        freezeBankerCents: 9_000n,
        freezeBetCents: 0n,
        freezeWithdrawCents: 0n,
      },
    ]);

    await expect(discardProfitPoolBatch('pool-1', 'admin-1')).rejects.toMatchObject({
      code: 'CLAWBACK_INSUFFICIENT_BALANCE',
      details: {
        agents: [
          expect.objectContaining({
            uid: 'AG1001',
            availableCents: '1000',
            frozenCents: '9000',
          }),
        ],
      },
    });
    expect(mocks.transfer).not.toHaveBeenCalled();
    expect(mocks.tx.profitPoolRoundLock.deleteMany).not.toHaveBeenCalled();
  });

  it('hard-deletes a voided batch together with snapshots and leftover locks', async () => {
    mocks.tx.profitPoolBatch.findUnique.mockResolvedValue({
      id: 'pool-1',
      poolCode: 'TB202608190007',
      status: 'VOIDED',
      roomId: 'room-1',
      startSeqNo: 101,
      endSeqNo: 102,
    });
    mocks.tx.profitPoolBatch.deleteMany.mockResolvedValue({ count: 1 });

    await expect(deleteProfitPoolBatch('pool-1', 'admin-1')).resolves.toEqual({
      id: 'pool-1',
      poolCode: 'TB202608190007',
    });
    expect(mocks.tx.profitPoolRoundLock.deleteMany).toHaveBeenCalledWith({
      where: { poolId: 'pool-1' },
    });
    expect(mocks.tx.profitPoolPlayerSnapshot.deleteMany).toHaveBeenCalledWith({
      where: { poolId: 'pool-1' },
    });
    expect(mocks.tx.profitPoolAgentSnapshot.deleteMany).toHaveBeenCalledWith({
      where: { poolId: 'pool-1' },
    });
    expect(mocks.tx.profitPoolBatch.deleteMany).toHaveBeenCalledWith({
      where: { id: 'pool-1', status: 'VOIDED' },
    });
    expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        adminId: 'admin-1',
        action: 'PROFIT_POOL_BATCH_DELETED',
        target: 'pool-1',
      }),
    });
  });

  it('refuses to delete a batch that has not been voided', async () => {
    mocks.tx.profitPoolBatch.findUnique.mockResolvedValue({
      id: 'pool-1',
      poolCode: 'TB202608190007',
      status: 'PENDING',
    });

    await expect(deleteProfitPoolBatch('pool-1', 'admin-1')).rejects.toThrow(
      'POOL_NOT_DELETABLE',
    );
    expect(mocks.tx.profitPoolBatch.deleteMany).not.toHaveBeenCalled();
  });
});
