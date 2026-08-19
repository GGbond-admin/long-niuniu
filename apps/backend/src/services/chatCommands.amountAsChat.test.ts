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
    details?: Record<string, unknown>;
    constructor(code: string, details?: Record<string, unknown>) {
      super(code);
      this.code = code;
      this.details = details;
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

import { GameError } from './game.js';
import {
  handleRoomChatCommand,
  privateBetConfirmationFor,
} from './chatCommands.js';

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
    expect(result).toMatchObject({
      kind: 'ok',
      action: 'bet',
      echo: '100',
      amountCents: '10000',
    });
    expect(privateBetConfirmationFor(result)).toEqual({
      type: 'bet_confirmation',
      status: 'success',
      action: 'bet',
      amountCents: '10000',
    });
    expect(memory.placeBet).toHaveBeenCalledOnce();
  });

  it('自动降额后公共回显与个人确认都使用实际接受金额', async () => {
    memory.phase = 'BETTING';
    memory.placeBet.mockResolvedValue({
      bet: {},
      requestedCents: 5_000n,
      acceptedCents: 1_100n,
      reservedCents: 18_700n,
      liabilityBalanceCents: 20_000n,
      maxAffordableCents: 1_100n,
      roomMaxCents: 5_000n,
      maxAcceptedCents: 1_100n,
      maxMultiplier: 17,
      liabilityMultiplier: 17,
      adjusted: true,
      adjustedBy: ['LIABILITY_LIMIT'],
    });

    const result = await handleRoomChatCommand({
      roomId: 'room-1',
      userId: 'user-1',
      content: '50',
    });

    expect(result).toMatchObject({
      kind: 'ok',
      action: 'bet',
      echo: '11',
      amountCents: '1100',
      acceptance: {
        requestedAmountCents: '5000',
        liabilityBalanceCents: '20000',
        maxAffordableCents: '1100',
        maxAcceptedCents: '1100',
        maxMultiplier: 17,
        reservedCents: '18700',
        adjusted: true,
        adjustedBy: ['LIABILITY_LIMIT'],
      },
    });
    expect(privateBetConfirmationFor(result)).toMatchObject({
      type: 'bet_confirmation',
      status: 'success',
      action: 'bet',
      amountCents: '1100',
      acceptance: {
        requestedAmountCents: '5000',
        maxAffordableCents: '1100',
        adjusted: true,
      },
    });
  });

  it('下注失败时保留操作类型和金额，供发送个人确认消息', async () => {
    memory.phase = 'BETTING';
    memory.placeBet.mockRejectedValue(new Error('database failure'));

    const result = await handleRoomChatCommand({
      roomId: 'room-1',
      userId: 'user-1',
      content: '500',
    });

    expect(result).toEqual({
      kind: 'error',
      action: 'bet',
      amountCents: '50000',
      message: '下注失败',
    });
  });

  it('下注低于最低额时，失败确认带上可读原因', async () => {
    memory.phase = 'BETTING';
    memory.placeBet.mockRejectedValue(
      new GameError('BELOW_BET_MIN', { betMinCents: 1000 }),
    );

    const result = await handleRoomChatCommand({
      roomId: 'room-1',
      userId: 'user-1',
      content: '5',
    });

    expect(result).toEqual({
      kind: 'error',
      action: 'bet',
      amountCents: '500',
      message: '低于最低下注金额 RM 10.00',
    });
    expect(privateBetConfirmationFor(result)).toEqual({
      type: 'bet_confirmation',
      status: 'failed',
      action: 'bet',
      amountCents: '500',
      reason: '低于最低下注金额 RM 10.00',
    });
  });

  it('超过数据库金额上限时精确拒绝，不先经过 Number 舍入', async () => {
    memory.phase = 'BETTING';
    const result = await handleRoomChatCommand({
      roomId: 'room-1',
      userId: 'user-1',
      content: '92233720368547758.08',
    });

    expect(result).toEqual({
      kind: 'error',
      action: 'bet',
      message: '金额过大，请重新输入',
    });
    expect(memory.placeBet).not.toHaveBeenCalled();
  });

  it('梭哈成功时返回标准分金额，供个人确认消息展示', async () => {
    memory.phase = 'BETTING';
    memory.placeBet.mockResolvedValue({});

    const result = await handleRoomChatCommand({
      roomId: 'room-1',
      userId: 'user-1',
      content: 'sh300',
    });

    expect(result).toMatchObject({
      kind: 'ok',
      action: 'all_in',
      echo: 'sh300',
      amountCents: '30000',
    });
    expect(privateBetConfirmationFor(result)).toEqual({
      type: 'bet_confirmation',
      status: 'success',
      action: 'all_in',
      amountCents: '30000',
    });
  });

  it('下注失败转换为仅发给当前连接的失败确认', () => {
    expect(
      privateBetConfirmationFor({
        kind: 'error',
        action: 'bet',
        amountCents: '50000',
        message: '可用余额不足',
      }),
    ).toEqual({
      type: 'bet_confirmation',
      status: 'failed',
      action: 'bet',
      amountCents: '50000',
      reason: '可用余额不足',
    });
    expect(
      privateBetConfirmationFor({
        kind: 'error',
        action: 'bid',
        amountCents: '50000',
        message: '竞标失败',
      }),
    ).toBeNull();
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

  it('竞标倒计时结束后明确提示正在最终确认', async () => {
    memory.phase = 'BANKER_BID';
    memory.placeBankerBid.mockRejectedValue(new GameError('PHASE_ENDED'));
    const result = await handleRoomChatCommand({
      roomId: 'room-1',
      userId: 'user-1',
      content: '8800',
    });
    expect(result).toEqual({
      kind: 'error',
      message: '竞标已截止，正在进行 3、2、1 最终确认',
    });
  });
});
