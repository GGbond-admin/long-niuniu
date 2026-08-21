import { RoundPhase } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => {
  const rounds = new Map<string, any>();
  const bids = new Map<string, any>();
  const users = new Map<string, any>();
  const wallets = new Map<string, any>();
  const events: any[] = [];
  const room = {
    id: 'room-1',
    gameCode: 'SUPREME_NIUNIU',
    status: 'ACTIVE',
    minPlayers: 2,
    roundStartMode: 'AUTO',
    chatMutedAt: null as Date | null,
    chatMuteReason: null as string | null,
  };
  let roundCounter = 1;
  let bidCounter = 0;

  const baseSettings = {
    hand: {},
    betting: {},
    fees: {
      bankerSeatFeeRatio: 0.01,
      serviceFeeCents: 100,
      packetPerHeadCents: 104,
      rakeRatio: 0.05,
    },
    rebate: {},
    round: {
      bidDurationSeconds: 30,
      betDurationSeconds: 7,
      claimDurationSeconds: 30,
      continuationWindowSeconds: 30,
      bankerBidMinCents: 10_000,
      bankerBidMaxCents: 1_000_000,
      trendLength: 10,
      assistantEnabled: true,
      autoStart: false,
      autoTailPacketEnabled: false,
      autoPublishPacketEnabled: false,
      tailPackerBankerName: 'banker-tail',
      tailPackerPlayerName: 'player-tail',
    },
    rewards: {},
  };

  const matchingRounds = (where: any) =>
    [...rounds.values()].filter((round) => {
      if (where.roomId && round.roomId !== where.roomId) return false;
      if (typeof where.phase === 'string' && round.phase !== where.phase) return false;
      if (where.phase?.in && !where.phase.in.includes(round.phase)) return false;
      return true;
    });

  const roundApi = {
    findUnique: async ({ where, include, select }: any) => {
      const round = where.id
        ? rounds.get(where.id)
        : [...rounds.values()].find(
            (item) =>
              item.roomId === where.roomId_seqNo?.roomId
              && item.seqNo === where.roomId_seqNo?.seqNo,
          );
      if (!round) return null;
      const result: any = { ...round };
      if (include?.room || select?.room) result.room = room;
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
    findFirst: async ({ where, orderBy }: any) => {
      const matches = matchingRounds(where);
      if (orderBy?.seqNo === 'desc') matches.sort((left, right) => right.seqNo - left.seqNo);
      return matches[0] ? { ...matches[0] } : null;
    },
    aggregate: async ({ where }: any) => {
      const seqNos = matchingRounds(where).map((round) => round.seqNo);
      return { _max: { seqNo: seqNos.length ? Math.max(...seqNos) : null } };
    },
    create: async ({ data }: any) => {
      roundCounter += 1;
      const round = {
        id: `round-${roundCounter}`,
        roomId: data.roomId,
        seqNo: data.seqNo,
        phase: data.phase ?? 'WAITING',
        bankerId: null,
        potCents: 0n,
        bankerReservedCents: 0n,
        isContinued: false,
        continuationUsed: false,
        version: 0,
        configSnapshot: null,
        bidEndsAt: null,
        betEndsAt: null,
        finishedAt: null,
      };
      rounds.set(round.id, round);
      return { ...round };
    },
    update: async ({ where, data }: any) => {
      const round = rounds.get(where.id);
      if (!round) throw new Error('ROUND_NOT_FOUND');
      for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === 'object' && 'increment' in value) {
          round[key] += (value as { increment: number }).increment;
        } else {
          round[key] = value;
        }
      }
      return { ...round };
    },
  };

  const bankerBidApi = {
    findUnique: async ({ where }: any) => {
      const key = where.roundId_userId;
      if (!key) return null;
      const existing = [...bids.values()].find(
        (bid) => bid.roundId === key.roundId && bid.userId === key.userId,
      );
      return existing ? { ...existing } : null;
    },
    findFirst: async ({ where }: any) => {
      const matches = [...bids.values()]
        .filter((bid) => bid.roundId === where.roundId)
        .sort((left, right) => {
          if (left.amountCents !== right.amountCents) {
            return left.amountCents > right.amountCents ? -1 : 1;
          }
          return left.createdAt.getTime() - right.createdAt.getTime();
        });
      return matches[0] ? { ...matches[0] } : null;
    },
    upsert: async ({ where, create, update }: any) => {
      const existing = [...bids.values()].find(
        (bid) =>
          bid.roundId === where.roundId_userId.roundId
          && bid.userId === where.roundId_userId.userId,
      );
      if (existing) {
        Object.assign(existing, update);
        return { ...existing };
      }
      bidCounter += 1;
      const bid = {
        id: `bid-${bidCounter}`,
        won: false,
        createdAt: new Date(Date.now() + bidCounter),
        ...create,
      };
      bids.set(bid.id, bid);
      return { ...bid };
    },
    updateMany: async ({ where, data }: any) => {
      for (const bid of bids.values()) {
        if (bid.roundId === where.roundId) Object.assign(bid, data);
      }
      return { count: bids.size };
    },
    update: async ({ where, data }: any) => {
      const bid = bids.get(where.id);
      if (!bid) throw new Error('BID_NOT_FOUND');
      Object.assign(bid, data);
      return { ...bid };
    },
  };

  const prisma = {
    round: roundApi,
    bankerBid: bankerBidApi,
    user: {
      findUnique: async ({ where }: any) => {
        const user = users.get(where.id);
        return user ? { ...user } : null;
      },
    },
    wallet: {
      findUnique: async ({ where }: any) => wallets.get(where.userId) ?? null,
    },
    roomMember: {
      count: async () => 2,
    },
    roundEvent: {
      findFirst: async ({ where }: any) =>
        events.find(
          (item) =>
            item.roundId === where.roundId
            && (typeof where.type !== 'string' || item.type === where.type),
        ) ?? null,
      create: async ({ data }: any) => {
        events.push(data);
        return data;
      },
    },
  };

  const reset = () => {
    rounds.clear();
    bids.clear();
    users.clear();
    wallets.clear();
    events.length = 0;
    roundCounter = 1;
    bidCounter = 0;
    const snapshot = JSON.parse(JSON.stringify(baseSettings));
    rounds.set('round-1', {
      id: 'round-1',
      roomId: room.id,
      seqNo: 1,
      phase: 'BANKER_BID',
      bankerId: null,
      potCents: 0n,
      bankerReservedCents: 0n,
      isContinued: false,
      continuationUsed: false,
      version: 0,
      configSnapshot: snapshot,
      bidEndsAt: new Date(Date.now() + 30_000),
      betEndsAt: null,
      finishedAt: null,
    });
    for (const id of ['banker-a', 'player-b']) {
      const wallet = { userId: id, availableCents: 5_000_000n };
      wallets.set(id, wallet);
      users.set(id, {
        id,
        uid: id,
        nickname: id,
        status: 'ACTIVE',
        kind: 'REAL',
        kyc: { status: 'APPROVED' },
        wallet,
        virtualPlayer: null,
        roomMemberships: [{ roomId: room.id, status: 'ACTIVE' }],
      });
    }
  };

  return {
    baseSettings,
    bids,
    events,
    prisma,
    reset,
    room,
    rounds,
    settings: JSON.parse(JSON.stringify(baseSettings)),
    users,
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
  settingsSnapshot: (value: unknown) => JSON.parse(JSON.stringify(value)),
  setAssistantService: vi.fn(),
}));

vi.mock('./wallet.js', () => ({
  freezeBanker: vi.fn(),
  transfer: vi.fn(),
  unfreeze: vi.fn(),
}));

import {
  closeBidding,
  continueBanker,
  placeBankerBid,
  startRound,
} from './game.js';

function finishRound(roundId: string, finishedAt = new Date()) {
  const round = memory.rounds.get(roundId);
  round.phase = RoundPhase.FINISHED;
  round.finishedAt = finishedAt;
  round.betEndsAt = null;
  round.bankerReservedCents = 0n;
  memory.events.push({
    roundId,
    type: 'ROOM_ANNOUNCED_FINISHED',
    payload: { at: finishedAt.toISOString() },
    createdAt: finishedAt,
  });
}

describe('庄家竞拍与续庄完整循环', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T07:00:00.000Z'));
    memory.reset();
    memory.room.roundStartMode = 'AUTO';
    memory.room.chatMutedAt = null;
    memory.room.chatMuteReason = null;
    memory.settings = JSON.parse(JSON.stringify(memory.baseSettings));
  });

  it('手动单局只接受运营显式开局，不接受自动来源绕过', async () => {
    const waiting = memory.rounds.get('round-1');
    waiting.phase = RoundPhase.WAITING;
    memory.room.roundStartMode = 'MANUAL';

    await expect(
      startRound(waiting.id, false, undefined, 'AUTO'),
    ).rejects.toMatchObject({ code: 'ROUND_START_DISABLED' });

    await expect(
      startRound(waiting.id, false, undefined, 'MANUAL'),
    ).resolves.toMatchObject({ phase: RoundPhase.BANKER_BID });
  });

  it('全群禁言时任何来源都不能开启新一局', async () => {
    const waiting = memory.rounds.get('round-1');
    waiting.phase = RoundPhase.WAITING;
    memory.room.roundStartMode = 'AUTO';
    memory.room.chatMutedAt = new Date('2026-08-07T07:00:00.000Z');
    memory.room.chatMuteReason = '运营全群禁言';

    await expect(
      startRound(waiting.id, false, undefined, 'AUTO'),
    ).rejects.toMatchObject({ code: 'ROOM_GLOBAL_MUTED' });
    expect(waiting.phase).toBe(RoundPhase.WAITING);
  });

  it('最高价中标，续一次后强制重拍，原庄可再次中标并重新获得续庄资格', async () => {
    await placeBankerBid('round-1', 'player-b', 40_000n);
    await placeBankerBid('round-1', 'banker-a', 50_000n);
    const first = await closeBidding('round-1');
    expect(first).toMatchObject({
      bankerId: 'banker-a',
      potCents: 50_000n,
      phase: RoundPhase.BETTING,
    });

    finishRound('round-1', new Date(Date.now() - 2_000));
    memory.settings = {
      ...memory.settings,
      fees: {
        ...memory.settings.fees,
        bankerSeatFeeRatio: 0.2,
        serviceFeeCents: 5_000,
      },
      round: {
        ...memory.settings.round,
        betDurationSeconds: 99,
        continuationWindowSeconds: 1,
      },
    };

    const second = await continueBanker('round-1', 'banker-a');
    expect(second).toMatchObject({
      seqNo: 2,
      bankerId: 'banker-a',
      phase: RoundPhase.BETTING,
      isContinued: true,
      continuationUsed: true,
      bankerReservedCents: 50_600n,
    });
    expect(second.betEndsAt?.getTime()).toBe(Date.now() + 7_000);
    expect(second.configSnapshot).toEqual(memory.baseSettings);

    finishRound(second.id);
    await expect(continueBanker(second.id, 'banker-a')).rejects.toMatchObject({
      code: 'CONTINUATION_ALREADY_USED',
    });

    const thirdWaiting = [...memory.rounds.values()].find((round) => round.seqNo === 3);
    expect(thirdWaiting?.phase).toBe(RoundPhase.WAITING);
    await startRound(thirdWaiting.id, true, undefined, 'AUTO');
    await placeBankerBid(thirdWaiting.id, 'player-b', 60_000n);
    await placeBankerBid(thirdWaiting.id, 'banker-a', 70_000n);
    const third = await closeBidding(thirdWaiting.id);
    expect(third).toMatchObject({
      seqNo: 3,
      bankerId: 'banker-a',
      potCents: 70_000n,
      phase: RoundPhase.BETTING,
      isContinued: false,
      continuationUsed: false,
    });

    finishRound(third.id);
    const fourth = await continueBanker(third.id, 'banker-a');
    expect(fourth).toMatchObject({
      seqNo: 4,
      bankerId: 'banker-a',
      phase: RoundPhase.BETTING,
      isContinued: true,
    });
  });

  it('庄家竞标只接受整元金额', async () => {
    await expect(
      placeBankerBid('round-1', 'player-b', 40_050n),
    ).rejects.toMatchObject({
      code: 'BID_MUST_BE_INTEGER',
    });
    expect(memory.bids.size).toBe(0);
  });

  it('多人可同时出价，截标锁定最高有效价；不能把自己已经出过的价改低', async () => {
    const first = await placeBankerBid('round-1', 'player-b', 40_000n);
    expect(first.amountCents).toBe(40_000n);

    const concurrent = await placeBankerBid('round-1', 'banker-a', 49_000n);
    expect(concurrent.amountCents).toBe(49_000n);

    const kept = await placeBankerBid('round-1', 'player-b', 30_000n);
    expect(kept.amountCents).toBe(40_000n);

    const jumped = await placeBankerBid('round-1', 'banker-a', 900_000n);
    expect(jumped.amountCents).toBe(900_000n);

    const raised = await placeBankerBid('round-1', 'player-b', 950_000n);
    expect(raised.amountCents).toBe(950_000n);

    const closed = await closeBidding('round-1');
    expect(closed).toMatchObject({
      bankerId: 'player-b',
      potCents: 950_000n,
      phase: RoundPhase.BETTING,
    });
  });

  it('名义截止后到 3/2/1 播报结束前仍可竞价，最终名单发出后拒绝', async () => {
    await placeBankerBid('round-1', 'player-b', 40_000n);
    const round = memory.rounds.get('round-1');
    round.bidEndsAt = new Date(Date.now() - 1_000);
    memory.events.push({
      roundId: 'round-1',
      type: 'BID_COUNTDOWN_3',
      payload: { digit: '3' },
    });

    const duringThree = await placeBankerBid('round-1', 'banker-a', 90_000n);
    expect(duringThree.amountCents).toBe(90_000n);
    expect(duringThree.extendedEndsAt).toBeNull();

    memory.events.push({
      roundId: 'round-1',
      type: 'BID_COUNTDOWN_1',
      payload: { digit: '1' },
    });
    const duringOne = await placeBankerBid('round-1', 'player-b', 120_000n);
    expect(duringOne.amountCents).toBe(120_000n);

    memory.events.push({
      roundId: 'round-1',
      type: 'BID_FINAL_LIST',
      payload: { at: new Date().toISOString() },
    });
    await expect(
      placeBankerBid('round-1', 'banker-a', 70_000n),
    ).rejects.toMatchObject({
      code: 'PHASE_ENDED',
    });
  });

  it('最后 5 秒内每次有效加价都重置为 5 秒，时间充裕时不延长', async () => {
    const round = memory.rounds.get('round-1');
    await placeBankerBid('round-1', 'player-b', 40_000n);

    // 剩 3 秒时出现新高价 → 截止时间重置为 now + 5 秒
    round.bidEndsAt = new Date(Date.now() + 3_000);
    const higher = await placeBankerBid('round-1', 'banker-a', 90_000n);
    expect(higher.amountCents).toBe(90_000n);
    expect(higher.extendedEndsAt?.getTime()).toBe(Date.now() + 5_000);
    expect(memory.rounds.get('round-1').bidEndsAt.getTime()).toBe(Date.now() + 5_000);

    // 下一口可以加更多，新的最高价才会重置 5 秒
    round.bidEndsAt = new Date(Date.now() + 3_000);
    const next = await placeBankerBid('round-1', 'player-b', 120_000n);
    expect(next.amountCents).toBe(120_000n);
    expect(next.extendedEndsAt?.getTime()).toBe(Date.now() + 5_000);
    expect(memory.rounds.get('round-1').bidEndsAt.getTime()).toBe(Date.now() + 5_000);

    // 剩余时间超过 5 秒时的新高价 → 不延长
    round.bidEndsAt = new Date(Date.now() + 20_000);
    const early = await placeBankerBid('round-1', 'player-b', 150_000n);
    expect(early.amountCents).toBe(150_000n);
    expect(early.extendedEndsAt).toBeNull();
    expect(memory.rounds.get('round-1').bidEndsAt.getTime()).toBe(Date.now() + 20_000);
  });

  it('出价超过可上庄余额时自动降到上限并标记调整', async () => {
    const { maxAffordableBankerBidCents } = await import('../engine/fees.js');
    memory.users.get('player-b').wallet.availableCents = 500_000n;
    const cap = maxAffordableBankerBidCents(
      500_000,
      memory.settings.fees,
      memory.settings.round.bankerBidMaxCents,
    );
    const result = await placeBankerBid('round-1', 'player-b', 1_000_000n);
    expect(result.amountCents).toBe(BigInt(cap));
    expect(result.adjusted).toBe(true);
    expect(result.requestedAmountCents).toBe(1_000_000n);
  });

  it('可上庄余额不够出到当前最高时仍可按自己的上限出价，截标再取最高', async () => {
    await placeBankerBid('round-1', 'banker-a', 400_000n);
    memory.users.get('player-b').wallet.availableCents = 200_000n;
    const { maxAffordableBankerBidCents } = await import('../engine/fees.js');
    const cap = maxAffordableBankerBidCents(
      200_000,
      memory.settings.fees,
      memory.settings.round.bankerBidMaxCents,
    );
    const result = await placeBankerBid('round-1', 'player-b', 500_000n);
    expect(result.amountCents).toBe(BigInt(cap));
    expect(result.adjusted).toBe(true);
    expect(cap).toBeLessThan(400_000);
  });

  it('截标时跳过已失去资格的最高出价者', async () => {
    await placeBankerBid('round-1', 'player-b', 40_000n);
    await placeBankerBid('round-1', 'banker-a', 50_000n);
    memory.users.get('banker-a').status = 'SUSPENDED';

    const round = await closeBidding('round-1');

    expect(round).toMatchObject({
      bankerId: 'player-b',
      potCents: 40_000n,
      phase: RoundPhase.BETTING,
    });
  });

  it('来源局缺失配置快照时禁止续庄，避免使用实时费用和时长', async () => {
    const first = memory.rounds.get('round-1');
    first.phase = RoundPhase.FINISHED;
    first.bankerId = 'banker-a';
    first.potCents = 50_000n;
    first.finishedAt = new Date();
    first.configSnapshot = null;

    await expect(continueBanker(first.id, 'banker-a')).rejects.toMatchObject({
      code: 'ROUND_CONFIG_SNAPSHOT_MISSING',
    });
  });

  it('成绩单完成事件落库前禁止按钮续庄', async () => {
    const first = memory.rounds.get('round-1');
    first.phase = RoundPhase.FINISHED;
    first.bankerId = 'banker-a';
    first.potCents = 50_000n;
    first.finishedAt = new Date(Date.now() - 20_000);

    await expect(continueBanker(first.id, 'banker-a')).rejects.toMatchObject({
      code: 'CONTINUATION_NOT_STARTED',
    });
  });
});
