import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => {
  const round = {
    id: 'round-claim',
    roomId: 'room-1',
    phase: 'CLAIMING',
    bankerId: 'banker-1',
    claimEndsAt: new Date('2026-08-07T07:00:01.000Z'),
    configSnapshot: { round: { claimDurationSeconds: 30 } },
  };
  const packet = {
    id: 'packet-claim',
    roundId: round.id,
    status: 'SENT',
    expiresAt: new Date('2026-08-07T07:00:01.000Z'),
  };
  return { packet, round };
});

const tx = vi.hoisted(() => ({
  round: {
    findUnique: vi.fn(async () => ({ ...memory.round, packet: memory.packet })),
    update: vi.fn(async ({ data }: { data: { claimEndsAt?: Date; phase?: string } }) => {
      Object.assign(memory.round, data);
      return { ...memory.round };
    }),
  },
  roundEvent: {
    findFirst: vi.fn(async () => null),
  },
  packet: {
    findUnique: vi.fn(async () => ({ ...memory.packet, round: memory.round })),
    update: vi.fn(async ({ data }: { data: { expiresAt?: Date; status?: string } }) => {
      Object.assign(memory.packet, data);
      return { ...memory.packet };
    }),
  },
  bet: {
    findUnique: vi.fn(async () => null),
  },
}));

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
  transfer: vi.fn(),
  unfreeze: vi.fn(),
}));

import {
  canClaimPacket,
  expirePacket,
  refreshUnannouncedClaimDeadline,
} from './game.js';

describe('开抢播报恢复后的领取期限', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T07:00:10.000Z'));
    memory.round.phase = 'CLAIMING';
    memory.round.claimEndsAt = new Date('2026-08-07T07:00:01.000Z');
    memory.packet.status = 'SENT';
    memory.packet.expiresAt = new Date('2026-08-07T07:00:01.000Z');
  });

  it('原子刷新 Round 与 Packet，刷新后可领取且不会被旧定时任务过期', async () => {
    const deadline = await refreshUnannouncedClaimDeadline(memory.round.id);

    expect(deadline.toISOString()).toBe('2026-08-07T07:00:40.000Z');
    expect(memory.round.claimEndsAt).toEqual(deadline);
    expect(memory.packet.expiresAt).toEqual(deadline);
    expect(await canClaimPacket(memory.packet.id, 'banker-1')).toBe(true);

    await expirePacket(memory.round.id);
    expect(memory.round.phase).toBe('CLAIMING');
    expect(memory.packet.status).toBe('SENT');
  });
});
