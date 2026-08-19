import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({
  assistantEnabled: true,
  chats: [] as Array<{ type: string; content: string }>,
  events: [] as Array<{
    id: string;
    roundId: string;
    type: string;
    payload?: unknown;
    createdAt?: Date;
  }>,
  cancelRound: vi.fn(),
  ensureWaitingRound: vi.fn(),
  startRound: vi.fn(),
  transition: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    roundEvent: {
      findFirst: vi.fn(async ({
        where,
        orderBy,
      }: {
        where: { roundId: string; type: string };
        orderBy?:
          | { createdAt?: 'asc' | 'desc' }
          | Array<{ createdAt?: 'asc' | 'desc'; id?: 'asc' | 'desc' }>;
      }) => {
        const rows = memory.events.filter(
          (event) => event.roundId === where.roundId && event.type === where.type,
        );
        const createdAtOrder = Array.isArray(orderBy)
          ? orderBy.find((entry) => entry.createdAt)?.createdAt
          : orderBy?.createdAt;
        if (createdAtOrder === 'desc') rows.reverse();
        return rows[0] ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Omit<(typeof memory.events)[number], 'id'> }) => {
        const row = {
          id: `event-${memory.events.length + 1}`,
          createdAt: new Date(),
          ...data,
        };
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
  cancelRound: memory.cancelRound,
  ensureWaitingRound: memory.ensureWaitingRound,
  startRound: memory.startRound,
  placeBankerBid: vi.fn(),
  placeBet: vi.fn(),
  withdrawBet: vi.fn(),
  GameError: class GameError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));

vi.mock('./gameBus.js', () => ({
  gameBus: { transition: memory.transition },
}));
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

import {
  cancelBankerDiceTimeout,
  confirmedChatGameAction,
  handleRoomChatCommand,
  runBankerDiceCeremony,
} from './chatCommands.js';

async function runCeremony() {
  const pending = runBankerDiceCeremony({ roomId: 'room-1', userId: 'banker-1' });
  await vi.runAllTimersAsync();
  return pending;
}

function repostWindow(endsAt: Date) {
  memory.events.push({
    id: 'repost-window',
    roundId: 'round-1',
    type: 'BANKER_REPOST_WINDOW',
    payload: { endsAt: endsAt.toISOString(), seconds: 5 },
    createdAt: new Date(),
  });
}

function diceDeadline(endsAt: Date) {
  memory.events.push({
    id: 'dice-deadline',
    roundId: 'round-1',
    type: 'BANKER_DICE_DEADLINE',
    payload: { endsAt: endsAt.toISOString(), seconds: 15 },
    createdAt: new Date(),
  });
}

describe('庄家投骰与整局重推', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T05:00:00.000Z'));
    memory.assistantEnabled = true;
    memory.chats.length = 0;
    memory.events.length = 0;
    repostWindow(new Date(Date.now() - 1));
    diceDeadline(new Date(Date.now() + 15_000));
    memory.cancelRound.mockReset();
    memory.cancelRound.mockResolvedValue({ phase: 'CANCELLED' });
    memory.ensureWaitingRound.mockReset();
    memory.ensureWaitingRound.mockResolvedValue({
      id: 'round-2',
      roomId: 'room-1',
      phase: 'WAITING',
    });
    memory.startRound.mockReset();
    memory.startRound.mockResolvedValue({
      id: 'round-2',
      roomId: 'room-1',
      phase: 'BANKER_BID',
    });
    memory.transition.mockReset();
  });

  it('确认窗口结束后完成投骰，文字播报完成才标记可发包', async () => {
    memory.events.push({
      id: 'existing-dice',
      roundId: 'round-1',
      type: 'BANKER_DICE',
      payload: { dice: [2, 5, 6] },
      createdAt: new Date(),
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
      createdAt: new Date(),
    });

    const pending = runBankerDiceCeremony({ roomId: 'room-1', userId: 'banker-1' });
    await vi.advanceTimersByTimeAsync(1_400);
    expect(memory.chats.filter((message) => message.type === 'DICE')).toHaveLength(2);
    expect(memory.chats.some((message) => message.type === 'SYSTEM')).toBe(false);

    await vi.advanceTimersByTimeAsync(1_400);
    expect(memory.chats.filter((message) => message.type === 'DICE')).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(memory.chats.some((message) => message.type === 'SYSTEM')).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ kind: 'ok' });
    expect(memory.chats.some((message) => message.content.includes('【庄家开骰】'))).toBe(true);
  });

  it('封盘确认窗口内禁止提前投骰', async () => {
    memory.events.length = 0;
    repostWindow(new Date(Date.now() + 5_000));
    diceDeadline(new Date(Date.now() + 20_000));

    await expect(runCeremony()).resolves.toEqual({
      kind: 'error',
      message: '封盘确认中，还剩 5 秒；如需取消退款并重开，请发送 /重推',
    });
    expect(memory.events.some((event) => event.type === 'BANKER_DICE')).toBe(false);
  });

  it('/重推会取消退款并立即开启下一局，不会重新投骰', async () => {
    memory.events.length = 0;
    repostWindow(new Date(Date.now() + 5_000));
    diceDeadline(new Date(Date.now() + 20_000));

    const result = await handleRoomChatCommand({
      roomId: 'room-1',
      userId: 'banker-1',
      content: '/重推',
    });

    expect(result).toEqual({ kind: 'ok', action: 'repost', echo: '/重推' });
    expect(confirmedChatGameAction(result)).toBeUndefined();
    expect(memory.cancelRound).toHaveBeenCalledWith('round-1', '庄家重推', 'banker-1');
    expect(memory.ensureWaitingRound).toHaveBeenCalledWith('room-1');
    expect(memory.startRound).toHaveBeenCalledWith(
      'round-2',
      false,
      undefined,
      'REPLACEMENT',
    );
    expect(memory.transition).toHaveBeenNthCalledWith(1, {
      roundId: 'round-1',
      roomId: 'room-1',
      from: 'SENDING_PACKET',
      to: 'CANCELLED',
    });
    expect(memory.transition).toHaveBeenNthCalledWith(2, {
      roundId: 'round-2',
      roomId: 'room-1',
      from: 'WAITING',
      to: 'BANKER_BID',
    });
    expect(memory.events.some((event) => event.type === 'BANKER_DICE')).toBe(false);
  });

  it('重推窗口结束后不能取消本局', async () => {
    const result = await handleRoomChatCommand({
      roomId: 'room-1',
      userId: 'banker-1',
      content: '重推',
    });

    expect(result).toEqual({
      kind: 'error',
      message: '重推确认时间已结束，请继续完成庄家投骰',
    });
    expect(memory.cancelRound).not.toHaveBeenCalled();
  });

  it('已经开始投骰后不能再重推', async () => {
    memory.events.length = 0;
    repostWindow(new Date(Date.now() + 5_000));
    diceDeadline(new Date(Date.now() + 20_000));
    memory.events.push({
      id: 'started-dice',
      roundId: 'round-1',
      type: 'BANKER_DICE',
      payload: { dice: [3, 3, 3] },
      createdAt: new Date(),
    });

    await expect(
      handleRoomChatCommand({
        roomId: 'room-1',
        userId: 'banker-1',
        content: '/重推',
      }),
    ).resolves.toEqual({
      kind: 'error',
      message: '本局已经开始投骰，不能再重推',
    });
    expect(memory.cancelRound).not.toHaveBeenCalled();
  });

  it('15 秒投骰时间结束后拒绝再投骰', async () => {
    memory.events.length = 0;
    repostWindow(new Date(Date.now() - 15_000));
    diceDeadline(new Date(Date.now() - 1));

    await expect(runCeremony()).resolves.toEqual({
      kind: 'error',
      message: '庄家投骰时间已结束，本局正在自动取消',
    });
    expect(memory.events.some((event) => event.type === 'BANKER_DICE')).toBe(false);
  });

  it('15 秒未投骰时自动取消并退款', async () => {
    memory.events.length = 0;
    repostWindow(new Date(Date.now() - 15_000));

    await expect(
      cancelBankerDiceTimeout({
        roundId: 'round-1',
        roomId: 'room-1',
        now: new Date(),
      }),
    ).resolves.toBe(true);

    expect(memory.cancelRound).toHaveBeenCalledWith(
      'round-1',
      '庄家投骰超时',
      'SYSTEM',
    );
    expect(memory.transition).toHaveBeenCalledWith({
      roundId: 'round-1',
      roomId: 'room-1',
      from: 'SENDING_PACKET',
      to: 'CANCELLED',
    });
  });
});
