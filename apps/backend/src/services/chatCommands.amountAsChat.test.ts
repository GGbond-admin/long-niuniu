import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({
  phase: 'SETTLING' as string | null,
  placeBet: vi.fn(),
  placeBankerBid: vi.fn(),
  withdrawBet: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {},
}));

vi.mock('../lib/redis.js', () => ({
  withRedisLock: vi.fn(async (_key: string, _ttl: number, work: () => Promise<unknown>) =>
    work(),
  ),
}));

vi.mock('./game.js', () => ({
  currentRoundForRoom: vi.fn(async () =>
    memory.phase
      ? {
          id: 'round-1',
          roomId: 'room-1',
          phase: memory.phase,
          bankerId: 'banker-1',
        }
      : null,
  ),
  cancelRound: vi.fn(),
  placeBankerBid: memory.placeBankerBid,
  placeBet: memory.placeBet,
  withdrawBet: memory.withdrawBet,
  GameError: class GameError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));

vi.mock('./gameBus.js', () => ({ gameBus: { transition: vi.fn() } }));
vi.mock('./gameSettings.js', () => ({
  getMessageTemplatesForRoom: vi.fn(),
  renderMessage: vi.fn(),
}));
vi.mock('./roomHub.js', () => ({
  ensureRoundAnnouncement: vi.fn(),
  appendChatOnce: vi.fn(),
  appendSystemChatOnce: vi.fn(),
}));

import { handleRoomChatCommand } from './chatCommands.js';

describe('非竞标/下注阶段纯数字当普通聊天', () => {
  beforeEach(() => {
    memory.phase = 'SETTLING';
    memory.placeBet.mockReset();
    memory.placeBankerBid.mockReset();
    memory.withdrawBet.mockReset();
  });

  it.each([
    'WAITING',
    'SENDING_PACKET',
    'CLAIM_EXPIRED',
    'SETTLING',
    'FINISHED',
    'CANCELLED',
  ])('阶段 %s 发送纯数字 → ignored（走普通聊天）', async (phase) => {
    memory.phase = phase;
    const result = await handleRoomChatCommand({
      roomId: 'room-1',
      userId: 'user-1',
      content: '100',
    });
    expect(result).toEqual({ kind: 'ignored' });
    expect(memory.placeBet).not.toHaveBeenCalled();
    expect(memory.placeBankerBid).not.toHaveBeenCalled();
  });

  it('无进行中牌局时发送数字 → ignored', async () => {
    memory.phase = null;
    const result = await handleRoomChatCommand({
      roomId: 'room-1',
      userId: 'user-1',
      content: '88.5',
    });
    expect(result).toEqual({ kind: 'ignored' });
  });

  it('非下注阶段发送 0 / sh金额 → ignored', async () => {
    memory.phase = 'SETTLING';
    await expect(
      handleRoomChatCommand({ roomId: 'room-1', userId: 'user-1', content: '0' }),
    ).resolves.toEqual({ kind: 'ignored' });
    await expect(
      handleRoomChatCommand({ roomId: 'room-1', userId: 'user-1', content: 'sh100' }),
    ).resolves.toEqual({ kind: 'ignored' });
    expect(memory.withdrawBet).not.toHaveBeenCalled();
    expect(memory.placeBet).not.toHaveBeenCalled();
  });

  it('抢包禁言阶段仍拦截数字发言', async () => {
    memory.phase = 'CLAIMING';
    const result = await handleRoomChatCommand({
      roomId: 'room-1',
      userId: 'user-1',
      content: '100',
    });
    expect(result).toMatchObject({ kind: 'muted' });
  });

  it('下注阶段纯数字仍走下注', async () => {
    memory.phase = 'BETTING';
    memory.placeBet.mockResolvedValue({});
    const result = await handleRoomChatCommand({
      roomId: 'room-1',
      userId: 'user-1',
      content: '100',
    });
    expect(result).toMatchObject({ kind: 'ok', action: 'bet', echo: '100' });
    expect(memory.placeBet).toHaveBeenCalledOnce();
  });

  it('竞标阶段纯数字仍走竞标', async () => {
    memory.phase = 'BANKER_BID';
    memory.placeBankerBid.mockResolvedValue({});
    const result = await handleRoomChatCommand({
      roomId: 'room-1',
      userId: 'user-1',
      content: '8800',
    });
    expect(result).toMatchObject({ kind: 'ok', action: 'bid', echo: '8800' });
    expect(memory.placeBankerBid).toHaveBeenCalledOnce();
  });
});
