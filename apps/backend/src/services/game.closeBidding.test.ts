import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FEE_CONFIG,
  bankerBidReserveCents,
  maxAffordableBankerBidCents,
} from '../engine/fees.js';

const memory = vi.hoisted(() => {
  const rounds = new Map<string, any>();
  const bids = new Map<string, any>();
  const users = new Map<string, any>();
  const events: any[] = [];
  let memberCount = 6;
  let bidCounter = 0;

  const settings = {
    fees: {
      bankerSeatFeeRatio: 0.01,
      serviceFeeCents: 3800,
      packetPerHeadCents: 104,
      playerRakeRatio: 0.03,
      bankerRakeRatio: 0.05,
    },
    round: {
      betDurationSeconds: 50,
      bankerBidMinCents: 10_000,
      bankerBidMaxCents: 200_000_000,
    },
  };

  const prisma = {
    round: {
      findUnique: async ({ where, include }: any) => {
        const round = rounds.get(where.id);
        if (!round) return null;
        const result = { ...round };
        if (include?.bids) {
          result.bids = [...bids.values()]
            .filter((bid) => bid.roundId === round.id)
            .sort((left, right) => {
              if (left.amountCents !== right.amountCents) {
                return left.amountCents > right.amountCents ? -1 : 1;
              }
              return left.createdAt.getTime() - right.createdAt.getTime();
            });
        }
        return result;
      },
      update: async ({ where, data }: any) => {
        const round = rounds.get(where.id);
        const next = { ...round };
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === 'object' && 'increment' in value) {
            next[key] = (round[key] ?? 0) + (value as { increment: number }).increment;
          } else {
            next[key] = value;
          }
        }
        rounds.set(where.id, next);
        return { ...next };
      },
    },
    bankerBid: {
      updateMany: async ({ where, data }: any) => {
        for (const bid of bids.values()) {
          if (bid.roundId === where.roundId) Object.assign(bid, data);
        }
        return { count: bids.size };
      },
      update: async ({ where, data }: any) => {
        const bid = bids.get(where.id);
        Object.assign(bid, data);
        return { ...bid };
      },
    },
    user: {
      findUnique: async ({ where }: any) => users.get(where.id) ?? null,
    },
    roomMember: {
      count: async () => memberCount,
    },
    roundEvent: {
      create: async ({ data }: any) => {
        events.push(data);
        return data;
      },
    },
  };

  function seedUser(
    id: string,
    availableCents: bigint,
    extras: Record<string, unknown> = {},
  ) {
    const wallet = { userId: id, availableCents };
    users.set(id, {
      id,
      uid: id,
      nickname: id,
      status: 'ACTIVE',
      kind: 'HUMAN',
      kyc: { status: 'APPROVED' },
      wallet,
      paymentPin: { isSet: true },
      virtualPlayer: null,
      roomMemberships: [{ roomId: 'room-1', status: 'ACTIVE' }],
      ...extras,
    });
  }

  function seedBid(id: string, userId: string, amountCents: bigint, createdAt: Date) {
    bids.set(id, {
      id,
      roundId: 'round-1',
      userId,
      amountCents,
      won: false,
      createdAt,
    });
  }

  function reset() {
    rounds.clear();
    bids.clear();
    users.clear();
    events.length = 0;
    memberCount = 6;
    bidCounter = 0;
    rounds.set('round-1', {
      id: 'round-1',
      roomId: 'room-1',
      seqNo: 32,
      phase: 'BANKER_BID',
      bankerId: null,
      potCents: 0n,
      bankerReservedCents: 0n,
      version: 0,
      configSnapshot: settings,
      bidEndsAt: new Date('2026-08-22T09:55:00.000Z'),
    });
  }

  return {
    bids,
    events,
    prisma,
    reset,
    seedBid,
    seedUser,
    settings,
    setMemberCount: (value: number) => {
      memberCount = value;
    },
    nextBidId: () => {
      bidCounter += 1;
      return `bid-${bidCounter}`;
    },
  };
});

vi.mock('../config.js', () => ({
  env: { sensitiveDataKey: 'test-key', tngPacketHosts: [] },
}));

vi.mock('../lib/prisma.js', () => ({ prisma: memory.prisma }));

vi.mock('../lib/transaction.js', () => ({
  serializable: async (task: (tx: any) => Promise<unknown>) => task(memory.prisma),
}));

vi.mock('./gameSettings.js', () => ({
  getGameSettings: async () => memory.settings,
  parseSettingsSnapshot: (value: unknown) => value,
  settingsSnapshot: (value: unknown) => value,
  setAssistantService: vi.fn(),
}));

vi.mock('./wallet.js', () => ({
  freezeBanker: vi.fn(),
  transfer: vi.fn(),
  unfreeze: vi.fn(),
}));

import { closeBidding } from './game.js';

const HIGH_BID = 87_706_500n;
const LOW_BID = 10_000_000n;

describe('截标锁定最高有效价', () => {
  beforeEach(() => {
    memory.reset();
  });

  it('在房人数增加导致满额第一名刚好不够原价时，自动降额锁定第一名，而不是顺延第二名', async () => {
    const available = BigInt(
      bankerBidReserveCents(Number(HIGH_BID), DEFAULT_FEE_CONFIG, 6),
    );
    memory.seedUser('seven-eleven', available);
    memory.seedUser('player-l', 50_000_000n);
    memory.seedBid(memory.nextBidId(), 'seven-eleven', HIGH_BID, new Date('2026-08-22T09:54:50.000Z'));
    memory.seedBid(memory.nextBidId(), 'player-l', LOW_BID, new Date('2026-08-22T09:54:51.000Z'));
    memory.setMemberCount(20);

    const reduced = BigInt(
      maxAffordableBankerBidCents(
        Number(available),
        DEFAULT_FEE_CONFIG,
        memory.settings.round.bankerBidMaxCents,
        20,
      ),
    );
    expect(reduced).toBeGreaterThan(LOW_BID);
    expect(reduced).toBeLessThan(HIGH_BID);

    const closed = await closeBidding('round-1');
    expect(closed.phase).toBe('BETTING');
    expect(closed.bankerId).toBe('seven-eleven');
    expect(closed.potCents).toBe(reduced);
    expect(
      memory.events.some(
        (item) =>
          item.type === 'BANKER_BID_ADJUSTED_ON_LOCK'
          && item.payload.userId === 'seven-eleven',
      ),
    ).toBe(true);
    expect(memory.events.some((item) => item.type === 'BANKER_SELECTED')).toBe(true);
  });

  it('第一名账号已不能上庄时，才顺延给下一口仍有效的出价', async () => {
    memory.seedUser('seven-eleven', 200_000_000n, {
      roomMemberships: [{ roomId: 'room-1', status: 'LEFT' }],
    });
    memory.seedUser('player-l', 50_000_000n);
    memory.seedBid(memory.nextBidId(), 'seven-eleven', HIGH_BID, new Date('2026-08-22T09:54:50.000Z'));
    memory.seedBid(memory.nextBidId(), 'player-l', LOW_BID, new Date('2026-08-22T09:54:51.000Z'));

    const closed = await closeBidding('round-1');
    expect(closed.bankerId).toBe('player-l');
    expect(closed.potCents).toBe(LOW_BID);
    expect(
      memory.events.some(
        (item) =>
          item.type === 'BANKER_BID_SKIPPED'
          && item.payload.userId === 'seven-eleven'
          && item.payload.reason === 'NOT_IN_ROOM',
      ),
    ).toBe(true);
  });

  it('第一名降额后仍低于第二名原价时，锁定更高的有效价', async () => {
    memory.seedUser('seven-eleven', 20_000n);
    memory.seedUser('player-l', 50_000_000n);
    memory.seedBid(memory.nextBidId(), 'seven-eleven', HIGH_BID, new Date('2026-08-22T09:54:50.000Z'));
    memory.seedBid(memory.nextBidId(), 'player-l', LOW_BID, new Date('2026-08-22T09:54:51.000Z'));

    const closed = await closeBidding('round-1');
    expect(closed.bankerId).toBe('player-l');
    expect(closed.potCents).toBe(LOW_BID);
  });

  it('第一名原价仍够支付时保持原价锁定', async () => {
    memory.seedUser('seven-eleven', 200_000_000n);
    memory.seedUser('player-l', 50_000_000n);
    memory.seedBid(memory.nextBidId(), 'seven-eleven', HIGH_BID, new Date('2026-08-22T09:54:50.000Z'));
    memory.seedBid(memory.nextBidId(), 'player-l', LOW_BID, new Date('2026-08-22T09:54:51.000Z'));

    const closed = await closeBidding('round-1');
    expect(closed.bankerId).toBe('seven-eleven');
    expect(closed.potCents).toBe(HIGH_BID);
    expect(
      memory.events.some((item) => item.type === 'BANKER_BID_ADJUSTED_ON_LOCK'),
    ).toBe(false);
  });
});
