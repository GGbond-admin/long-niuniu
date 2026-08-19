import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ diceReady: false }));
const transferMock = vi.hoisted(() => vi.fn());

const tx = vi.hoisted(() => ({
  round: {
    findUnique: vi.fn(async () => ({
      id: 'round-1',
      roomId: 'room-1',
      phase: 'SENDING_PACKET',
      bankerId: 'banker-1',
      configSnapshot: {},
      packet: { id: 'packet-1', totalCents: 1_000n },
    })),
    update: vi.fn(async () => ({})),
  },
  roundEvent: {
    findFirst: vi.fn(async () => (state.diceReady ? { id: 'dice-ready' } : null)),
    create: vi.fn(async () => ({})),
  },
  tngAccount: {
    findUnique: vi.fn(async () => ({
      id: 'account-1',
      status: 'ACTIVE',
      monthlyLimitCents: null,
    })),
  },
  packet: {
    aggregate: vi.fn(async () => ({ _sum: { totalCents: 0n } })),
    update: vi.fn(async () => ({
      id: 'packet-1',
      totalCents: 1_000n,
      channel: 'TNG',
      status: 'SENT',
    })),
  },
}));

vi.mock('../config.js', () => ({
  env: {
    sensitiveDataKey: 'test-key',
    tngPacketHosts: [],
  },
}));

vi.mock('../lib/prisma.js', () => ({ prisma: tx }));
vi.mock('../lib/transaction.js', () => ({
  serializable: async (task: (client: typeof tx) => Promise<unknown>) => task(tx),
}));
vi.mock('./gameSettings.js', () => ({
  getGameSettings: vi.fn(),
  parseSettingsSnapshot: vi.fn(() => ({ round: { claimDurationSeconds: 30 } })),
  setAssistantService: vi.fn(),
  settingsSnapshot: vi.fn(),
}));
vi.mock('./wallet.js', () => ({
  freezeBanker: vi.fn(),
  transfer: transferMock,
  unfreeze: vi.fn(),
}));

import { publishPacket } from './game.js';

describe('红包发出前置时序', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.diceReady = false;
  });

  it('三颗骰子及开骰等待话术尚未完成时禁止发包', async () => {
    await expect(
      publishPacket({
        roundId: 'round-1',
        claimUrl: 'https://example.com/packet-1',
        packerAccount: 'account-1',
      }),
    ).rejects.toMatchObject({
      code: 'BANKER_DICE_NOT_READY',
    });
  });

  it('TNG 发包先从庄家冻结费用补足备付金，再转入 TNG 在途', async () => {
    state.diceReady = true;

    await publishPacket({
      roundId: 'round-1',
      claimUrl: 'https://example.com/packet-1',
      packerAccount: 'account-1',
    });

    expect(transferMock).toHaveBeenNthCalledWith(
      1,
      tx,
      expect.objectContaining({
        amountCents: 1_000n,
        from: {
          userId: 'banker-1',
          accountType: 'USER_FREEZE_BANKER',
        },
        to: { accountType: 'PLATFORM_RESERVE' },
        idempotencyKey: 'settle:fee_packet_agent:round-1',
      }),
    );
    expect(transferMock).toHaveBeenNthCalledWith(
      2,
      tx,
      expect.objectContaining({
        from: { accountType: 'PLATFORM_RESERVE' },
        to: { accountType: 'TNG_TRANSIT' },
        idempotencyKey: 'packet-send:packet-1',
      }),
    );
  });
});
