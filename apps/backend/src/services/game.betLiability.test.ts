import { AccountType, RoundPhase } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BETTING_CONFIG } from '../engine/betting.js';
import { DEFAULT_FEE_CONFIG } from '../engine/fees.js';
import { DEFAULT_HAND_CONFIG } from '../engine/hand.js';

const memory = vi.hoisted(() => {
  const wallet = {
    userId: 'player-1',
    availableCents: 20_000n,
    freezeBankerCents: 0n,
    freezeBetCents: 0n,
    freezeWithdrawCents: 0n,
  };
  const round = {
    id: 'round-1',
    roomId: 'room-1',
    phase: 'BETTING',
    bankerId: 'banker-1',
    potCents: 1_000_000n,
    betEndsAt: new Date(Date.now() + 60_000),
    configSnapshot: {} as Record<string, unknown>,
  };
  let bet: Record<string, unknown> | null = null;
  const transfers: Array<Record<string, unknown>> = [];
  const unfreezes: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];

  const prisma = {
    round: {
      findUnique: vi.fn(async () => ({ ...round })),
    },
    user: {
      findUnique: vi.fn(async () => ({
        id: 'player-1',
        uid: 'player-1',
        nickname: 'Player',
        status: 'ACTIVE',
        kind: 'REAL',
        kyc: { status: 'APPROVED' },
        wallet,
        virtualPlayer: null,
        roomMemberships: [{ roomId: 'room-1', status: 'ACTIVE' }],
      })),
    },
    roomMember: {
      count: vi.fn(async () => 30),
    },
    bet: {
      findUnique: vi.fn(async () => (bet ? { ...bet } : null)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        bet = { id: 'bet-1', status: 'FROZEN', revision: 0, ...data };
        return { ...bet };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (!bet) throw new Error('BET_NOT_FOUND');
        bet = { ...bet, ...data };
        return { ...bet };
      }),
    },
    roundEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      }),
    },
  };

  function moveBalance(params: Record<string, any>) {
    transfers.push(params);
    const amount = params.amountCents as bigint;
    if (params.from?.accountType === 'USER_AVAILABLE') wallet.availableCents -= amount;
    if (params.from?.accountType === 'USER_FREEZE_BET') wallet.freezeBetCents -= amount;
    if (params.to?.accountType === 'USER_AVAILABLE') wallet.availableCents += amount;
    if (params.to?.accountType === 'USER_FREEZE_BET') wallet.freezeBetCents += amount;
  }

  return {
    events,
    get bet() {
      return bet;
    },
    prisma,
    reset() {
      wallet.availableCents = 20_000n;
      wallet.freezeBetCents = 0n;
      round.phase = 'BETTING';
      round.betEndsAt = new Date(Date.now() + 60_000);
      round.configSnapshot = {
        hand: DEFAULT_HAND_CONFIG,
        betting: {
          ...DEFAULT_BETTING_CONFIG,
          playerCoefTiers: [{ maxPlayers: 9999, coef: 1 }],
        },
        fees: DEFAULT_FEE_CONFIG,
        rebate: {},
        round: {},
        rewards: {},
      };
      bet = null;
      transfers.length = 0;
      events.length = 0;
      unfreezes.length = 0;
    },
    round,
    transfers,
    unfreezes,
    wallet,
    moveBalance,
  };
});

vi.mock('../config.js', () => ({
  env: { sensitiveDataKey: 'test-key', tngPacketHosts: [] },
}));
vi.mock('../lib/prisma.js', () => ({ prisma: memory.prisma }));
vi.mock('../lib/transaction.js', () => ({
  serializable: async (task: (tx: typeof memory.prisma) => Promise<unknown>) =>
    task(memory.prisma),
}));
vi.mock('./gameSettings.js', () => ({
  getGameSettings: vi.fn(),
  parseSettingsSnapshot: (value: unknown) => value,
  settingsSnapshot: (value: unknown) => value,
  setAssistantService: vi.fn(),
}));
vi.mock('./wallet.js', () => ({
  freezeBanker: vi.fn(),
  transfer: vi.fn(async (_tx: unknown, params: Record<string, unknown>) =>
    memory.moveBalance(params),
  ),
  unfreeze: vi.fn(
    async (
      _tx: unknown,
      userId: string,
      accountType: string,
      amountCents: bigint,
      roundId: string,
      reason: string,
      refId: string,
    ) => {
      memory.unfreezes.push({
        userId,
        accountType,
        amountCents,
        roundId,
        reason,
        refId,
      });
    },
  ),
}));

import { GameError, placeBet, withdrawBet } from './game.js';

describe('下注最大赔付预留', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T13:00:00.000Z'));
    memory.reset();
  });

  it('余额 RM200 输入 RM50，按 17 倍自动接受 RM11 并冻结 RM187', async () => {
    const result = await placeBet('round-1', 'player-1', 5_000n, false);

    expect(result).toMatchObject({
      requestedCents: 5_000n,
      acceptedCents: 1_100n,
      reservedCents: 18_700n,
      maxAffordableCents: 1_100n,
      maxMultiplier: 17,
      adjusted: true,
      adjustedBy: ['LIABILITY_LIMIT'],
    });
    expect(result.bet).toMatchObject({ amountCents: 1_100n, reservedCents: 18_700n });
    expect(memory.wallet).toMatchObject({
      availableCents: 1_300n,
      freezeBetCents: 18_700n,
    });
    expect(memory.transfers[0]).toMatchObject({
      amountCents: 18_700n,
      from: { userId: 'player-1', accountType: AccountType.USER_AVAILABLE },
      to: { userId: 'player-1', accountType: AccountType.USER_FREEZE_BET },
    });
  });

  it('梭哈按 1:1 预留：余额 RM200 可整额押上并只冻结 RM200', async () => {
    const result = await placeBet('round-1', 'player-1', 50_000n, true);

    expect(result).toMatchObject({
      acceptedCents: 20_000n,
      reservedCents: 20_000n,
      maxAffordableCents: 20_000n,
      maxMultiplier: 17,
      liabilityMultiplier: 1,
      adjusted: true,
      adjustedBy: ['LIABILITY_LIMIT'],
    });
    expect(memory.wallet).toMatchObject({ availableCents: 0n, freezeBetCents: 20_000n });
  });

  it('梭哈精确到分：RM123.45 原额接受', async () => {
    const result = await placeBet('round-1', 'player-1', 12_345n, true);

    expect(result).toMatchObject({
      acceptedCents: 12_345n,
      reservedCents: 12_345n,
      adjusted: false,
    });
    expect(memory.wallet).toMatchObject({ availableCents: 7_655n, freezeBetCents: 12_345n });
  });

  it('修改下注按预留差额解冻和补冻', async () => {
    await placeBet('round-1', 'player-1', 5_000n, false); // 接受 11，预留 187
    const reduced = await placeBet('round-1', 'player-1', 500n, false);
    expect(reduced).toMatchObject({ acceptedCents: 500n, reservedCents: 8_500n });
    expect(memory.transfers.at(-1)).toMatchObject({
      amountCents: 10_200n,
      from: { accountType: AccountType.USER_FREEZE_BET },
      to: { accountType: AccountType.USER_AVAILABLE },
    });

    const raised = await placeBet('round-1', 'player-1', 2_000n, false);
    expect(raised).toMatchObject({
      acceptedCents: 1_100n,
      reservedCents: 18_700n,
      adjusted: true,
    });
    expect(memory.transfers.at(-1)).toMatchObject({
      amountCents: 10_200n,
      from: { accountType: AccountType.USER_AVAILABLE },
      to: { accountType: AccountType.USER_FREEZE_BET },
    });
  });

  it('余额无法覆盖最低下注的 17 倍时拒绝且不冻结', async () => {
    memory.wallet.availableCents = 2_000n;

    await expect(placeBet('round-1', 'player-1', 1_000n, false)).rejects.toMatchObject<
      Partial<GameError>
    >({
      code: 'MAX_LIABILITY_BELOW_MIN',
      details: { maxAcceptedCents: '100' },
    });
    expect(memory.transfers).toHaveLength(0);
    expect(memory.bet).toBeNull();
  });

  it('撤回下注释放完整最大赔付预留金，而不是只退下注本金', async () => {
    await placeBet('round-1', 'player-1', 5_000n, false);
    await withdrawBet('round-1', 'player-1');

    expect(memory.unfreezes).toContainEqual(
      expect.objectContaining({
        accountType: AccountType.USER_FREEZE_BET,
        amountCents: 18_700n,
        reason: 'bet_withdraw',
      }),
    );
  });
});
