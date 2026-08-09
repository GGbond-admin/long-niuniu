import { describe, expect, it, vi } from 'vitest';

const tx = vi.hoisted(() => ({
  round: {
    findUnique: vi.fn(async () => ({
      id: 'round-1',
      roomId: 'room-1',
      phase: 'SENDING_PACKET',
      configSnapshot: {},
      packet: { id: 'packet-1' },
    })),
  },
  roundEvent: {
    findFirst: vi.fn(async () => null),
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
  transfer: vi.fn(),
  unfreeze: vi.fn(),
}));

import { publishPacket } from './game.js';

describe('红包发出前置时序', () => {
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
});
