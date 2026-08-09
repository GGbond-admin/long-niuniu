import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({
  assistantEnabled: true,
  chats: [] as Array<{ type: string; content: string }>,
  events: [] as Array<{
    id: string;
    roundId: string;
    type: string;
    payload?: unknown;
  }>,
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    roundEvent: {
      findFirst: vi.fn(async ({ where }: { where: { roundId: string; type: string } }) =>
        memory.events.find(
          (event) => event.roundId === where.roundId && event.type === where.type,
        ) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Omit<(typeof memory.events)[number], 'id'> }) => {
        const row = { id: `event-${memory.events.length + 1}`, ...data };
        memory.events.push(row);
        return row;
      }),
    },
    user: {
      findUnique: vi.fn(async () => ({
        uid: 'banker-uid',
        nickname: '庄家',
        tgUsername: null,
        avatarUrl: '/banker.jpg',
      })),
    },
  },
}));

vi.mock('../lib/redis.js', () => ({
  withRedisLock: vi.fn(async (_key: string, _ttl: number, work: () => Promise<unknown>) =>
    work(),
  ),
}));

vi.mock('./game.js', () => ({
  currentRoundForRoom: vi.fn(async () => ({
    id: 'round-1',
    roomId: 'room-1',
    seqNo: 1,
    phase: 'SENDING_PACKET',
    bankerId: 'banker-1',
  })),
  cancelRound: vi.fn(),
  placeBankerBid: vi.fn(),
  placeBet: vi.fn(),
  withdrawBet: vi.fn(),
  GameError: class GameError extends Error {},
}));

vi.mock('./gameBus.js', () => ({ gameBus: { transition: vi.fn() } }));
vi.mock('./gameSettings.js', () => ({
  getMessageTemplatesForRoom: vi.fn(async () => ({
    bankerDice: '【庄家开骰】 {{dice}}',
    sealed: '【等待平台发包】',
  })),
  renderMessage: (template: string, vars: Record<string, string>) =>
    template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(vars[key] ?? '')),
}));
vi.mock('./roomHub.js', () => ({
  ensureRoundAnnouncement: vi.fn(async () => undefined),
  appendChatOnce: vi.fn(async (
    _roomId: string,
    id: string,
    message: { type: string; content: string },
  ) => {
    memory.chats.push(message);
    return { id, at: new Date().toISOString(), ...message };
  }),
  appendSystemChatOnce: vi.fn(async (_roomId: string, id: string, content: string) => {
    if (!memory.assistantEnabled) return null;
    const message = { type: 'SYSTEM', content };
    memory.chats.push(message);
    return { id, at: new Date().toISOString(), ...message };
  }),
}));

import { runBankerDiceCeremony } from './chatCommands.js';

async function runCeremony() {
  const pending = runBankerDiceCeremony({ roomId: 'room-1', userId: 'banker-1' });
  await vi.runAllTimersAsync();
  return pending;
}

describe('庄家投骰仪式恢复与放行', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    memory.assistantEnabled = true;
    memory.chats.length = 0;
    memory.events.length = 0;
  });

  it('复用中断前已落库的点数，完成文字后才标记可发包', async () => {
    memory.events.push({
      id: 'existing-dice',
      roundId: 'round-1',
      type: 'BANKER_DICE',
      payload: { dice: [2, 5, 6] },
    });

    const result = await runCeremony();

    expect(result).toMatchObject({ kind: 'ok', dice: [2, 5, 6] });
    expect(memory.chats.map((message) => message.content)).toEqual([
      '2',
      '5',
      '6',
      '【庄家开骰】 2·5·6',
      '【等待平台发包】',
    ]);
    expect(memory.events.some((event) => event.type === 'BANKER_DICE_READY_FOR_PACKET')).toBe(true);
  });

  it('小助手暂停时不放行；恢复后跳过已展示骰子并补齐两条文字', async () => {
    memory.assistantEnabled = false;
    const paused = await runCeremony();
    expect(paused).toMatchObject({ kind: 'error' });
    expect(memory.events.some((event) => event.type === 'BANKER_DICE_READY_FOR_PACKET')).toBe(false);

    memory.assistantEnabled = true;
    const resumed = await runCeremony();

    expect(resumed).toMatchObject({ kind: 'ok' });
    expect(memory.chats.filter((message) => message.type === 'DICE')).toHaveLength(3);
    expect(memory.chats.filter((message) => message.type === 'SYSTEM')).toHaveLength(2);
    expect(memory.events.some((event) => event.type === 'BANKER_DICE_READY_FOR_PACKET')).toBe(true);
  });

  it('最后一颗骰子落地前不公布结果（对齐前端动画）', async () => {
    memory.events.push({
      id: 'existing-dice',
      roundId: 'round-1',
      type: 'BANKER_DICE',
      payload: { dice: [1, 2, 3] },
    });

    const pending = runBankerDiceCeremony({ roomId: 'room-1', userId: 'banker-1' });

    // 两颗间隔 1400ms：推进到第三颗已发出，但尚未到公布前停顿结束
    await vi.advanceTimersByTimeAsync(1_400);
    expect(memory.chats.filter((m) => m.type === 'DICE')).toHaveLength(2);
    expect(memory.chats.some((m) => m.type === 'SYSTEM')).toBe(false);

    await vi.advanceTimersByTimeAsync(1_400);
    expect(memory.chats.filter((m) => m.type === 'DICE')).toHaveLength(3);
    expect(memory.chats.some((m) => m.type === 'SYSTEM')).toBe(false);

    // 落地后再停 1500ms 才播报
    await vi.advanceTimersByTimeAsync(1_499);
    expect(memory.chats.some((m) => m.type === 'SYSTEM')).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result).toMatchObject({ kind: 'ok' });
    expect(memory.chats.some((m) => m.content.includes('【庄家开骰】'))).toBe(true);
  });
});
