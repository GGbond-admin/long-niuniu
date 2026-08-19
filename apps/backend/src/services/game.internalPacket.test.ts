import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 系统红包（至尊牛牛小助手发送）：发包、抢包拆分入账、防重复与资格校验。
 */
const memory = vi.hoisted(() => {
  const state = {
    round: {
      id: 'round-1',
      roomId: 'room-1',
      phase: 'SENDING_PACKET',
      bankerId: 'banker-1',
      bankerReservedCents: 0n,
      claimEndsAt: null as Date | null,
      version: 1,
      configSnapshot: { round: { claimDurationSeconds: 30 } },
    },
    packet: {
      id: 'packet-1',
      roundId: 'round-1',
      channel: 'TNG',
      claimUrl: null as string | null,
      status: 'CREATED',
      totalCents: 1_000n,
      participantCount: 3,
      sentAt: null as Date | null,
      expiresAt: null as Date | null,
    },
    claims: [] as Array<{
      id: string;
      userId: string;
      amountCents: bigint;
      source: string;
    }>,
    bets: new Map<string, { status: string }>([
      ['player-1', { status: 'FROZEN' }],
      ['player-2', { status: 'FROZEN' }],
    ]),
    diceReady: false,
    events: [] as Array<{ type: string; payload?: unknown }>,
    transfers: [] as Array<Record<string, unknown>>,
    claimSeq: 0,
  };
  return state;
});

const tx = vi.hoisted(() => ({
  round: {
    findUnique: vi.fn(async () => ({
      ...memory.round,
      packet: { ...memory.packet },
      bets: [],
      _count: { claims: memory.claims.length },
    })),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const { version, ...rest } = data;
      Object.assign(memory.round, rest);
      return { ...memory.round };
    }),
  },
  roundEvent: {
    findFirst: vi.fn(async () => (memory.diceReady ? { id: 'event-dice' } : null)),
    create: vi.fn(async ({ data }: { data: { type: string; payload?: unknown } }) => {
      memory.events.push({ type: data.type, payload: data.payload });
      return { id: `event-${memory.events.length}` };
    }),
  },
  packet: {
    findUnique: vi.fn(async () => ({
      ...memory.packet,
      round: { ...memory.round, claims: memory.claims.map((claim) => ({ ...claim })) },
    })),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (
        typeof data.participantCount === 'object'
        && data.participantCount !== null
        && 'decrement' in data.participantCount
      ) {
        memory.packet.participantCount -= Number(data.participantCount.decrement);
        const { participantCount: _participantCount, ...rest } = data;
        Object.assign(memory.packet, rest);
        return { ...memory.packet };
      }
      Object.assign(memory.packet, data);
      return { ...memory.packet };
    }),
  },
  bet: {
    findUnique: vi.fn(
      async ({ where }: { where: { roundId_userId: { userId: string } } }) => {
        const userId = where.roundId_userId.userId;
        const row = memory.bets.get(userId);
        return row ? { id: `bet-${userId}`, userId, ...row } : null;
      },
    ),
    update: vi.fn(
      async ({ where, data }: { where: { roundId_userId?: { userId: string }; id?: string }; data: { status: string } }) => {
        const userId = where.roundId_userId?.userId ?? where.id?.replace('bet-', '');
        if (!userId || !memory.bets.has(userId)) throw new Error('BET_NOT_FOUND');
        const next = { ...memory.bets.get(userId)!, status: data.status };
        memory.bets.set(userId, next);
        return { id: `bet-${userId}`, userId, ...next };
      },
    ),
  },
  claim: {
    findUnique: vi.fn(
      async ({ where }: { where: { roundId_userId: { userId: string } } }) =>
        memory.claims.find((claim) => claim.userId === where.roundId_userId.userId) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      memory.claimSeq += 1;
      const claim = { id: `claim-${memory.claimSeq}`, ...data } as {
        id: string;
        userId: string;
        amountCents: bigint;
        source: string;
      };
      memory.claims.push(claim);
      return claim;
    }),
  },
}));

const transferMock = vi.hoisted(() =>
  vi.fn(async (_tx: unknown, params: Record<string, unknown>) => {
    memory.transfers.push(params);
  }),
);

vi.mock('../config.js', () => ({
  env: { sensitiveDataKey: 'test-key', tngPacketHosts: [] },
}));
vi.mock('../lib/prisma.js', () => ({ prisma: tx }));
vi.mock('../lib/transaction.js', () => ({
  serializable: async (task: (client: typeof tx) => Promise<unknown>) => task(tx),
}));
vi.mock('./gameSettings.js', () => ({
  getGameSettings: vi.fn(),
  parseSettingsSnapshot: () => ({ round: { claimDurationSeconds: 30 } }),
  setAssistantService: vi.fn(),
  settingsSnapshot: vi.fn(),
}));
vi.mock('./wallet.js', () => ({
  freezeBanker: vi.fn(),
  transfer: transferMock,
  unfreeze: vi.fn(),
}));

import {
  cancelRound,
  claimInternalPacket,
  forfeitMissingPlayer,
  GameError,
  publishInternalPacket,
  splitRemainingCents,
} from './game.js';

describe('内部红包发包与抢包', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
    memory.round.phase = 'SENDING_PACKET';
    memory.round.claimEndsAt = null;
    memory.packet.channel = 'TNG';
    memory.packet.status = 'CREATED';
    memory.packet.sentAt = null;
    memory.packet.expiresAt = null;
    memory.claims.length = 0;
    memory.events.length = 0;
    memory.transfers.length = 0;
    memory.diceReady = false;
    memory.claimSeq = 0;
    memory.bets.set('player-1', { status: 'FROZEN' });
    memory.bets.set('player-2', { status: 'FROZEN' });
    memory.packet.participantCount = 3;
    transferMock.mockClear();
  });

  it('自动认尾拆分不再调用可预测的 Math.random', () => {
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('MATH_RANDOM_MUST_NOT_BE_USED');
    });
    try {
      const parts = splitRemainingCents(1_000n, 3);
      expect(parts).toHaveLength(3);
      expect(parts.reduce((sum, amount) => sum + amount, 0n)).toBe(1_000n);
      expect(parts.every((amount) => amount >= 1n)).toBe(true);
    } finally {
      random.mockRestore();
    }
  });

  it('骰子未投完前不允许发内部红包', async () => {
    await expect(publishInternalPacket({ roundId: 'round-1' })).rejects.toMatchObject<
      Partial<GameError>
    >({ code: 'BANKER_DICE_NOT_READY' });
  });

  it('投骰完成后发包：packet 置 SENT/INTERNAL，牌局进入 CLAIMING', async () => {
    memory.diceReady = true;
    const packet = await publishInternalPacket({ roundId: 'round-1', actorId: 'SYSTEM' });

    expect(packet.channel).toBe('INTERNAL');
    expect(packet.status).toBe('SENT');
    expect(packet.expiresAt?.toISOString()).toBe('2026-08-15T12:00:30.000Z');
    expect(memory.round.phase).toBe('CLAIMING');
    expect(memory.events.some((event) => event.type === 'PACKET_SENT')).toBe(true);
  });

  async function publishAndClaimAll() {
    memory.diceReady = true;
    await publishInternalPacket({ roundId: 'round-1' });
    const banker = await claimInternalPacket('packet-1', 'banker-1');
    const player1 = await claimInternalPacket('packet-1', 'player-1');
    const player2 = await claimInternalPacket('packet-1', 'player-2');
    return { banker, player1, player2 };
  }

  it('随机拆分入账：金额>0、总和=红包总额、最后一人 complete=true', async () => {
    const { banker, player1, player2 } = await publishAndClaimAll();

    for (const result of [banker, player1, player2]) {
      expect(result.claim.amountCents > 0n).toBe(true);
      expect(result.claim.source).toBe('INTERNAL');
    }
    const total =
      banker.claim.amountCents + player1.claim.amountCents + player2.claim.amountCents;
    expect(total).toBe(1_000n);
    expect(banker.complete).toBe(false);
    expect(player1.complete).toBe(false);
    expect(player2.complete).toBe(true);

    // 每笔抢包都即时从平台备付金转入玩家余额，幂等键含 packetId+userId
    expect(memory.transfers).toHaveLength(3);
    expect(memory.transfers[0]).toMatchObject({
      refType: 'packet_internal_claim',
      idempotencyKey: 'pkt-internal-claim:packet-1:banker-1',
    });
  });

  it('重复抢返回 ALREADY_CLAIMED，未参与者返回 NOT_ELIGIBLE_TO_CLAIM', async () => {
    memory.diceReady = true;
    await publishInternalPacket({ roundId: 'round-1' });
    await claimInternalPacket('packet-1', 'player-1');

    await expect(claimInternalPacket('packet-1', 'player-1')).rejects.toMatchObject<
      Partial<GameError>
    >({ code: 'ALREADY_CLAIMED' });
    await expect(claimInternalPacket('packet-1', 'stranger')).rejects.toMatchObject<
      Partial<GameError>
    >({ code: 'NOT_ELIGIBLE_TO_CLAIM' });
    expect(memory.transfers).toHaveLength(1);
  });

  it('过期后不可抢：PACKET_EXPIRED', async () => {
    memory.diceReady = true;
    await publishInternalPacket({ roundId: 'round-1' });
    vi.setSystemTime(new Date('2026-08-15T12:01:00.000Z'));

    await expect(claimInternalPacket('packet-1', 'player-1')).rejects.toMatchObject<
      Partial<GameError>
    >({ code: 'PACKET_EXPIRED' });
  });

  it('内部红包已有领取记录后禁止取消，避免已入账红包变成平台损失', async () => {
    memory.diceReady = true;
    await publishInternalPacket({ roundId: 'round-1' });
    await claimInternalPacket('packet-1', 'player-1');

    await expect(cancelRound('round-1', 'MANUAL_CANCEL')).rejects.toMatchObject<
      Partial<GameError>
    >({ code: 'INTERNAL_PACKET_ALREADY_CLAIMED' });
    expect(memory.round.phase).toBe('CLAIMING');
    expect(memory.packet.status).toBe('SENT');
  });

  it('内部红包玩家弃权时同步减少发包人数，避免自动结算永远等不到该认额', async () => {
    memory.round.phase = 'CLAIM_EXPIRED';
    memory.packet.channel = 'INTERNAL';
    memory.packet.status = 'EXPIRED';

    await forfeitMissingPlayer('round-1', 'player-1', 'admin-1');

    expect(memory.bets.get('player-1')?.status).toBe('FORFEITED');
    expect(memory.packet.participantCount).toBe(2);
  });
});
