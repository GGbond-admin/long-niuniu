import {
  AccountType,
  type Bet,
  BetStatus,
  ClaimSource,
  KycStatus,
  PacketChannel,
  Prisma,
  RoundPhase,
  RoomStartMode,
  UserKind,
  UserStatus,
} from '@prisma/client';
import { randomInt } from 'node:crypto';
import { bankerContinuationError } from '../engine/bankerContinuation.js';
import {
  acceptBetAmount,
  bettingRange,
  MAX_MONEY_CENTS,
  type BetAdjustmentReason,
} from '../engine/betting.js';
import {
  bankerBidReserveCents,
  bankerSeatFee,
  maxAffordableBankerBidCents,
  packetTotal,
} from '../engine/fees.js';
import { evaluateHand, HAND_LABEL, maxPayoutMultiplier } from '../engine/hand.js';
import {
  effectiveTurnoverForBanker,
  effectiveTurnoverForPlayer,
} from '../engine/rebate.js';
import {
  bankerTrendLabelFromSummary,
  continueBankerTrend,
  settleRound as calculateSettlement,
} from '../engine/settlement.js';
import { env } from '../config.js';
import { blindIndex, decryptSecret, encryptSecret, normalizeIdentity } from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';
import { checkTngClaimLink, checkTngDeepLink } from '../lib/tngPacketUrl.js';
import { serializable } from '../lib/transaction.js';
import {
  getGameSettings,
  parseSettingsSnapshot,
  setAssistantService,
  settingsSnapshot,
} from './gameSettings.js';
import {
  CONTINUATION_REJECTED_INSUFFICIENT,
  ROOM_ANNOUNCED_FINISHED,
} from './roomChatPolicy.js';
import { freezeBanker, transfer, unfreeze } from './wallet.js';

/** 与 VirtualPlayer 能力字段对齐；避免 circular import virtualPlayers.ts */
export type VirtualCapability =
  | 'join'
  | 'chat'
  | 'bid'
  | 'bet'
  | 'allIn'
  | 'banker'
  | 'continue'
  | 'dice'
  | 'groupPacket'
  | 'claimGroupPacket'
  | 'claimSim';

type Tx = Prisma.TransactionClient;

const ACTIVE_PHASES: RoundPhase[] = [
  RoundPhase.WAITING,
  RoundPhase.BANKER_BID,
  RoundPhase.BETTING,
  RoundPhase.SENDING_PACKET,
  RoundPhase.CLAIMING,
  RoundPhase.CLAIM_EXPIRED,
  RoundPhase.SETTLING,
];

function isClaimReviewPhase(phase: RoundPhase): boolean {
  return phase === RoundPhase.CLAIMING || phase === RoundPhase.CLAIM_EXPIRED;
}

export class GameError extends Error {
  constructor(
    public code: string,
    public details?: Record<string, unknown>,
  ) {
    super(code);
  }
}

export type RoundStartSource = 'MANUAL' | 'AUTO' | 'REPLACEMENT';

function roomModeAllowsStart(mode: RoomStartMode, source: RoundStartSource): boolean {
  if (source === 'MANUAL') return mode === RoomStartMode.MANUAL;
  if (source === 'AUTO') return mode === RoomStartMode.AUTO;
  return mode !== RoomStartMode.STOPPED;
}

function safeNumber(value: bigint, field: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new GameError('AMOUNT_TOO_LARGE', { field });
  return result;
}

function malaysiaDay(date = new Date()): string {
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kuala_Lumpur' });
}

function totalBalance(wallet: {
  availableCents: bigint;
  freezeBankerCents: bigint;
  freezeBetCents: bigint;
  freezeWithdrawCents: bigint;
}): bigint {
  return (
    wallet.availableCents +
    wallet.freezeBankerCents +
    wallet.freezeBetCents +
    wallet.freezeWithdrawCents
  );
}

/** 部署前旧下注没有 reservedCents，只实际冻结了本金；按本金安全回退。 */
function reservedCentsOf(bet: { amountCents: bigint; reservedCents?: bigint | null }): bigint {
  return bet.reservedCents && bet.reservedCents > 0n ? bet.reservedCents : bet.amountCents;
}

async function requireGameUser(
  tx: Tx,
  userId: string,
  roomId: string,
  capability?: VirtualCapability,
) {
  const user = await tx.user.findUnique({
    where: { id: userId },
    include: {
      kyc: true,
      wallet: true,
      virtualPlayer: true,
      roomMemberships: { where: { roomId }, take: 1 },
    },
  });
  if (!user || user.status !== UserStatus.ACTIVE) throw new GameError('USER_NOT_ACTIVE');
  if (!user.kyc || user.kyc.status !== KycStatus.APPROVED) throw new GameError('KYC_REQUIRED');
  if (!user.wallet) throw new GameError('WALLET_NOT_FOUND');
  if (user.roomMemberships[0]?.status !== 'ACTIVE') throw new GameError('NOT_IN_ROOM');
  if (user.kind === UserKind.VIRTUAL) {
    const profile = user.virtualPlayer;
    if (!profile || !profile.enabled) throw new GameError('VIRTUAL_DISABLED');
    if (profile.roomId !== roomId) throw new GameError('VIRTUAL_WRONG_ROOM');
    if (capability) {
      // 在事务外读库的 assert 与此处字段一致，避免重复查询。
      const map: Record<VirtualCapability, boolean> = {
        join: profile.canJoin,
        chat: profile.canChat,
        bid: profile.canBid && profile.canBanker,
        bet: profile.canBet,
        allIn: profile.canAllIn,
        banker: profile.canBanker,
        continue: profile.canContinue,
        dice: profile.canThrowDice,
        groupPacket: profile.canGroupPacket,
        claimGroupPacket: profile.canClaimGroupPacket,
        claimSim: profile.canClaimSim,
      };
      if (!map[capability]) {
        throw new GameError('VIRTUAL_CAPABILITY_DENIED', { capability });
      }
    }
  }
  return { ...user, wallet: user.wallet };
}

async function event(
  tx: Tx,
  roundId: string,
  type: string,
  payload?: Prisma.InputJsonValue,
  actorId?: string,
) {
  await tx.roundEvent.create({ data: { roundId, type, payload, actorId } });
}

type JoinRoomOptions = {
  /**
   * HTTP 玩家路由已经完成 authUser + requireKyc 时可跳过重复用户查询。
   * 服务端虚拟玩家调用不传此项，继续走完整能力校验。
   */
  validatedHuman?: boolean;
  /** 限定网页入口可加入的游戏；虚拟玩家内部调度不限制。 */
  allowedGameCodes?: readonly string[];
};

/** 网页游戏房进房：需实名通过；成为房间活跃成员后方可竞标/下注/抢包 */
export async function joinRoom(
  roomId: string,
  userId: string,
  options: JoinRoomOptions = {},
) {
  const roomLookup = options.allowedGameCodes?.length
    ? prisma.room.findFirst({
        where: {
          id: roomId,
          gameCode: { in: [...options.allowedGameCodes] },
        },
      })
    : prisma.room.findUnique({ where: { id: roomId } });
  const userLookup = options.validatedHuman
    ? Promise.resolve(null)
    : prisma.user.findUnique({
        where: { id: userId },
        include: { kyc: true, virtualPlayer: true },
      });
  const [room, user] = await Promise.all([
    roomLookup,
    userLookup,
  ]);
  if (!room || room.status !== 'ACTIVE') throw new GameError('ROOM_NOT_FOUND');
  if (!options.validatedHuman) {
    if (!user || user.status !== UserStatus.ACTIVE) throw new GameError('USER_NOT_ACTIVE');
    if (user.kyc?.status !== KycStatus.APPROVED) throw new GameError('KYC_REQUIRED');
    if (user.kind === UserKind.VIRTUAL) {
      const profile = user.virtualPlayer;
      if (!profile || !profile.enabled || !profile.canJoin) {
        throw new GameError('VIRTUAL_CAPABILITY_DENIED', { capability: 'join' });
      }
      if (profile.roomId !== roomId) throw new GameError('VIRTUAL_WRONG_ROOM');
    }
  }
  const existing = await prisma.roomMember.findUnique({
    where: { roomId_userId: { roomId, userId } },
  });
  if (existing?.status === 'BANNED') throw new GameError('ROOM_BANNED');
  if (existing?.status === 'ACTIVE') return { room, member: existing };
  const member = await prisma.roomMember.upsert({
    where: { roomId_userId: { roomId, userId } },
    create: { roomId, userId },
    update: { status: 'ACTIVE', lastSeenAt: new Date() },
  });
  return { room, member };
}

/** 网页游戏房离房（不影响进行中的冻结注码，结算仍按已下注处理） */
export async function leaveRoom(roomId: string, userId: string) {
  await prisma.roomMember.updateMany({
    where: { roomId, userId, status: 'ACTIVE' },
    data: { status: 'LEFT', lastSeenAt: new Date() },
  });
}

export async function touchRoomPresence(roomId: string, userId: string) {
  await prisma.roomMember.updateMany({
    where: { roomId, userId, status: 'ACTIVE' },
    data: { lastSeenAt: new Date() },
  });
}

/** Telegram 群成员进群 / 发言：按 chatId+botId 关联房间并标记活跃成员 */
export async function touchRoomMember(chatId: bigint, botId: string, tgId: bigint) {
  const [room, user] = await Promise.all([
    prisma.room.findFirst({ where: { chatId, botId, status: 'ACTIVE' } }),
    prisma.user.findUnique({ where: { tgId } }),
  ]);
  if (!room || !user) return null;
  await prisma.roomMember.upsert({
    where: { roomId_userId: { roomId: room.id, userId: user.id } },
    create: { roomId: room.id, userId: user.id },
    update: { status: 'ACTIVE', lastSeenAt: new Date() },
  });
  return { room, user };
}

/** Telegram 群成员退群：标记 LEFT，阻止继续竞标/下注 */
export async function markRoomMemberLeft(chatId: bigint, botId: string, tgId: bigint) {
  const room = await prisma.room.findFirst({ where: { chatId, botId } });
  const user = await prisma.user.findUnique({ where: { tgId } });
  if (!room || !user) return;
  await prisma.roomMember.updateMany({
    where: { roomId: room.id, userId: user.id },
    data: { status: 'LEFT', lastSeenAt: new Date() },
  });
}

export async function ensureWaitingRound(roomId: string) {
  return serializable(async (tx) => {
    const existing = await tx.round.findFirst({
      where: { roomId, phase: { in: ACTIVE_PHASES } },
      orderBy: { seqNo: 'desc' },
    });
    if (existing) return existing;
    const latest = await tx.round.aggregate({ where: { roomId }, _max: { seqNo: true } });
    return tx.round.create({
      data: { roomId, seqNo: (latest._max.seqNo ?? 0) + 1, phase: RoundPhase.WAITING },
    });
  });
}

export async function startRound(
  roundId: string,
  force = false,
  actorId?: string,
  source: RoundStartSource = 'MANUAL',
) {
  const identity = await prisma.round.findUnique({
    where: { id: roundId },
    select: { room: { select: { gameCode: true } } },
  });
  if (!identity) throw new GameError('ROUND_NOT_FOUND');
  const settings = await getGameSettings(identity.room.gameCode);
  return serializable(async (tx) => {
    const round = await tx.round.findUnique({
      where: { id: roundId },
      include: { room: true },
    });
    if (!round) throw new GameError('ROUND_NOT_FOUND');
    if (round.phase !== RoundPhase.WAITING) throw new GameError('INVALID_PHASE');
    if (round.room.status !== 'ACTIVE') throw new GameError('ROOM_PAUSED');
    if (round.room.chatMutedAt) {
      throw new GameError('ROOM_GLOBAL_MUTED', {
        mutedAt: round.room.chatMutedAt.toISOString(),
        reason: round.room.chatMuteReason,
      });
    }
    const roomStartMode = round.room.roundStartMode ?? RoomStartMode.MANUAL;
    if (!roomModeAllowsStart(roomStartMode, source)) {
      throw new GameError('ROUND_START_DISABLED', {
        roomStartMode,
        source,
      });
    }

    const eligibleCount = await tx.roomMember.count({
      where: {
        roomId: round.roomId,
        status: 'ACTIVE',
        user: { status: 'ACTIVE', kyc: { status: 'APPROVED' } },
      },
    });
    if (!force && eligibleCount < round.room.minPlayers) {
      throw new GameError('NOT_ENOUGH_PLAYERS', {
        eligibleCount,
        minPlayers: round.room.minPlayers,
      });
    }
    const bidEndsAt = new Date(Date.now() + settings.round.bidDurationSeconds * 1000);
    const updated = await tx.round.update({
      where: { id: round.id },
      data: {
        phase: RoundPhase.BANKER_BID,
        bidEndsAt,
        configSnapshot: settingsSnapshot(settings),
        version: { increment: 1 },
      },
    });
    await event(
      tx,
      round.id,
      'ROUND_STARTED',
      { eligibleCount, bidEndsAt: bidEndsAt.toISOString() },
      actorId,
    );
    return updated;
  });
}

/**
 * 竞标防狙击：主计时最后 5 秒内出现新的最高价时，把剩余时间拉回 5 秒。
 * 3/2/1 已开始后仍接受出价，但不再打断最终倒数。
 */
const BID_EXTENSION_WINDOW_MS = 5_000;
/** 播报「下一口参考」与假人加价步长：当前最高 + RM100。截标仍按全场最高有效价锁定庄家。 */
export const BANKER_BID_INCREMENT_CENTS = 10_000n;

export async function placeBankerBid(roundId: string, userId: string, amountCents: bigint) {
  if (amountCents <= 0n) throw new GameError('INVALID_AMOUNT');
  if (amountCents % 100n !== 0n) throw new GameError('BID_MUST_BE_INTEGER');
  return serializable(async (tx) => {
    const round = await tx.round.findUnique({ where: { id: roundId } });
    if (!round) throw new GameError('ROUND_NOT_FOUND');
    if (round.phase !== RoundPhase.BANKER_BID) throw new GameError('INVALID_PHASE');
    if (!round.bidEndsAt) throw new GameError('PHASE_ENDED');
    // 名义计时结束后仍开放最后喊价；3、2、1 播完并公布最终名单后才封盘。
    const finalListSent = await tx.roundEvent.findFirst({
      where: { roundId, type: 'BID_FINAL_LIST' },
      select: { id: true },
    });
    if (finalListSent) throw new GameError('PHASE_ENDED');

    const [topBid, ownBid] = await Promise.all([
      tx.bankerBid.findFirst({
        where: { roundId },
        orderBy: [{ amountCents: 'desc' }, { createdAt: 'asc' }],
        select: { amountCents: true },
      }),
      tx.bankerBid.findUnique({
        where: { roundId_userId: { roundId, userId } },
        select: { amountCents: true },
      }),
    ]);
    const settings = parseSettingsSnapshot(round.configSnapshot);
    const user = await requireGameUser(tx, userId, round.roomId, 'bid');
    const roomMinCents = BigInt(settings.round.bankerBidMinCents);
    const roomMaxCents = BigInt(settings.round.bankerBidMaxCents);
    const walletCapCents = BigInt(
      maxAffordableBankerBidCents(
        safeNumber(user.wallet.availableCents, 'available'),
        settings.fees,
        settings.round.bankerBidMaxCents,
      ),
    );
    if (amountCents > roomMaxCents) {
      throw new GameError('BID_OUT_OF_RANGE', {
        minCents: settings.round.bankerBidMinCents,
        maxCents: settings.round.bankerBidMaxCents,
      });
    }
    let acceptedAmountCents = amountCents;
    let adjusted = false;
    if (acceptedAmountCents > walletCapCents) {
      if (walletCapCents < roomMinCents) {
        throw new GameError('BANKER_BID_CAP_TOO_LOW', {
          maxCents: walletCapCents,
          minimumCents: roomMinCents,
        });
      }
      acceptedAmountCents = walletCapCents;
      adjusted = true;
    } else if (acceptedAmountCents < roomMinCents) {
      throw new GameError('BID_OUT_OF_RANGE', {
        minCents: settings.round.bankerBidMinCents,
        maxCents: settings.round.bankerBidMaxCents,
      });
    }
    // 多人可同时出价；各自金额都收下，截标再取最高。不能把自己已经出过的价改低。
    if (ownBid && acceptedAmountCents < ownBid.amountCents) {
      acceptedAmountCents = ownBid.amountCents;
    }
    const amount = safeNumber(acceptedAmountCents, 'bid');
    if (user.wallet.availableCents < BigInt(bankerBidReserveCents(amount, settings.fees))) {
      throw new GameError('BANKER_BID_CAP_TOO_LOW', {
        maxCents: walletCapCents,
        minimumCents: roomMinCents,
      });
    }
    if (ownBid && acceptedAmountCents === ownBid.amountCents) {
      const existing = await tx.bankerBid.findUnique({
        where: { roundId_userId: { roundId, userId } },
      });
      if (!existing) throw new GameError('ROUND_NOT_FOUND');
      return {
        ...existing,
        extendedEndsAt: null,
        requestedAmountCents: amountCents,
        adjusted,
      };
    }
    // 只有新的全场最高价才重置最后 5 秒，避免同时喊低价把倒计时一直拉长。
    const now = Date.now();
    let extendedEndsAt: Date | null = null;
    const isNewHigh = acceptedAmountCents > (topBid?.amountCents ?? 0n);
    if (isNewHigh && round.bidEndsAt.getTime() - now <= BID_EXTENSION_WINDOW_MS) {
      // 3 已经播出后保持 3→2→1 连续推进；期间仍可继续出价。
      const finalCountdownStarted = await tx.roundEvent.findFirst({
        where: { roundId, type: 'BID_COUNTDOWN_3' },
        select: { id: true },
      });
      if (!finalCountdownStarted) {
        extendedEndsAt = new Date(now + BID_EXTENSION_WINDOW_MS);
      }
    }
    const bid = await tx.bankerBid.upsert({
      where: { roundId_userId: { roundId, userId } },
      create: { roundId, userId, amountCents: acceptedAmountCents },
      update: { amountCents: acceptedAmountCents, won: false, createdAt: new Date() },
    });
    if (extendedEndsAt) {
      await tx.round.update({
        where: { id: roundId },
        data: { bidEndsAt: extendedEndsAt, version: { increment: 1 } },
      });
      await event(
        tx,
        roundId,
        'BID_TIME_EXTENDED',
        {
          bidEndsAt: extendedEndsAt.toISOString(),
          amountCents: String(acceptedAmountCents),
        },
        userId,
      );
    }
    await event(
      tx,
      roundId,
      'BANKER_BID_PLACED',
      { amountCents: String(acceptedAmountCents) },
      userId,
    );
    return { ...bid, extendedEndsAt, requestedAmountCents: amountCents, adjusted };
  });
}

export async function closeBidding(roundId: string) {
  return serializable(async (tx) => {
    const round = await tx.round.findUnique({
      where: { id: roundId },
      include: { bids: { orderBy: [{ amountCents: 'desc' }, { createdAt: 'asc' }] } },
    });
    if (!round) throw new GameError('ROUND_NOT_FOUND');
    if (round.phase !== RoundPhase.BANKER_BID) {
      if (round.phase === RoundPhase.BETTING || round.phase === RoundPhase.CANCELLED) return round;
      throw new GameError('INVALID_PHASE');
    }
    const settings = parseSettingsSnapshot(round.configSnapshot);
    let winningBid: (typeof round.bids)[number] | null = null;
    let reserveCents = 0n;
    for (const bid of round.bids) {
      let bidder: Awaited<ReturnType<typeof requireGameUser>>;
      try {
        // 出价后到截标前，账号/KYC/房间成员/虚拟玩家能力都可能变化，必须重新验资验权。
        bidder = await requireGameUser(tx, bid.userId, round.roomId, 'bid');
      } catch (error) {
        if (error instanceof GameError) continue;
        throw error;
      }
      const amount = safeNumber(bid.amountCents, 'bid');
      const required = BigInt(bankerBidReserveCents(amount, settings.fees));
      if (bidder.wallet.availableCents >= required) {
        winningBid = bid;
        reserveCents = required;
        break;
      }
    }
    if (!winningBid) {
      const cancelled = await tx.round.update({
        where: { id: round.id },
        data: {
          phase: RoundPhase.CANCELLED,
          cancelReason: 'NO_VALID_BANKER_BID',
          finishedAt: new Date(),
          version: { increment: 1 },
        },
      });
      await event(tx, round.id, 'ROUND_CANCELLED', { reason: 'NO_VALID_BANKER_BID' });
      return cancelled;
    }

    await freezeBanker(
      tx,
      winningBid.userId,
      reserveCents,
      round.id,
      `reserve:${winningBid.id}`,
    );
    const betEndsAt = new Date(Date.now() + settings.round.betDurationSeconds * 1000);
    await tx.bankerBid.updateMany({
      where: { roundId: round.id },
      data: { won: false },
    });
    await tx.bankerBid.update({ where: { id: winningBid.id }, data: { won: true } });
    const updated = await tx.round.update({
      where: { id: round.id },
      data: {
        bankerId: winningBid.userId,
        potCents: winningBid.amountCents,
        bankerReservedCents: reserveCents,
        phase: RoundPhase.BETTING,
        betEndsAt,
        version: { increment: 1 },
      },
    });
    await event(tx, round.id, 'BANKER_SELECTED', {
      bankerId: winningBid.userId,
      potCents: String(winningBid.amountCents),
      betEndsAt: betEndsAt.toISOString(),
    });
    return updated;
  });
}

export interface PlaceBetResult {
  bet: Bet;
  requestedCents: bigint;
  acceptedCents: bigint;
  reservedCents: bigint;
  liabilityBalanceCents: bigint;
  maxAffordableCents: bigint;
  roomMaxCents: bigint;
  maxAcceptedCents: bigint;
  maxMultiplier: number;
  /** 本笔按几倍预留最大赔付：普通=本局最高牌型倍数，梭哈=1 */
  liabilityMultiplier: number;
  adjusted: boolean;
  adjustedBy: BetAdjustmentReason[];
}

export async function placeBet(
  roundId: string,
  userId: string,
  requestedCents: bigint,
  isAllIn: boolean,
): Promise<PlaceBetResult> {
  if (requestedCents <= 0n) throw new GameError('INVALID_AMOUNT');
  if (requestedCents > MAX_MONEY_CENTS) throw new GameError('AMOUNT_TOO_LARGE');
  return serializable(async (tx) => {
    const round = await tx.round.findUnique({ where: { id: roundId } });
    if (!round) throw new GameError('ROUND_NOT_FOUND');
    if (round.phase !== RoundPhase.BETTING) throw new GameError('INVALID_PHASE');
    if (!round.betEndsAt || round.betEndsAt <= new Date()) throw new GameError('PHASE_ENDED');
    if (round.bankerId === userId) throw new GameError('BANKER_CANNOT_BET');
    const user = await requireGameUser(tx, userId, round.roomId, isAllIn ? 'allIn' : 'bet');
    const settings = parseSettingsSnapshot(round.configSnapshot);
    const range = bettingRange(
      safeNumber(round.potCents, 'pot'),
      settings.betting,
    );

    const existing = await tx.bet.findUnique({
      where: { roundId_userId: { roundId, userId } },
    });
    if (
      existing &&
      existing.status !== BetStatus.FROZEN &&
      existing.status !== BetStatus.WITHDRAWN
    ) {
      throw new GameError('BET_NOT_EDITABLE');
    }

    const existingReservedCents =
      existing?.status === BetStatus.FROZEN ? reservedCentsOf(existing) : 0n;
    const liabilityBalanceCents = user.wallet.availableCents + existingReservedCents;
    const maxMultiplier = maxPayoutMultiplier(settings.hand);
    const acceptance = acceptBetAmount({
      requestedCents,
      liabilityBalanceCents,
      maxMultiplier,
      isAllIn,
      range,
    });
    if (!acceptance.ok) {
      throw new GameError(acceptance.reason, {
        ...range,
        liabilityBalanceCents: String(liabilityBalanceCents),
        maxAffordableCents: String(acceptance.maxAffordableCents),
        maxAcceptedCents: String(acceptance.maxAcceptedCents),
        maxMultiplier,
        liabilityMultiplier: acceptance.liabilityMultiplier,
      });
    }

    const amountCents = acceptance.acceptedCents;
    const reservedCents = acceptance.reservedCents;
    const revision = (existing?.revision ?? -1) + 1;
    if (!existing || existing.status === BetStatus.WITHDRAWN) {
      const bet = existing
        ? await tx.bet.update({
            where: { id: existing.id },
            data: {
              amountCents,
              reservedCents,
              isAllIn,
              status: BetStatus.FROZEN,
              revision,
              // 撤注后重新下注应重新排队，避免沿用首次下注时间抢占赔付优先级。
              createdAt: new Date(),
            },
          })
        : await tx.bet.create({
            data: { roundId, userId, amountCents, reservedCents, isAllIn, revision },
          });
      await transfer(tx, {
        amountCents: reservedCents,
        from: { userId, accountType: AccountType.USER_AVAILABLE },
        to: { userId, accountType: AccountType.USER_FREEZE_BET },
        refType: 'bet_liability_reserve',
        refId: bet.id,
        roundId,
        idempotencyKey: `bet:${roundId}:${userId}:v${revision}`,
      });
      await event(tx, roundId, 'BET_PLACED', {
        userId,
        requestedCents: String(requestedCents),
        amountCents: String(amountCents),
        reservedCents: String(reservedCents),
        liabilityBalanceCents: String(liabilityBalanceCents),
        maxAffordableCents: String(acceptance.maxAffordableCents),
        maxAcceptedCents: String(acceptance.maxAcceptedCents),
        maxMultiplier,
        liabilityMultiplier: acceptance.liabilityMultiplier,
        adjustedBy: acceptance.adjustedBy,
        isAllIn,
        revision,
      });
      return {
        bet,
        requestedCents,
        acceptedCents: amountCents,
        reservedCents,
        liabilityBalanceCents,
        maxAffordableCents: acceptance.maxAffordableCents,
        roomMaxCents: acceptance.roomMaxCents,
        maxAcceptedCents: acceptance.maxAcceptedCents,
        maxMultiplier,
        liabilityMultiplier: acceptance.liabilityMultiplier,
        adjusted: acceptance.adjusted,
        adjustedBy: acceptance.adjustedBy,
      };
    }

    const difference = reservedCents - existingReservedCents;
    if (difference > 0n) {
      await transfer(tx, {
        amountCents: difference,
        from: { userId, accountType: AccountType.USER_AVAILABLE },
        to: { userId, accountType: AccountType.USER_FREEZE_BET },
        refType: 'bet_liability_adjust',
        refId: existing.id,
        roundId,
        idempotencyKey: `bet-adjust:${roundId}:${userId}:v${revision}`,
      });
    } else if (difference < 0n) {
      await transfer(tx, {
        amountCents: -difference,
        from: { userId, accountType: AccountType.USER_FREEZE_BET },
        to: { userId, accountType: AccountType.USER_AVAILABLE },
        refType: 'bet_liability_adjust',
        refId: existing.id,
        roundId,
        idempotencyKey: `bet-adjust:${roundId}:${userId}:v${revision}`,
      });
    }
    const bet = await tx.bet.update({
      where: { id: existing.id },
      data: { amountCents, reservedCents, isAllIn, revision },
    });
    await event(tx, roundId, 'BET_UPDATED', {
      userId,
      requestedCents: String(requestedCents),
      amountCents: String(amountCents),
      reservedCents: String(reservedCents),
      liabilityBalanceCents: String(liabilityBalanceCents),
      maxAffordableCents: String(acceptance.maxAffordableCents),
      maxAcceptedCents: String(acceptance.maxAcceptedCents),
      maxMultiplier,
      liabilityMultiplier: acceptance.liabilityMultiplier,
      adjustedBy: acceptance.adjustedBy,
      isAllIn,
      revision,
    });
    return {
      bet,
      requestedCents,
      acceptedCents: amountCents,
      reservedCents,
      liabilityBalanceCents,
      maxAffordableCents: acceptance.maxAffordableCents,
      roomMaxCents: acceptance.roomMaxCents,
      maxAcceptedCents: acceptance.maxAcceptedCents,
      maxMultiplier,
      liabilityMultiplier: acceptance.liabilityMultiplier,
      adjusted: acceptance.adjusted,
      adjustedBy: acceptance.adjustedBy,
    };
  });
}

export async function withdrawBet(roundId: string, userId: string) {
  return serializable(async (tx) => {
    const round = await tx.round.findUnique({ where: { id: roundId } });
    if (!round) throw new GameError('ROUND_NOT_FOUND');
    if (round.phase !== RoundPhase.BETTING) throw new GameError('INVALID_PHASE');
    if (!round.betEndsAt || round.betEndsAt <= new Date()) throw new GameError('PHASE_ENDED');
    const bet = await tx.bet.findUnique({
      where: { roundId_userId: { roundId, userId } },
    });
    if (!bet || bet.status !== BetStatus.FROZEN) throw new GameError('NO_ACTIVE_BET');
    const revision = bet.revision + 1;
    await unfreeze(
      tx,
      userId,
      AccountType.USER_FREEZE_BET,
      reservedCentsOf(bet),
      roundId,
      'bet_withdraw',
      `${bet.id}:v${revision}`,
    );
    const updated = await tx.bet.update({
      where: { id: bet.id },
      data: { status: BetStatus.WITHDRAWN, revision },
    });
    await event(tx, roundId, 'BET_WITHDRAWN', { userId, revision });
    return updated;
  });
}

async function cancelRoundTx(tx: Tx, roundId: string, reason: string, actorId?: string) {
  const round = await tx.round.findUnique({
    where: { id: roundId },
    include: {
      bets: true,
      packet: true,
      _count: { select: { claims: true } },
    },
  });
  if (!round) throw new GameError('ROUND_NOT_FOUND');
  if (round.phase === RoundPhase.FINISHED || round.phase === RoundPhase.CANCELLED) return round;
  if (round.phase === RoundPhase.SETTLING) throw new GameError('ROUND_SETTLING');
  if (
    round.packet?.channel === PacketChannel.INTERNAL
    && round._count.claims > 0
  ) {
    // 内部红包领取时已从平台备付金即时转入玩家余额。此时取消并全额解冻
    // 庄家会让平台承担已领取金额；已发生领取的内部局只能继续复核/结算。
    throw new GameError('INTERNAL_PACKET_ALREADY_CLAIMED');
  }

  for (const bet of round.bets) {
    if (bet.status !== BetStatus.FROZEN) continue;
    await unfreeze(
      tx,
      bet.userId,
      AccountType.USER_FREEZE_BET,
      reservedCentsOf(bet),
      round.id,
      'round_cancel_refund',
      `cancel:${bet.id}`,
    );
    await tx.bet.update({ where: { id: bet.id }, data: { status: BetStatus.REFUNDED } });
  }
  let bankerRefundCents = round.bankerReservedCents;
  if (round.bankerId && round.packet?.sentAt) {
    const packetFeePrepaid = await packetEscrowWasPrepaid(tx, {
      roundId: round.id,
      bankerId: round.bankerId,
      totalCents: round.packet.totalCents,
    });
    if (packetFeePrepaid) {
      if (bankerRefundCents < round.packet.totalCents) {
        throw new GameError('ROUND_INCOMPLETE');
      }
      bankerRefundCents -= round.packet.totalCents;
      if (round.packet.channel === PacketChannel.TNG) {
        await transfer(tx, {
          amountCents: round.packet.totalCents,
          from: { accountType: AccountType.ADJUST_CLEARING },
          to: {
            userId: round.bankerId,
            accountType: AccountType.USER_AVAILABLE,
          },
          refType: 'cancelled_packet_fee_refund',
          refId: round.packet.id,
          roundId: round.id,
          idempotencyKey: `cancelled-packet-fee-refund:${round.packet.id}`,
          operatorId: actorId,
          memo: reason,
        });
      }
    }
  }
  if (round.bankerId && bankerRefundCents > 0n) {
    await unfreeze(
      tx,
      round.bankerId,
      AccountType.USER_FREEZE_BANKER,
      bankerRefundCents,
      round.id,
      'round_cancel_refund',
      `cancel:banker:${round.id}`,
    );
  }
  if (round.packet) {
    await tx.packet.update({
      where: { id: round.packet.id },
      data: round.packet.sentAt
        ? { status: 'CANCELLED' }
        : {
            status: 'RECONCILED',
            returnedCents: round.packet.totalCents,
          },
    });
  }
  const cancelled = await tx.round.update({
    where: { id: round.id },
    data: {
      phase: RoundPhase.CANCELLED,
      cancelReason: reason,
      finishedAt: new Date(),
      bankerReservedCents: 0,
      version: { increment: 1 },
    },
  });
  await event(tx, round.id, 'ROUND_CANCELLED', { reason }, actorId);
  return cancelled;
}

export async function cancelRound(roundId: string, reason: string, actorId?: string) {
  return serializable((tx) => cancelRoundTx(tx, roundId, reason, actorId));
}

/**
 * 暂停小助手服务：群内不再自动播报、不再自动开局。
 * 不关闭互动群入口，也不自动取消进行中牌局（取消请用「取消本局」）。
 */
export async function pauseAssistantService(roomId: string, reason: string, actorId?: string) {
  const room = await prisma.room.findUnique({ where: { id: roomId } });
  if (!room) throw new GameError('ROOM_NOT_FOUND');

  const settingsBefore = await getGameSettings(room.gameCode);
  const roundConfig = await setAssistantService(
    room.gameCode,
    { assistantEnabled: false, autoStart: false },
    actorId,
  );
  return {
    room,
    reason,
    assistantEnabledBefore: settingsBefore.round.assistantEnabled !== false,
    autoStartBefore: Boolean(settingsBefore.round.autoStart),
    assistantEnabled: roundConfig.assistantEnabled,
    autoStart: roundConfig.autoStart,
  };
}

/**
 * 设置房间开局模式。STOPPED 先关闭数据库门闩再更新配置，保证多实例调度不会抢开下一局；
 * MANUAL/AUTO 则先恢复播报配置，再开放对应开局来源。
 */
export async function setRoomStartMode(
  roomId: string,
  mode: RoomStartMode,
  actorId?: string,
) {
  const before = await prisma.room.findUnique({ where: { id: roomId } });
  if (!before) throw new GameError('ROOM_NOT_FOUND');
  if (mode !== RoomStartMode.STOPPED && before.chatMutedAt) {
    throw new GameError('ROOM_GLOBAL_MUTED', {
      mutedAt: before.chatMutedAt.toISOString(),
      reason: before.chatMuteReason,
    });
  }

  if (mode === RoomStartMode.STOPPED) {
    const room = await prisma.room.update({
      where: { id: roomId },
      data: { roundStartMode: mode },
    });
    const roundConfig = await setAssistantService(
      room.gameCode,
      { assistantEnabled: true, autoStart: false },
      actorId,
    );
    return { before, room, roundConfig };
  }

  const roundConfig = await setAssistantService(
    before.gameCode,
    {
      assistantEnabled: true,
      autoStart: mode === RoomStartMode.AUTO,
    },
    actorId,
  );
  const room = await prisma.room.update({
    where: { id: roomId },
    data: { roundStartMode: mode },
  });
  return { before, room, roundConfig };
}

/** @deprecated 使用 pauseAssistantService */
export async function endGameSession(roomId: string, reason: string, actorId?: string) {
  return pauseAssistantService(roomId, reason, actorId);
}

/**
 * 恢复小助手播报服务。默认不打开自动开局——需要运营再开「自动开局」或手动「正常开局」。
 */
export async function resumeBotService(roomId: string, actorId?: string) {
  const room = await prisma.room.findUnique({ where: { id: roomId } });
  if (!room) throw new GameError('ROOM_NOT_FOUND');
  const before = await getGameSettings(room.gameCode);
  const roundConfig = await setAssistantService(
    room.gameCode,
    { assistantEnabled: true, autoStart: false },
    actorId,
  );
  return {
    assistantEnabledBefore: before.round.assistantEnabled !== false,
    autoStartBefore: Boolean(before.round.autoStart),
    assistantEnabled: roundConfig.assistantEnabled,
    autoStart: roundConfig.autoStart,
  };
}

export async function closeBetting(roundId: string) {
  return serializable(async (tx) => {
    const round = await tx.round.findUnique({
      where: { id: roundId },
      include: { bets: { where: { status: BetStatus.FROZEN } } },
    });
    if (!round) throw new GameError('ROUND_NOT_FOUND');
    if (round.phase !== RoundPhase.BETTING) {
      if (
        round.phase === RoundPhase.SENDING_PACKET ||
        round.phase === RoundPhase.CLAIMING ||
        round.phase === RoundPhase.CANCELLED
      ) {
        return round;
      }
      throw new GameError('INVALID_PHASE');
    }
    if (!round.bankerId) throw new GameError('BANKER_NOT_SET');
    if (round.bets.length === 0) return cancelRoundTx(tx, round.id, 'NO_BETS');
    const settings = parseSettingsSnapshot(round.configSnapshot);
    const participants = round.bets.length + 1;
    const totalCents = BigInt(packetTotal(participants, settings.fees));
    const bankerWallet = await tx.wallet.findUnique({ where: { userId: round.bankerId } });
    if (!bankerWallet || bankerWallet.availableCents < totalCents) {
      return cancelRoundTx(tx, round.id, 'BANKER_PACKET_FEE_INSUFFICIENT');
    }
    await freezeBanker(
      tx,
      round.bankerId,
      totalCents,
      round.id,
      `packet-fee:${round.id}`,
    );
    await tx.packet.upsert({
      where: { roundId: round.id },
      create: {
        roundId: round.id,
        totalCents,
        participantCount: participants,
      },
      update: { totalCents, participantCount: participants },
    });
    const updated = await tx.round.update({
      where: { id: round.id },
      data: {
        phase: RoundPhase.SENDING_PACKET,
        bankerReservedCents: { increment: totalCents },
        version: { increment: 1 },
      },
    });
    await event(tx, round.id, 'BETTING_CLOSED', {
      participants,
      packetTotalCents: String(totalCents),
    });
    const repostStartsAt = Date.now();
    const repostEndsAt =
      repostStartsAt + settings.round.repostWindowSeconds * 1_000;
    const diceEndsAt =
      repostEndsAt + settings.round.bankerDiceTimeoutSeconds * 1_000;
    await event(tx, round.id, 'BANKER_REPOST_WINDOW', {
      endsAt: new Date(repostEndsAt).toISOString(),
      seconds: settings.round.repostWindowSeconds,
    });
    await event(tx, round.id, 'BANKER_DICE_DEADLINE', {
      startsAt: new Date(repostEndsAt).toISOString(),
      endsAt: new Date(diceEndsAt).toISOString(),
      seconds: settings.round.bankerDiceTimeoutSeconds,
    });
    return updated;
  });
}

export async function publishPacket(params: {
  roundId: string;
  claimUrl: string;
  /** tngdwallet:// 深链；https 分享链在 Telegram 内置浏览器打不开时由前端兜底唤起 */
  deepLink?: string;
  packerAccount: string;
  actorId?: string;
}) {
  const checked = checkTngClaimLink(params.claimUrl, env.tngPacketHosts);
  if (!checked.ok) {
    throw new GameError(checked.code, {
      hostname: checked.hostname,
      allowedHosts: env.tngPacketHosts,
    });
  }
  const claimUrl = checked.claimUrl;
  let deepLink: string | null = checked.kind === 'deeplink' ? checked.claimUrl : null;
  if (params.deepLink) {
    const checkedDeep = checkTngDeepLink(params.deepLink);
    if (!checkedDeep.ok) throw new GameError(checkedDeep.code);
    deepLink = checkedDeep.deepLink;
  }
  return serializable(async (tx) => {
    const round = await tx.round.findUnique({
      where: { id: params.roundId },
      include: { packet: true },
    });
    if (!round?.packet) throw new GameError('PACKET_NOT_FOUND');
    if (round.phase !== RoundPhase.SENDING_PACKET) {
      if (round.phase === RoundPhase.CLAIMING) return round.packet;
      throw new GameError('INVALID_PHASE');
    }
    const diceReady = await tx.roundEvent.findFirst({
      where: {
        roundId: round.id,
        type: 'BANKER_DICE_READY_FOR_PACKET',
      },
      select: { id: true },
    });
    if (!diceReady) throw new GameError('BANKER_DICE_NOT_READY');
    const account = await tx.tngAccount.findUnique({ where: { id: params.packerAccount } });
    if (!account || account.status !== 'ACTIVE') throw new GameError('TNG_ACCOUNT_UNAVAILABLE');
    if (account.monthlyLimitCents) {
      const day = malaysiaDay();
      const [year, month] = day.split('-').map(Number);
      const monthStart = new Date(`${year}-${String(month).padStart(2, '0')}-01T00:00:00+08:00`);
      const nextMonth =
        month === 12
          ? new Date(`${year + 1}-01-01T00:00:00+08:00`)
          : new Date(`${year}-${String(month + 1).padStart(2, '0')}-01T00:00:00+08:00`);
      const used = await tx.packet.aggregate({
        where: {
          packerAccount: account.id,
          sentAt: { gte: monthStart, lt: nextMonth },
        },
        _sum: { totalCents: true },
      });
      const usedCents = used._sum.totalCents ?? 0n;
      if (usedCents + round.packet.totalCents > account.monthlyLimitCents) {
        throw new GameError('TNG_ACCOUNT_LIMIT_EXCEEDED', {
          limitCents: String(account.monthlyLimitCents),
          usedCents: String(usedCents),
          requiredCents: String(round.packet.totalCents),
        });
      }
    }
    const settings = parseSettingsSnapshot(round.configSnapshot);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + settings.round.claimDurationSeconds * 1000);
    await ensurePacketEscrow(tx, {
      roundId: round.id,
      bankerId: round.bankerId,
      packetId: round.packet.id,
      totalCents: round.packet.totalCents,
    });
    await transfer(tx, {
      amountCents: round.packet.totalCents,
      from: { accountType: AccountType.PLATFORM_RESERVE },
      to: { accountType: AccountType.TNG_TRANSIT },
      refType: 'packet_create',
      refId: round.packet.id,
      roundId: round.id,
      idempotencyKey: `packet-send:${round.packet.id}`,
      operatorId: params.actorId,
    });
    const packet = await tx.packet.update({
      where: { id: round.packet.id },
      data: {
        claimUrl,
        deepLink,
        packerAccount: params.packerAccount,
        status: 'SENT',
        sentAt: now,
        expiresAt,
      },
    });
    await tx.round.update({
      where: { id: round.id },
      data: {
        phase: RoundPhase.CLAIMING,
        claimEndsAt: expiresAt,
        version: { increment: 1 },
      },
    });
    await event(
      tx,
      round.id,
      'PACKET_SENT',
      { packetId: packet.id, expiresAt: expiresAt.toISOString() },
      params.actorId,
    );
    return packet;
  });
}

/**
 * 系统红包发包：投骰完成后由至尊牛牛小助手发送，无 TNG 链接。
 * 资金留在平台备付金，抢包时逐笔转入玩家余额（见 claimInternalPacket）。
 */
export async function publishInternalPacket(params: {
  roundId: string;
  actorId?: string;
}) {
  return serializable(async (tx) => {
    const round = await tx.round.findUnique({
      where: { id: params.roundId },
      include: { packet: true },
    });
    if (!round?.packet) throw new GameError('PACKET_NOT_FOUND');
    if (round.phase !== RoundPhase.SENDING_PACKET) {
      if (round.phase === RoundPhase.CLAIMING) return round.packet;
      throw new GameError('INVALID_PHASE');
    }
    const diceReady = await tx.roundEvent.findFirst({
      where: {
        roundId: round.id,
        type: 'BANKER_DICE_READY_FOR_PACKET',
      },
      select: { id: true },
    });
    if (!diceReady) throw new GameError('BANKER_DICE_NOT_READY');
    const settings = parseSettingsSnapshot(round.configSnapshot);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + settings.round.claimDurationSeconds * 1000);
    const packet = await tx.packet.update({
      where: { id: round.packet.id },
      data: {
        channel: PacketChannel.INTERNAL,
        status: 'SENT',
        sentAt: now,
        expiresAt,
      },
    });
    await tx.round.update({
      where: { id: round.id },
      data: {
        phase: RoundPhase.CLAIMING,
        claimEndsAt: expiresAt,
        version: { increment: 1 },
      },
    });
    await event(
      tx,
      round.id,
      'PACKET_SENT',
      { packetId: packet.id, channel: 'INTERNAL', expiresAt: expiresAt.toISOString() },
      params.actorId,
    );
    return packet;
  });
}

/**
 * 「开始抢包」尚未完整播报时只重置一次领取窗口，避免发包副作用重试吞掉
 * 玩家时间，也避免播报长期失败时每轮调度都续期、牌局永不过期。
 */
export async function refreshUnannouncedClaimDeadline(roundId: string): Promise<Date> {
  const initial = await prisma.round.findUnique({
    where: { id: roundId },
    select: {
      configSnapshot: true,
      room: { select: { gameCode: true } },
    },
  });
  if (!initial) throw new GameError('ROUND_NOT_FOUND');
  const settings = initial.configSnapshot
    ? parseSettingsSnapshot(initial.configSnapshot)
    : await getGameSettings(initial.room.gameCode);

  return serializable(async (tx) => {
    const [round, announced, refreshed] = await Promise.all([
      tx.round.findUnique({
        where: { id: roundId },
        include: { packet: true },
      }),
      tx.roundEvent.findFirst({
        where: { roundId, type: 'ROOM_ANNOUNCED_CLAIMING' },
        select: { id: true },
      }),
      tx.roundEvent.findFirst({
        where: { roundId, type: 'CLAIM_DEADLINE_REFRESHED' },
        select: { id: true },
      }),
    ]);
    if (!round) throw new GameError('ROUND_NOT_FOUND');
    if (round.phase !== RoundPhase.CLAIMING || !round.packet) {
      throw new GameError('INVALID_PHASE');
    }
    if ((announced || refreshed) && round.claimEndsAt) return round.claimEndsAt;

    const claimEndsAt = new Date(
      Date.now() + Math.max(1, settings.round.claimDurationSeconds) * 1_000,
    );
    await tx.round.update({
      where: { id: roundId },
      data: { claimEndsAt },
    });
    await tx.packet.update({
      where: { id: round.packet.id },
      data: { expiresAt: claimEndsAt },
    });
    await event(tx, round.id, 'CLAIM_DEADLINE_REFRESHED', {
      claimEndsAt: claimEndsAt.toISOString(),
    });
    return claimEndsAt;
  });
}

export async function expirePacket(roundId: string) {
  return serializable(async (tx) => {
    const round = await tx.round.findUnique({
      where: { id: roundId },
      include: { packet: true },
    });
    if (!round?.packet) throw new GameError('PACKET_NOT_FOUND');
    if (round.phase !== RoundPhase.CLAIMING || round.packet.status !== 'SENT') {
      return round.packet;
    }
    if (round.claimEndsAt && round.claimEndsAt.getTime() > Date.now()) {
      return round.packet;
    }
    const packet = await tx.packet.update({
      where: { id: round.packet.id },
      data: { status: 'EXPIRED' },
    });
    await tx.round.update({
      where: { id: round.id },
      data: { phase: RoundPhase.CLAIM_EXPIRED, version: { increment: 1 } },
    });
    await event(tx, round.id, 'PACKET_EXPIRED');
    return packet;
  });
}

/** 将剩余红包金额随机拆给未认额参与者（自动认尾包） */
export function splitRemainingCents(total: bigint, count: number): bigint[] {
  if (count <= 0) return [];
  if (total < BigInt(count)) {
    return Array.from({ length: count }, (_, index) => (index < Number(total) ? 1n : 0n));
  }
  const base = 1n;
  let rest = total - BigInt(count) * base;
  const parts = Array.from({ length: count }, () => base);
  while (rest > 0n) {
    const idx = randomInt(count);
    const maxTake = Number(rest > 100n ? 100n : rest);
    const take = rest === 1n ? 1n : BigInt(randomInt(1, maxTake + 1));
    const add = take > rest ? rest : take;
    parts[idx]! += add;
    rest -= add;
  }
  return parts;
}

/**
 * 代包费在关盘时已经冻结。任何红包离开平台前，先把整包费用转入
 * 红包备付金；结算继续使用同一幂等键，只会回放而不会重复收费。
 */
async function ensurePacketEscrow(
  tx: Tx,
  input: {
    roundId: string;
    bankerId: string | null;
    packetId: string;
    totalCents: bigint;
  },
) {
  if (!input.bankerId) throw new GameError('BANKER_NOT_SET');
  try {
    await transfer(tx, {
      amountCents: input.totalCents,
      from: {
        userId: input.bankerId,
        accountType: AccountType.USER_FREEZE_BANKER,
      },
      to: { accountType: AccountType.PLATFORM_RESERVE },
      refType: 'fee_packet_agent',
      refId: input.roundId,
      roundId: input.roundId,
      idempotencyKey: `settle:fee_packet_agent:${input.roundId}`,
      memo: `packet-escrow:${input.packetId}`,
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'INSUFFICIENT_BALANCE') {
      throw new GameError('PACKET_ESCROW_UNAVAILABLE');
    }
    throw error;
  }
}

async function packetEscrowWasPrepaid(
  tx: Tx,
  input: {
    roundId: string;
    bankerId: string;
    totalCents: bigint;
  },
) {
  const posting = await tx.ledgerEntry.findUnique({
    where: {
      idempotencyKey: `settle:fee_packet_agent:${input.roundId}:out`,
    },
    select: {
      userId: true,
      accountType: true,
      direction: true,
      amountCents: true,
      refType: true,
      refId: true,
      roundId: true,
    },
  });
  if (!posting) return false;
  if (
    posting.userId !== input.bankerId
    || posting.accountType !== AccountType.USER_FREEZE_BANKER
    || posting.direction !== 'DEBIT'
    || posting.amountCents !== input.totalCents
    || posting.refType !== 'fee_packet_agent'
    || posting.refId !== input.roundId
    || posting.roundId !== input.roundId
  ) {
    throw new GameError('IDEMPOTENCY_CONFLICT');
  }
  return true;
}

async function payInternalPacketClaim(
  tx: Tx,
  input: {
    packetId: string;
    roundId: string;
    claimId: string;
    userId: string;
    amountCents: bigint;
    tail: boolean;
  },
) {
  try {
    await transfer(tx, {
      amountCents: input.amountCents,
      from: { accountType: AccountType.PLATFORM_RESERVE },
      to: { userId: input.userId, accountType: AccountType.USER_AVAILABLE },
      refType: 'packet_internal_claim',
      refId: input.claimId,
      roundId: input.roundId,
      idempotencyKey: input.tail
        ? `pkt-internal-tail:${input.packetId}:${input.userId}`
        : `pkt-internal-claim:${input.packetId}:${input.userId}`,
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'INSUFFICIENT_BALANCE') {
      throw new GameError('PACKET_ESCROW_UNAVAILABLE');
    }
    throw error;
  }
}

export function balanceBeforePrepaidPacketFee(
  currentBalanceCents: bigint,
  packetFeeCents: bigint,
  prepaid: boolean,
) {
  return currentBalanceCents + (prepaid ? packetFeeCents : 0n);
}

/**
 * 抢包超时后：若开启自动认尾包，为未认额的庄/闲补录金额（source=AUTO_TAIL）。
 * 内部红包强制补录（否则牌局无法凑齐结算），且补录金额同步转入玩家余额。
 * 返回补录的 userId 列表，供上层广播。
 */
export async function applyAutoTailClaims(roundId: string): Promise<string[]> {
  const identity = await prisma.round.findUnique({
    where: { id: roundId },
    select: {
      room: { select: { gameCode: true } },
      packet: { select: { channel: true } },
    },
  });
  if (!identity) throw new GameError('ROUND_NOT_FOUND');
  const internalChannel = identity.packet?.channel === PacketChannel.INTERNAL;
  if (!internalChannel) {
    const settings = await getGameSettings(identity.room.gameCode);
    if (!settings.round.autoTailPacketEnabled) return [];
  }

  return serializable(async (tx) => {
    const round = await tx.round.findUnique({
      where: { id: roundId },
      include: {
        packet: true,
        bets: { where: { status: BetStatus.FROZEN } },
        claims: true,
      },
    });
    if (!round?.packet) return [];
    if (round.phase !== RoundPhase.CLAIM_EXPIRED && round.phase !== RoundPhase.CLAIMING) {
      return [];
    }

    const claimedUserIds = new Set(round.claims.map((c) => c.userId));
    const candidates: string[] = [];
    if (round.bankerId && !claimedUserIds.has(round.bankerId)) candidates.push(round.bankerId);
    for (const bet of round.bets) {
      if (!claimedUserIds.has(bet.userId)) candidates.push(bet.userId);
    }
    const missing: string[] = [];
    for (const userId of candidates) {
      const user = await tx.user.findUnique({
        where: { id: userId },
        include: { virtualPlayer: true },
      });
      if (!user) continue;
      // 内部红包必须为所有参与者补齐认额，否则结算会因缺认额而卡死。
      if (!internalChannel && user.kind === UserKind.VIRTUAL) {
        if (!user.virtualPlayer?.enabled || !user.virtualPlayer.canClaimSim) continue;
      }
      missing.push(userId);
    }
    if (!missing.length) return [];

    const claimedTotal = round.claims.reduce((sum, c) => sum + c.amountCents, 0n);
    let remaining = round.packet.totalCents - claimedTotal;
    if (remaining <= 0n) return [];

    const parts = splitRemainingCents(remaining, missing.length).filter((n) => n > 0n);
    if (round.packet.channel === PacketChannel.INTERNAL) {
      await ensurePacketEscrow(tx, {
        roundId: round.id,
        bankerId: round.bankerId,
        packetId: round.packet.id,
        totalCents: round.packet.totalCents,
      });
    }
    const assigned: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const userId = missing[i]!;
      const amountCents = parts[i]!;
      const user = await tx.user.findUnique({
        where: { id: userId },
        include: { kyc: true },
      });
      if (!user) continue;
      const hand = evaluateHand(safeNumber(amountCents, 'claim'));
      const claim = await tx.claim.create({
        data: {
          packetId: round.packet.id,
          roundId: round.id,
          userId,
          amountCents,
          tngName: encryptSecret('认尾'),
          handType: hand.type,
          points: hand.points,
          source: ClaimSource.AUTO_TAIL,
          enteredBy: 'SYSTEM',
          confirmedAt: new Date(),
        },
      });
      if (round.packet.channel === PacketChannel.INTERNAL) {
        await payInternalPacketClaim(tx, {
          packetId: round.packet.id,
          roundId: round.id,
          claimId: claim.id,
          userId,
          amountCents,
          tail: true,
        });
      }
      await event(tx, round.id, 'CLAIM_AUTO_TAIL', {
        userId,
        amountCents: String(amountCents),
      });
      assigned.push(userId);
    }
    return assigned;
  });
}

export async function reconcilePacketReturn(
  packetId: string,
  returnedCents: bigint,
  actorId?: string,
) {
  if (returnedCents < 0n) throw new GameError('INVALID_AMOUNT');
  return serializable(async (tx) => {
    const packet = await tx.packet.findUnique({
      where: { id: packetId },
      include: { round: true },
    });
    if (!packet) throw new GameError('PACKET_NOT_FOUND');
    if (packet.round.phase !== RoundPhase.FINISHED) {
      throw new GameError('ROUND_NOT_FINISHED');
    }
    const maximumReturn = packet.totalCents - packet.reconciledCents;
    if (returnedCents > maximumReturn || returnedCents < packet.returnedCents) {
      throw new GameError('PACKET_RETURN_OUT_OF_RANGE', {
        minimumCents: String(packet.returnedCents),
        maximumCents: String(maximumReturn),
      });
    }
    const difference = returnedCents - packet.returnedCents;
    if (difference > 0n) {
      await transfer(tx, {
        amountCents: difference,
        from: { accountType: AccountType.TNG_TRANSIT },
        to: { accountType: AccountType.PLATFORM_RESERVE },
        refType: 'packet_return',
        refId: packet.id,
        roundId: packet.roundId,
        idempotencyKey: `packet-return:${packet.id}:${returnedCents}`,
        operatorId: actorId,
      });
    }
    const reconciled =
      packet.reconciledCents + returnedCents === packet.totalCents;
    const updated = await tx.packet.update({
      where: { id: packet.id },
      data: {
        returnedCents,
        status: reconciled ? 'RECONCILED' : 'EXPIRED',
      },
    });
    await event(
      tx,
      packet.roundId,
      'PACKET_RETURN_RECONCILED',
      {
        returnedCents: String(returnedCents),
        outstandingCents: String(maximumReturn - returnedCents),
      },
      actorId,
    );
    return updated;
  });
}

export async function reconcileCancelledPacket(
  packetId: string,
  claimedCents: bigint,
  returnedCents: bigint,
  actorId?: string,
) {
  if (claimedCents < 0n || returnedCents < 0n) throw new GameError('INVALID_AMOUNT');
  return serializable(async (tx) => {
    const packet = await tx.packet.findUnique({
      where: { id: packetId },
      include: { round: true },
    });
    if (!packet) throw new GameError('PACKET_NOT_FOUND');
    if (packet.round.phase !== RoundPhase.CANCELLED) {
      throw new GameError('ROUND_NOT_CANCELLED');
    }
    if (!packet.sentAt) throw new GameError('PACKET_NOT_SENT');
    if (
      claimedCents < packet.reconciledCents ||
      returnedCents < packet.returnedCents ||
      claimedCents + returnedCents > packet.totalCents
    ) {
      throw new GameError('PACKET_RECONCILIATION_OUT_OF_RANGE', {
        totalCents: String(packet.totalCents),
        minimumClaimedCents: String(packet.reconciledCents),
        minimumReturnedCents: String(packet.returnedCents),
      });
    }
    const claimDifference = claimedCents - packet.reconciledCents;
    const returnDifference = returnedCents - packet.returnedCents;
    if (claimDifference > 0n) {
      await transfer(tx, {
        amountCents: claimDifference,
        from: { accountType: AccountType.TNG_TRANSIT },
        to: { accountType: AccountType.ADJUST_CLEARING },
        refType: 'cancelled_packet_claim',
        refId: packet.id,
        roundId: packet.roundId,
        idempotencyKey: `cancelled-packet-claim:${packet.id}:${claimedCents}`,
        operatorId: actorId,
      });
    }
    if (returnDifference > 0n) {
      await transfer(tx, {
        amountCents: returnDifference,
        from: { accountType: AccountType.TNG_TRANSIT },
        to: { accountType: AccountType.PLATFORM_RESERVE },
        refType: 'packet_return',
        refId: packet.id,
        roundId: packet.roundId,
        idempotencyKey: `cancelled-packet-return:${packet.id}:${returnedCents}`,
        operatorId: actorId,
      });
    }
    const complete = claimedCents + returnedCents === packet.totalCents;
    const updated = await tx.packet.update({
      where: { id: packet.id },
      data: {
        reconciledCents: claimedCents,
        returnedCents,
        status: complete ? 'RECONCILED' : 'CANCELLED',
      },
    });
    await event(
      tx,
      packet.roundId,
      'CANCELLED_PACKET_RECONCILED',
      {
        claimedCents: String(claimedCents),
        returnedCents: String(returnedCents),
        outstandingCents: String(packet.totalCents - claimedCents - returnedCents),
      },
      actorId,
    );
    return updated;
  });
}

export async function canClaimPacket(packetId: string, userId: string): Promise<boolean> {
  const packet = await prisma.packet.findUnique({
    where: { id: packetId },
    include: { round: true },
  });
  if (
    !packet ||
    packet.round.phase !== RoundPhase.CLAIMING ||
    packet.status !== 'SENT' ||
    !packet.expiresAt ||
    packet.expiresAt <= new Date()
  ) {
    return false;
  }
  if (packet.round.bankerId === userId) return true;
  const bet = await prisma.bet.findUnique({
    where: { roundId_userId: { roundId: packet.roundId, userId } },
  });
  return bet?.status === BetStatus.FROZEN;
}

export async function claimUrlForParticipant(packetId: string, userId: string): Promise<string> {
  if (!(await canClaimPacket(packetId, userId))) throw new GameError('NOT_ELIGIBLE_TO_CLAIM');
  const packet = await prisma.packet.findUniqueOrThrow({ where: { id: packetId } });
  if (!packet.claimUrl) throw new GameError('PACKET_URL_MISSING');
  return packet.claimUrl;
}

/** 微信式拼手气：剩 1 份给全部，否则在 [1, 2×人均] 内随机并保证后续每份 ≥1 分 */
function internalRandomShare(remainingCents: bigint, remainingCount: number): bigint {
  if (remainingCount <= 1) return remainingCents;
  const remaining = safeNumber(remainingCents, 'packetRemaining');
  const cap = Math.max(1, Math.floor((remaining / remainingCount) * 2));
  // 红包金额决定牌型，必须使用密码学安全且无取模偏差的随机源。
  const roll = randomInt(1, cap + 1);
  return BigInt(Math.min(remaining - (remainingCount - 1), Math.max(1, roll)));
}

/**
 * 内部红包抢包：金额随机拆分并即时转入玩家余额，同一笔金额即为本局牌型依据。
 * Claim 表 (roundId, userId) 唯一约束天然防重复抢；转账幂等键兜底。
 */
export async function claimInternalPacket(packetId: string, userId: string) {
  return serializable(async (tx) => {
    const packet = await tx.packet.findUnique({
      where: { id: packetId },
      include: {
        round: {
          include: {
            claims: true,
            room: { select: { chatMutedAt: true, chatMuteReason: true } },
          },
        },
      },
    });
    if (!packet) throw new GameError('PACKET_NOT_FOUND');
    if (packet.channel !== PacketChannel.INTERNAL) throw new GameError('PACKET_NOT_INTERNAL');
    const round = packet.round;
    if (round.room?.chatMutedAt) {
      throw new GameError('ROOM_GLOBAL_MUTED', {
        mutedAt: round.room.chatMutedAt.toISOString(),
        reason: round.room.chatMuteReason,
      });
    }
    const existing = round.claims.find((claim) => claim.userId === userId);
    if (existing) {
      throw new GameError('ALREADY_CLAIMED', { amountCents: String(existing.amountCents) });
    }
    if (
      round.phase !== RoundPhase.CLAIMING ||
      packet.status !== 'SENT' ||
      !packet.expiresAt ||
      packet.expiresAt <= new Date()
    ) {
      throw new GameError('PACKET_EXPIRED');
    }
    let eligible = round.bankerId === userId;
    if (!eligible) {
      const bet = await tx.bet.findUnique({
        where: { roundId_userId: { roundId: round.id, userId } },
      });
      eligible = bet?.status === BetStatus.FROZEN;
    }
    if (!eligible) throw new GameError('NOT_ELIGIBLE_TO_CLAIM');

    const claimedTotal = round.claims.reduce((sum, claim) => sum + claim.amountCents, 0n);
    const remainingCents = packet.totalCents - claimedTotal;
    const remainingCount = packet.participantCount - round.claims.length;
    if (remainingCount <= 0 || remainingCents <= 0n) throw new GameError('PACKET_EMPTY');

    const amountCents = internalRandomShare(remainingCents, remainingCount);
    const hand = evaluateHand(safeNumber(amountCents, 'claim'));
    await ensurePacketEscrow(tx, {
      roundId: round.id,
      bankerId: round.bankerId,
      packetId: packet.id,
      totalCents: packet.totalCents,
    });
    const claim = await tx.claim.create({
      data: {
        packetId: packet.id,
        roundId: round.id,
        userId,
        amountCents,
        handType: hand.type,
        points: hand.points,
        source: ClaimSource.INTERNAL,
        enteredBy: 'SYSTEM',
        confirmedAt: new Date(),
      },
    });
    await payInternalPacketClaim(tx, {
      packetId: packet.id,
      roundId: round.id,
      claimId: claim.id,
      userId,
      amountCents,
      tail: false,
    });
    await event(tx, round.id, 'CLAIM_INTERNAL', {
      userId,
      amountCents: String(amountCents),
    });
    return {
      claim,
      hand,
      complete: round.claims.length + 1 >= packet.participantCount,
    };
  });
}

export async function claimCandidates(tngName: string) {
  const nameHash = blindIndex(tngName);
  const rows = await prisma.kyc.findMany({
    where: { status: KycStatus.APPROVED, realNameHash: nameHash },
    include: { user: { select: { id: true, uid: true, nickname: true } } },
    take: 20,
  });
  return rows.map((row) => ({
    userId: row.user.id,
    uid: row.user.uid,
    nickname: row.user.nickname,
    realName: decryptSecret(row.realName),
  }));
}

export type ClaimNameResolution =
  | { ok: true; userId: string }
  | { ok: false; reason: 'NAME_NOT_MATCHED' | 'NAME_AMBIGUOUS' | 'KYC_NOT_APPROVED' };

/**
 * 手机端回传的领取明细只有 TNG 姓名，需先解析成本局玩家。
 * 与 claimCandidates 的区别：这里只在**本局参与者**（庄家 + 已冻结下注的闲家）范围内匹配，
 * 全库同名不会造成误记账；歧义或未实名一律交人工指认。
 */
export async function resolveClaimUserByName(
  roundId: string,
  tngName: string,
): Promise<ClaimNameResolution> {
  const round = await prisma.round.findUnique({
    where: { id: roundId },
    select: {
      bankerId: true,
      bets: { where: { status: BetStatus.FROZEN }, select: { userId: true } },
    },
  });
  if (!round) return { ok: false, reason: 'NAME_NOT_MATCHED' };
  const participantIds = new Set<string>(round.bets.map((bet) => bet.userId));
  if (round.bankerId) participantIds.add(round.bankerId);
  if (participantIds.size === 0) return { ok: false, reason: 'NAME_NOT_MATCHED' };

  const nameHash = blindIndex(tngName);
  const matches = await prisma.kyc.findMany({
    where: { userId: { in: [...participantIds] }, realNameHash: nameHash },
    select: { userId: true, status: true },
  });
  if (matches.length === 0) return { ok: false, reason: 'NAME_NOT_MATCHED' };
  const approved = matches.filter((row) => row.status === KycStatus.APPROVED);
  if (approved.length === 0) return { ok: false, reason: 'KYC_NOT_APPROVED' };
  if (approved.length > 1) return { ok: false, reason: 'NAME_AMBIGUOUS' };
  return { ok: true, userId: approved[0]!.userId };
}

export async function recordClaim(params: {
  roundId: string;
  userId: string;
  amountCents: bigint;
  tngName: string;
  enteredBy?: string;
  forceMatch?: boolean;
  matchOverrideReason?: string;
  /** 默认后台人工录入；手机端自动回调传 PROVIDER */
  source?: ClaimSource;
}) {
  if (params.amountCents <= 0n) throw new GameError('INVALID_AMOUNT');
  if (params.forceMatch && (!params.matchOverrideReason || params.matchOverrideReason.trim().length < 4)) {
    throw new GameError('MATCH_OVERRIDE_REASON_REQUIRED');
  }
  return serializable(async (tx) => {
    const round = await tx.round.findUnique({
      where: { id: params.roundId },
      include: {
        packet: true,
        bets: { where: { status: BetStatus.FROZEN } },
        claims: true,
      },
    });
    if (!round?.packet) throw new GameError('PACKET_NOT_FOUND');
    if (!isClaimReviewPhase(round.phase)) throw new GameError('INVALID_PHASE');
    const participant =
      round.bankerId === params.userId ||
      round.bets.some((bet) => bet.userId === params.userId);
    if (!participant) throw new GameError('NOT_ELIGIBLE_TO_CLAIM');
    const user = await tx.user.findUnique({
      where: { id: params.userId },
      include: { kyc: true },
    });
    if (!user?.kyc || user.kyc.status !== KycStatus.APPROVED) throw new GameError('KYC_REQUIRED');
    if (
      !params.forceMatch &&
      user.kyc.realNameHash &&
      user.kyc.realNameHash !== blindIndex(params.tngName)
    ) {
      throw new GameError('TNG_NAME_MISMATCH');
    }
    const existingClaim = round.claims.find((claim) => claim.userId === params.userId);
    if (existingClaim) {
      const sameName =
        !existingClaim.tngName ||
        normalizeIdentity(decryptSecret(existingClaim.tngName)) ===
          normalizeIdentity(params.tngName);
      if (existingClaim.amountCents === params.amountCents && sameName) {
        return {
          claim: existingClaim,
          complete: round.claims.length === round.packet.participantCount,
        };
      }
      throw new GameError('CLAIM_ALREADY_RECORDED');
    }
    const claimedTotal = round.claims.reduce((sum, claim) => sum + claim.amountCents, 0n);
    if (claimedTotal + params.amountCents > round.packet.totalCents) {
      throw new GameError('PACKET_TOTAL_EXCEEDED');
    }
    const hand = evaluateHand(safeNumber(params.amountCents, 'claim'));
    const claim = await tx.claim.create({
      data: {
        packetId: round.packet.id,
        roundId: round.id,
        userId: params.userId,
        amountCents: params.amountCents,
        tngName: encryptSecret(normalizeIdentity(params.tngName)),
        handType: hand.type,
        points: hand.points,
        source: params.source ?? ClaimSource.MANUAL,
        enteredBy: params.enteredBy,
        confirmedAt: new Date(),
      },
    });
    await event(
      tx,
      round.id,
      'CLAIM_RECORDED',
      {
        userId: params.userId,
        amountCents: String(params.amountCents),
        forceMatch: !!params.forceMatch,
        matchOverrideReason: params.forceMatch ? params.matchOverrideReason : undefined,
      },
      params.enteredBy,
    );
    const count = await tx.claim.count({ where: { roundId: round.id } });
    return { claim, complete: count === round.packet.participantCount };
  });
}

export async function correctClaim(params: {
  claimId: string;
  amountCents: bigint;
  tngName: string;
  reason: string;
  enteredBy: string;
  forceMatch?: boolean;
}) {
  if (params.amountCents <= 0n) throw new GameError('INVALID_AMOUNT');
  if (params.reason.trim().length < 4) throw new GameError('CORRECTION_REASON_REQUIRED');
  return serializable(async (tx) => {
    const existing = await tx.claim.findUnique({
      where: { id: params.claimId },
      include: {
        round: { include: { packet: true, claims: true } },
        user: { include: { kyc: true } },
      },
    });
    if (!existing?.round.packet) throw new GameError('CLAIM_NOT_FOUND');
    if (!isClaimReviewPhase(existing.round.phase)) {
      throw new GameError('CLAIM_NOT_EDITABLE');
    }
    if (!existing.user.kyc || existing.user.kyc.status !== KycStatus.APPROVED) {
      throw new GameError('KYC_REQUIRED');
    }
    if (
      !params.forceMatch &&
      normalizeIdentity(decryptSecret(existing.user.kyc.realName)) !==
        normalizeIdentity(params.tngName)
    ) {
      throw new GameError('TNG_NAME_MISMATCH');
    }
    const otherClaims = existing.round.claims.reduce(
      (sum, claim) => sum + (claim.id === existing.id ? 0n : claim.amountCents),
      0n,
    );
    if (otherClaims + params.amountCents > existing.round.packet.totalCents) {
      throw new GameError('PACKET_TOTAL_EXCEEDED');
    }
    const hand = evaluateHand(safeNumber(params.amountCents, 'claim'));
    const updated = await tx.claim.update({
      where: { id: existing.id },
      data: {
        amountCents: params.amountCents,
        tngName: encryptSecret(normalizeIdentity(params.tngName)),
        handType: hand.type,
        points: hand.points,
        enteredBy: params.enteredBy,
        confirmedAt: new Date(),
      },
    });
    await event(
      tx,
      existing.roundId,
      'CLAIM_CORRECTED',
      {
        claimId: existing.id,
        userId: existing.userId,
        beforeAmountCents: String(existing.amountCents),
        afterAmountCents: String(params.amountCents),
        forceMatch: !!params.forceMatch,
        reason: params.reason.trim(),
      },
      params.enteredBy,
    );
    return { before: existing, claim: updated };
  });
}

export async function forfeitMissingPlayer(roundId: string, userId: string, actorId?: string) {
  return serializable(async (tx) => {
    const round = await tx.round.findUnique({
      where: { id: roundId },
      include: { packet: { select: { id: true, channel: true, participantCount: true } } },
    });
    if (!round) throw new GameError('ROUND_NOT_FOUND');
    if (!isClaimReviewPhase(round.phase)) throw new GameError('INVALID_PHASE');
    if (round.bankerId === userId) throw new GameError('BANKER_CANNOT_FORFEIT');
    const claim = await tx.claim.findUnique({
      where: { roundId_userId: { roundId, userId } },
    });
    if (claim) throw new GameError('CLAIM_ALREADY_RECORDED');
    const bet = await tx.bet.findUnique({
      where: { roundId_userId: { roundId, userId } },
    });
    if (!bet || bet.status !== BetStatus.FROZEN) throw new GameError('NO_ACTIVE_BET');
    await unfreeze(
      tx,
      userId,
      AccountType.USER_FREEZE_BET,
      reservedCentsOf(bet),
      round.id,
      'claim_forfeit_refund',
      `forfeit:${bet.id}`,
    );
    const updated = await tx.bet.update({
      where: { id: bet.id },
      data: { status: BetStatus.FORFEITED },
    });
    if (round.packet?.channel === PacketChannel.INTERNAL) {
      if (round.packet.participantCount <= 1) {
        throw new GameError('INVALID_PACKET_PARTICIPANTS');
      }
      await tx.packet.update({
        where: { id: round.packet.id },
        data: { participantCount: { decrement: 1 } },
      });
    }
    await event(tx, round.id, 'PLAYER_FORFEITED', { userId }, actorId);
    return updated;
  });
}

async function addTurnover(
  tx: Tx,
  gameCode: string,
  userId: string,
  amountCents: bigint,
  date: string,
) {
  if (amountCents <= 0n) return;
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { inviterId: true, grandInviterId: true, kind: true },
  });
  // 虚拟玩家不计入返水流水，避免污染推广结算。
  if (!user || user.kind === UserKind.VIRTUAL) return;
  await tx.turnoverDaily.upsert({
    where: { gameCode_userId_date: { gameCode, userId, date } },
    create: { gameCode, userId, date, selfCents: amountCents },
    update: { selfCents: { increment: amountCents } },
  });
  if (user.inviterId) {
    await tx.turnoverDaily.upsert({
      where: {
        gameCode_userId_date: {
          gameCode,
          userId: user.inviterId,
          date,
        },
      },
      create: {
        gameCode,
        userId: user.inviterId,
        date,
        l1Cents: amountCents,
      },
      update: { l1Cents: { increment: amountCents } },
    });
  }
  if (user.grandInviterId) {
    await tx.turnoverDaily.upsert({
      where: {
        gameCode_userId_date: {
          gameCode,
          userId: user.grandInviterId,
          date,
        },
      },
      create: {
        gameCode,
        userId: user.grandInviterId,
        date,
        l2Cents: amountCents,
      },
      update: { l2Cents: { increment: amountCents } },
    });
  }
}

export async function settleGameRound(roundId: string, actorId?: string) {
  return serializable(async (tx) => {
    const round = await tx.round.findUnique({
      where: { id: roundId },
      include: {
        room: true,
        packet: true,
        claims: true,
        bets: {
          where: { status: BetStatus.FROZEN },
          include: { user: { include: { wallet: true } } },
        },
      },
    });
    if (!round) throw new GameError('ROUND_NOT_FOUND');
    if (round.phase === RoundPhase.FINISHED) {
      return tx.roundScoreboard.findUniqueOrThrow({ where: { roundId } });
    }
    if (!isClaimReviewPhase(round.phase) && round.phase !== RoundPhase.SETTLING) {
      throw new GameError('INVALID_PHASE');
    }
    if (!round.bankerId || !round.packet) throw new GameError('ROUND_INCOMPLETE');
    const banker = await tx.user.findUnique({
      where: { id: round.bankerId },
      include: { wallet: true },
    });
    if (!banker?.wallet) throw new GameError('BANKER_NOT_FOUND');
    const claims = new Map(round.claims.map((claim) => [claim.userId, claim]));
    const bankerClaim = claims.get(round.bankerId);
    if (!bankerClaim) throw new GameError('BANKER_CLAIM_MISSING');
    const missing = round.bets.filter((bet) => !claims.has(bet.userId));
    if (missing.length > 0) {
      throw new GameError('PLAYER_CLAIMS_MISSING', { userIds: missing.map((bet) => bet.userId) });
    }

    const settings = parseSettingsSnapshot(round.configSnapshot);
    const beforeBalances = new Map<string, bigint>();
    for (const bet of round.bets) {
      if (!bet.user.wallet) throw new GameError('WALLET_NOT_FOUND');
      beforeBalances.set(bet.userId, totalBalance(bet.user.wallet));
    }
    const packetFeePrepaid = await packetEscrowWasPrepaid(tx, {
      roundId: round.id,
      bankerId: round.bankerId,
      totalCents: round.packet.totalCents,
    });
    const bankerBefore = balanceBeforePrepaidPacketFee(
      totalBalance(banker.wallet),
      round.packet.totalCents,
      packetFeePrepaid,
    );
    const calculation = calculateSettlement({
      bankerUserId: round.bankerId,
      bankerClaimCents: safeNumber(bankerClaim.amountCents, 'bankerClaim'),
      potCents: safeNumber(round.potCents, 'pot'),
      players: round.bets.map((bet) => ({
        userId: bet.userId,
        betCents: safeNumber(bet.amountCents, 'bet'),
        claimCents: safeNumber(claims.get(bet.userId)!.amountCents, 'claim'),
        reservedCents: safeNumber(reservedCentsOf(bet), 'betReserve'),
        betPlacedAtMs: bet.createdAt.getTime(),
        isAllIn: bet.isAllIn,
      })),
      participantCount: round.bets.length + 1,
      packetFeeCents: safeNumber(round.packet.totalCents, 'packetFee'),
      handConfig: settings.hand,
      feeConfig: settings.fees,
    });

    await tx.round.update({
      where: { id: round.id },
      data: { phase: RoundPhase.SETTLING, version: { increment: 1 } },
    });

    for (const pair of calculation.pairs) {
      const bet = round.bets.find((item) => item.userId === pair.userId)!;
      const claim = claims.get(pair.userId)!;
      const reservedCents = reservedCentsOf(bet);
      if (pair.outcome === 'PLAYER_WIN') {
        await unfreeze(
          tx,
          pair.userId,
          AccountType.USER_FREEZE_BET,
          reservedCents,
          round.id,
          'settle_bet_return',
          `settle:return:${bet.id}`,
        );
        const netWin = BigInt(pair.paidCents - pair.rakeCents);
        if (netWin > 0n) {
          await transfer(tx, {
            amountCents: netWin,
            from: { userId: round.bankerId, accountType: AccountType.USER_FREEZE_BANKER },
            to: { userId: pair.userId, accountType: AccountType.USER_AVAILABLE },
            refType: 'settle_win',
            refId: bet.id,
            roundId: round.id,
            idempotencyKey: `settle:player-win:${round.id}:${pair.userId}`,
          });
        }
        if (pair.rakeCents > 0) {
          await transfer(tx, {
            amountCents: BigInt(pair.rakeCents),
            from: { userId: round.bankerId, accountType: AccountType.USER_FREEZE_BANKER },
            to: { accountType: AccountType.PLATFORM_RAKE },
            refType: 'rake',
            refId: bet.id,
            roundId: round.id,
            idempotencyKey: `settle:player-rake:${round.id}:${pair.userId}`,
          });
        }
      } else if (pair.outcome === 'BANKER_WIN') {
        // 最大赔付已在下注时完整预留；结算按实收全额划给庄家，抽水改在本局盈利上一次性收取。
        const collectedCents = BigInt(pair.paidCents);
        if (collectedCents > 0n) {
          await transfer(tx, {
            amountCents: collectedCents,
            from: { userId: pair.userId, accountType: AccountType.USER_FREEZE_BET },
            to: { userId: round.bankerId, accountType: AccountType.USER_FREEZE_BANKER },
            refType: 'settle_lose',
            refId: bet.id,
            roundId: round.id,
            idempotencyKey: `settle:banker-win:${round.id}:${pair.userId}`,
          });
        }
        const reserveReturn = reservedCents - collectedCents;
        if (reserveReturn > 0n) {
          await unfreeze(
            tx,
            pair.userId,
            AccountType.USER_FREEZE_BET,
            reserveReturn,
            round.id,
            'settle_liability_return',
            `settle:liability-return:${bet.id}`,
          );
        }
      } else {
        await unfreeze(
          tx,
          pair.userId,
          AccountType.USER_FREEZE_BET,
          reservedCents,
          round.id,
          'settle_tie_return',
          `settle:tie:${bet.id}`,
        );
      }
      await tx.bet.update({ where: { id: bet.id }, data: { status: BetStatus.SETTLED } });
      await tx.settlement.create({
        data: {
          roundId: round.id,
          userId: pair.userId,
          betCents: BigInt(pair.betCents),
          bankerAmountCents: bankerClaim.amountCents,
          playerAmountCents: claim.amountCents,
          bankerHand: pair.bankerHand.type,
          playerHand: pair.playerHand.type,
          bankerPoints: pair.bankerHand.points,
          playerPoints: pair.playerHand.points,
          outcome: pair.outcome,
          isBustPlayer: pair.isBustPlayer,
          isBustBanker: pair.isBustBanker,
          multiplier: pair.multiplier,
          payableCents: BigInt(pair.payableCents),
          paidCents: BigInt(pair.paidCents),
          shortfallCents: BigInt(pair.shortfallCents),
          rakeCents: BigInt(pair.rakeCents),
        },
      });
    }

    if (calculation.bankerRakeCents > 0) {
      await transfer(tx, {
        amountCents: BigInt(calculation.bankerRakeCents),
        from: { userId: round.bankerId, accountType: AccountType.USER_FREEZE_BANKER },
        to: { accountType: AccountType.PLATFORM_RAKE },
        refType: 'rake',
        refId: round.id,
        roundId: round.id,
        idempotencyKey: `settle:banker-profit-rake:${round.id}`,
      });
    }

    const feeTransfers: Array<{
      amount: number;
      type: string;
      target: AccountType;
    }> = [
      {
        amount: calculation.fees.seatFeeCents,
        type: 'fee_banker_seat',
        target: AccountType.PLATFORM_FEES,
      },
      {
        amount: calculation.fees.serviceFeeCents,
        type: 'fee_service',
        target: AccountType.PLATFORM_FEES,
      },
      {
        amount: calculation.fees.packetFeeCents,
        type: 'fee_packet_agent',
        target: AccountType.PLATFORM_RESERVE,
      },
    ];
    for (const fee of feeTransfers) {
      if (fee.amount <= 0) continue;
      await transfer(tx, {
        amountCents: BigInt(fee.amount),
        from: { userId: round.bankerId, accountType: AccountType.USER_FREEZE_BANKER },
        to: { accountType: fee.target },
        refType: fee.type,
        refId: round.id,
        roundId: round.id,
        idempotencyKey: `settle:${fee.type}:${round.id}`,
      });
    }

    const bankerReturn = BigInt(round.potCents) + BigInt(calculation.bankerGrossCents);
    if (bankerReturn > 0n) {
      await unfreeze(
        tx,
        round.bankerId,
        AccountType.USER_FREEZE_BANKER,
        bankerReturn,
        round.id,
        'settle_banker_return',
        `settle:banker:${round.id}`,
      );
    }

    const claimsTotal = round.claims.reduce((sum, claim) => sum + claim.amountCents, 0n);
    if (round.packet.channel === PacketChannel.INTERNAL) {
      // 内部红包：抢包金额已实时入玩家余额，未派发部分从未离开平台备付金，无需 TNG 清分。
      await tx.packet.update({
        where: { id: round.packet.id },
        data: {
          reconciledCents: claimsTotal,
          returnedCents: round.packet.totalCents - claimsTotal,
          status: 'RECONCILED',
        },
      });
    } else {
      if (claimsTotal > 0n) {
        await transfer(tx, {
          amountCents: claimsTotal,
          from: { accountType: AccountType.TNG_TRANSIT },
          to: { accountType: AccountType.ADJUST_CLEARING },
          refType: 'packet_claim',
          refId: round.packet.id,
          roundId: round.id,
          idempotencyKey: `packet-reconcile:${round.packet.id}`,
          operatorId: actorId,
        });
      }
      await tx.packet.update({
        where: { id: round.packet.id },
        data: {
          reconciledCents: claimsTotal,
          status: claimsTotal === round.packet.totalCents ? 'RECONCILED' : 'EXPIRED',
        },
      });
    }

    const day = malaysiaDay();
    const gameCode = round.room.gameCode;
    for (const pair of calculation.pairs) {
      const turnover = effectiveTurnoverForPlayer(
        pair.betCents,
        pair.outcome,
        settings.rebate,
      );
      await addTurnover(
        tx,
        gameCode,
        pair.userId,
        BigInt(turnover),
        day,
      );
      const bet = round.bets.find((item) => item.userId === pair.userId)!;
      const rewardEligible = bet.isAllIn
        ? bet.amountCents >= BigInt(settings.rewards.minAllInCents)
        : bet.amountCents >= BigInt(settings.rewards.minBetCents);
      if (turnover > 0 && rewardEligible) {
        const progress = await tx.dailyHandProgress.findUnique({
          where: {
            gameCode_userId_date: {
              gameCode,
              userId: pair.userId,
              date: day,
            },
          },
        });
        const counts = {
          ...((progress?.counts as Record<string, number> | undefined) ?? {}),
        };
        counts[pair.playerHand.type] = (counts[pair.playerHand.type] ?? 0) + 1;
        await tx.dailyHandProgress.upsert({
          where: {
            gameCode_userId_date: {
              gameCode,
              userId: pair.userId,
              date: day,
            },
          },
          create: { gameCode, userId: pair.userId, date: day, counts },
          update: { counts },
        });
      }
    }
    const bankerTurnover = effectiveTurnoverForBanker(calculation.pairs, settings.rebate);
    await addTurnover(
      tx,
      gameCode,
      round.bankerId,
      BigInt(bankerTurnover),
      day,
    );

    const trendHistoryLimit = Math.max(1, Math.trunc(settings.round.trendLength));
    const [existingStat, previousBankerRounds] = await Promise.all([
      tx.bankerStat.findUnique({
        where: { userId_roomId: { userId: round.bankerId, roomId: round.roomId } },
      }),
      tx.round.findMany({
        where: {
          roomId: round.roomId,
          bankerId: round.bankerId,
          phase: RoundPhase.FINISHED,
          id: { not: round.id },
        },
        orderBy: { seqNo: 'desc' },
        take: trendHistoryLimit,
        select: { scoreboard: { select: { bankerSummary: true } } },
      }),
    ]);
    const previousTrend = previousBankerRounds
      .slice()
      .reverse()
      .map((item) => bankerTrendLabelFromSummary(item.scoreboard?.bankerSummary))
      .filter((item): item is string => item !== null);
    const bankerLabel =
      calculation.bankerHand.type === 'NORMAL'
        ? `${calculation.bankerHand.points}点`
        : HAND_LABEL[calculation.bankerHand.type];
    const trend = continueBankerTrend(
      previousTrend,
      bankerLabel,
      trendHistoryLimit,
    );
    const resetDaily = existingStat?.todayDate !== day;
    const bankerStat = await tx.bankerStat.upsert({
      where: { userId_roomId: { userId: round.bankerId, roomId: round.roomId } },
      create: {
        userId: round.bankerId,
        roomId: round.roomId,
        totalProfitCents: BigInt(calculation.bankerNetCents),
        roundsAsBanker: 1,
        roundsToday: 1,
        todayDate: day,
        trendRecent: trend,
      },
      update: {
        totalProfitCents: { increment: BigInt(calculation.bankerNetCents) },
        roundsAsBanker: { increment: 1 },
        roundsToday: resetDaily ? 1 : { increment: 1 },
        todayDate: day,
        trendRecent: trend,
      },
    });
    const bankerProgress = await tx.dailyHandProgress.findUnique({
      where: {
        gameCode_userId_date: {
          gameCode,
          userId: round.bankerId,
          date: day,
        },
      },
    });
    const bankerCounts = {
      ...((bankerProgress?.counts as Record<string, number> | undefined) ?? {}),
    };
    bankerCounts.BANKER_ROUNDS = (bankerCounts.BANKER_ROUNDS ?? 0) + 1;
    if (bankerClaim.amountCents === BigInt(settings.rewards.bankerInstantAmountCents)) {
      bankerCounts.BANKER_INSTANT = (bankerCounts.BANKER_INSTANT ?? 0) + 1;
    }
    await tx.dailyHandProgress.upsert({
      where: {
        gameCode_userId_date: {
          gameCode,
          userId: round.bankerId,
          date: day,
        },
      },
      create: {
        gameCode,
        userId: round.bankerId,
        date: day,
        counts: bankerCounts,
      },
      update: { counts: bankerCounts },
    });

    const playerLines = calculation.pairs.map((pair) => {
      const bet = round.bets.find((item) => item.userId === pair.userId)!;
      const claim = claims.get(pair.userId)!;
      const before = beforeBalances.get(pair.userId) ?? 0n;
      return {
        userId: pair.userId,
        uid: bet.user.uid,
        nickname: bet.user.nickname,
        tgUsername: bet.user.tgUsername,
        claimCents: String(claim.amountCents),
        betCents: String(bet.amountCents),
        isAllIn: bet.isAllIn,
        outcome: pair.outcome,
        netCents: String(pair.playerNetCents),
        handType: pair.playerHand.type,
        points: pair.playerHand.points,
        isBust: pair.isBustPlayer,
        multiplier: pair.multiplier,
        payableCents: String(pair.payableCents),
        paidCents: String(pair.paidCents),
        rakeCents: String(pair.rakeCents),
        shortfallCents: String(pair.shortfallCents),
        balanceBeforeCents: String(before),
        balanceAfterCents: String(before + BigInt(pair.playerNetCents)),
      };
    });
    const bankerSummary = {
      userId: banker.id,
      uid: banker.uid,
      nickname: banker.nickname,
      tgUsername: banker.tgUsername,
      claimCents: String(bankerClaim.amountCents),
      handType: calculation.bankerHand.type,
      points: calculation.bankerHand.points,
      isBust: calculation.pairs.some((pair) => pair.isBustBanker),
      stats: calculation.stats,
      fees: calculation.fees,
      profitCents: String(calculation.bankerProfitCents),
      rakeCents: String(calculation.bankerRakeCents),
      grossCents: String(calculation.bankerGrossCents),
      netCents: String(calculation.bankerNetCents),
      balanceBeforeCents: String(bankerBefore),
      balanceAfterCents: String(bankerBefore + BigInt(calculation.bankerNetCents)),
      totalProfitCents: String(bankerStat.totalProfitCents),
      trend,
    };
    const scoreboard = await tx.roundScoreboard.create({
      data: {
        roundId: round.id,
        seqNo: round.seqNo,
        playerLines: JSON.parse(JSON.stringify(playerLines)) as Prisma.InputJsonValue,
        bankerSummary: JSON.parse(JSON.stringify(bankerSummary)) as Prisma.InputJsonValue,
        presentationSyncStatus: 'PENDING',
      },
    });
    await tx.round.update({
      where: { id: round.id },
      data: {
        phase: RoundPhase.FINISHED,
        settledAt: new Date(),
        finishedAt: new Date(),
        bankerReservedCents: 0,
        version: { increment: 1 },
      },
    });
    await event(tx, round.id, 'ROUND_SETTLED', { scoreboardId: scoreboard.id }, actorId);
    return scoreboard;
  });
}

function continuationReserveCents(
  potCents: bigint,
  settings: ReturnType<typeof parseSettingsSnapshot>,
): bigint {
  const pot = safeNumber(potCents, 'pot');
  const baseFees = bankerSeatFee(pot, settings.fees) + settings.fees.serviceFeeCents;
  return potCents + BigInt(baseFees);
}

export async function bankerContinuationFunding(previousRoundId: string) {
  const previous = await prisma.round.findUnique({
    where: { id: previousRoundId },
    select: {
      id: true,
      roomId: true,
      bankerId: true,
      potCents: true,
      configSnapshot: true,
    },
  });
  if (!previous) throw new GameError('ROUND_NOT_FOUND');
  if (!previous.bankerId) throw new GameError('BANKER_NOT_SET');
  if (!previous.configSnapshot) throw new GameError('ROUND_CONFIG_SNAPSHOT_MISSING');
  const banker = await prisma.user.findUnique({
    where: { id: previous.bankerId },
    select: {
      id: true,
      uid: true,
      nickname: true,
      tgUsername: true,
      kind: true,
      wallet: { select: { availableCents: true } },
      virtualPlayer: {
        select: { enabled: true, canContinue: true },
      },
    },
  });
  if (!banker) throw new GameError('BANKER_NOT_FOUND');
  if (!banker.wallet) throw new GameError('WALLET_NOT_FOUND');
  const settings = parseSettingsSnapshot(previous.configSnapshot);
  const requiredCents = continuationReserveCents(previous.potCents, settings);
  const availableCents = banker.wallet.availableCents;
  return {
    roomId: previous.roomId,
    bankerId: banker.id,
    uid: banker.uid,
    nickname: banker.nickname,
    tgUsername: banker.tgUsername,
    requiredCents,
    availableCents,
    sufficient: availableCents >= requiredCents,
    autoFundableVirtual:
      banker.kind === UserKind.VIRTUAL
      && banker.virtualPlayer?.enabled === true
      && banker.virtualPlayer.canContinue,
  };
}

export async function continueBanker(previousRoundId: string, userId: string) {
  const previous = await prisma.round.findUnique({ where: { id: previousRoundId } });
  if (!previous) throw new GameError('ROUND_NOT_FOUND');
  const waiting = await ensureWaitingRound(previous.roomId);
  return serializable(async (tx) => {
    const lastRound = await tx.round.findUnique({ where: { id: previousRoundId } });
    const nextRound = await tx.round.findUnique({
      where: { id: waiting.id },
      include: {
        room: {
          select: {
            roundStartMode: true,
            chatMutedAt: true,
            chatMuteReason: true,
          },
        },
      },
    });
    if (!lastRound || !nextRound) throw new GameError('ROUND_NOT_FOUND');
    if (nextRound.room.chatMutedAt) {
      throw new GameError('ROOM_GLOBAL_MUTED', {
        mutedAt: nextRound.room.chatMutedAt.toISOString(),
        reason: nextRound.room.chatMuteReason,
      });
    }
    if (nextRound.room.roundStartMode !== RoomStartMode.AUTO) {
      throw new GameError('ROUND_START_DISABLED', {
        roomStartMode: nextRound.room.roundStartMode,
        source: 'AUTO',
      });
    }
    if (!lastRound.configSnapshot) throw new GameError('ROUND_CONFIG_SNAPSHOT_MISSING');
    const settings = parseSettingsSnapshot(lastRound.configSnapshot);
    const [continuationAnnouncement, rejectedContinuation] = await Promise.all([
      tx.roundEvent.findFirst({
        where: {
          roundId: lastRound.id,
          type: ROOM_ANNOUNCED_FINISHED,
        },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      tx.roundEvent.findFirst({
        where: {
          roundId: lastRound.id,
          type: CONTINUATION_REJECTED_INSUFFICIENT,
        },
        select: { id: true },
      }),
    ]);
    if (rejectedContinuation) throw new GameError('CONTINUATION_ALREADY_USED');
    const eligibilityError = bankerContinuationError({
      previous: {
        ...lastRound,
        continuationStartedAt: continuationAnnouncement?.createdAt ?? null,
      },
      next: nextRound,
      userId,
      windowSeconds: settings.round.continuationWindowSeconds,
    });
    if (eligibilityError) throw new GameError(eligibilityError);

    const user = await requireGameUser(tx, userId, lastRound.roomId, 'continue');
    const reserve = continuationReserveCents(lastRound.potCents, settings);
    if (user.wallet.availableCents < reserve) {
      throw new GameError('INSUFFICIENT_BALANCE', {
        requiredCents: String(reserve),
        availableCents: String(user.wallet.availableCents),
      });
    }
    await freezeBanker(
      tx,
      userId,
      reserve,
      nextRound.id,
      `continue:${previousRoundId}`,
    );
    const betEndsAt = new Date(Date.now() + settings.round.betDurationSeconds * 1000);
    await tx.round.update({
      where: { id: lastRound.id },
      data: { continuationUsed: true, version: { increment: 1 } },
    });
    const continued = await tx.round.update({
      where: { id: nextRound.id },
      data: {
        phase: RoundPhase.BETTING,
        bankerId: userId,
        potCents: lastRound.potCents,
        bankerReservedCents: reserve,
        isContinued: true,
        continuationUsed: true,
        betEndsAt,
        configSnapshot: settingsSnapshot(settings),
        version: { increment: 1 },
      },
    });
    await event(tx, nextRound.id, 'BANKER_CONTINUED', {
      previousRoundId,
      bankerId: userId,
      potCents: String(lastRound.potCents),
      betEndsAt: betEndsAt.toISOString(),
    });
    return continued;
  });
}

const roundInclude = {
  room: true,
  packet: true,
  bids: { include: { user: { select: { uid: true, nickname: true, avatarUrl: true } } } },
  bets: { include: { user: { select: { uid: true, nickname: true, avatarUrl: true } } } },
  claims: {
    include: { user: { select: { uid: true, nickname: true, avatarUrl: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
};

export async function currentRoundForRoom(roomId: string) {
  // 一次读取最近两个活跃局；若进行中局与下一局 WAITING 短暂并存，仍优先进行中局。
  const rounds = await prisma.round.findMany({
    where: { roomId, phase: { in: ACTIVE_PHASES } },
    orderBy: { seqNo: 'desc' },
    include: roundInclude,
    take: 2,
  });
  return (
    rounds.find((round) => round.phase !== RoundPhase.WAITING) ??
    rounds[0] ??
    null
  );
}

/** 聊天禁言等热路径只需阶段，不应加载整局 bids / bets / claims。 */
export async function currentRoundPhaseForRoom(
  roomId: string,
): Promise<RoundPhase | null> {
  const rounds = await prisma.round.findMany({
    where: { roomId, phase: { in: ACTIVE_PHASES } },
    orderBy: { seqNo: 'desc' },
    select: { phase: true },
    take: 2,
  });
  return (
    rounds.find((round) => round.phase !== RoundPhase.WAITING)?.phase ??
    rounds[0]?.phase ??
    null
  );
}
