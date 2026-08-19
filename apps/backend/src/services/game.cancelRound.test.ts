import { AccountType, BetStatus, RoundPhase } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({
  betStatus: 'FROZEN',
  packetUpdate: null as Record<string, unknown> | null,
  roundUpdate: null as Record<string, unknown> | null,
  packetSentAt: null as Date | null,
  packetFeePrepaid: false,
  events: [] as Array<{ type: string; payload?: unknown; actorId?: string }>,
}));

const tx = vi.hoisted(() => ({
  round: {
    findUnique: vi.fn(async () => ({
      id: 'round-1',
      roomId: 'room-1',
      phase: 'SENDING_PACKET',
      bankerId: 'banker-1',
      bankerReservedCents: 5_000n,
      bets: [
        {
          id: 'bet-1',
          userId: 'player-1',
          status: memory.betStatus,
          amountCents: 1_000n,
          reservedCents: 1_700n,
        },
      ],
      packet: {
        id: 'packet-1',
        channel: 'TNG',
        totalCents: 200n,
        sentAt: memory.packetSentAt,
      },
      _count: { claims: 0 },
    })),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      memory.roundUpdate = data;
      return {
        id: 'round-1',
        roomId: 'room-1',
        phase: data.phase,
      };
    }),
  },
  bet: {
    update: vi.fn(async ({ data }: { data: { status: string } }) => {
      memory.betStatus = data.status;
      return { id: 'bet-1', status: data.status };
    }),
  },
  packet: {
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      memory.packetUpdate = data;
      return { id: 'packet-1', ...data };
    }),
  },
  roundEvent: {
    create: vi.fn(async ({ data }: {
      data: { type: string; payload?: unknown; actorId?: string };
    }) => {
      memory.events.push(data);
      return { id: `event-${memory.events.length}`, ...data };
    }),
  },
  ledgerEntry: {
    findUnique: vi.fn(async () =>
      memory.packetFeePrepaid
        ? {
            userId: 'banker-1',
            accountType: 'USER_FREEZE_BANKER',
            direction: 'DEBIT',
            amountCents: 200n,
            refType: 'fee_packet_agent',
            refId: 'round-1',
            roundId: 'round-1',
          }
        : null,
    ),
  },
}));

const unfreeze = vi.hoisted(() => vi.fn(async () => undefined));
const transfer = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../config.js', () => ({
  env: { sensitiveDataKey: 'test-key', tngPacketHosts: [] },
}));
vi.mock('../lib/prisma.js', () => ({ prisma: tx }));
vi.mock('../lib/transaction.js', () => ({
  serializable: async (task: (client: typeof tx) => Promise<unknown>) => task(tx),
}));
vi.mock('./gameSettings.js', () => ({
  getGameSettings: vi.fn(),
  parseSettingsSnapshot: vi.fn(),
  setAssistantService: vi.fn(),
  settingsSnapshot: vi.fn(),
}));
vi.mock('./wallet.js', () => ({
  freezeBanker: vi.fn(),
  transfer,
  unfreeze,
}));

import { cancelRound } from './game.js';

describe('整局重推退款', () => {
  beforeEach(() => {
    memory.betStatus = 'FROZEN';
    memory.packetUpdate = null;
    memory.roundUpdate = null;
    memory.packetSentAt = null;
    memory.packetFeePrepaid = false;
    memory.events.length = 0;
    unfreeze.mockClear();
    transfer.mockClear();
  });

  it('取消局会退回闲家责任金、庄家冻结金并关闭未发红包', async () => {
    const result = await cancelRound('round-1', '庄家重推', 'banker-1');

    expect(result.phase).toBe(RoundPhase.CANCELLED);
    expect(unfreeze).toHaveBeenNthCalledWith(
      1,
      tx,
      'player-1',
      AccountType.USER_FREEZE_BET,
      1_700n,
      'round-1',
      'round_cancel_refund',
      'cancel:bet-1',
    );
    expect(unfreeze).toHaveBeenNthCalledWith(
      2,
      tx,
      'banker-1',
      AccountType.USER_FREEZE_BANKER,
      5_000n,
      'round-1',
      'round_cancel_refund',
      'cancel:banker:round-1',
    );
    expect(memory.betStatus).toBe(BetStatus.REFUNDED);
    expect(memory.packetUpdate).toEqual({
      status: 'RECONCILED',
      returnedCents: 200n,
    });
    expect(memory.roundUpdate).toMatchObject({
      phase: RoundPhase.CANCELLED,
      cancelReason: '庄家重推',
      bankerReservedCents: 0,
    });
    expect(memory.events).toContainEqual({
      type: 'ROUND_CANCELLED',
      payload: { reason: '庄家重推' },
      actorId: 'banker-1',
      roundId: 'round-1',
    });
  });

  it('已预付的 TNG 代包费在取消局时通过调账科目全额退回庄家', async () => {
    memory.packetSentAt = new Date();
    memory.packetFeePrepaid = true;

    await cancelRound('round-1', 'TNG 发包后取消', 'admin-1');

    expect(unfreeze).toHaveBeenNthCalledWith(
      2,
      tx,
      'banker-1',
      AccountType.USER_FREEZE_BANKER,
      4_800n,
      'round-1',
      'round_cancel_refund',
      'cancel:banker:round-1',
    );
    expect(transfer).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        amountCents: 200n,
        from: { accountType: AccountType.ADJUST_CLEARING },
        to: {
          userId: 'banker-1',
          accountType: AccountType.USER_AVAILABLE,
        },
        refType: 'cancelled_packet_fee_refund',
        idempotencyKey: 'cancelled-packet-fee-refund:packet-1',
      }),
    );
  });
});
