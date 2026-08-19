/**
 * 群内玩家自发红包（拼手气）与打赏客服：
 * - 发包：余额划转到平台在途科目，群里出现红包气泡，先到先得
 * - 抢包：随机拆分（微信拼手气算法），入账玩家余额
 * - 过期：10 分钟未领完自动退回发送者
 * - 打赏：余额直接转入平台费用科目，群内播报感谢
 */
import {
  AccountType,
  GroupPacketFundingSource,
  KycStatus,
  LedgerDirection,
  UserStatus,
} from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { serializable } from '../lib/transaction.js';
import { GameError } from './game.js';
import {
  assertPaymentPinVersion,
  verifyPaymentPin,
} from './paymentPin.js';
import {
  ensureGameBudgetAccount,
  postGameBudget,
} from './gameBudget.js';
import {
  requireGameAdminAssignment,
  requireGameAdminAssignmentInTx,
} from './gameAdmin.js';
import { post, transfer } from './wallet.js';

type Tx = Parameters<Parameters<typeof serializable>[0]>[0];

export const GROUP_PACKET_MAX_COUNT = 50;
export const GROUP_PACKET_MIN_TOTAL_CENTS = 10n; // RM0.10
export const GROUP_PACKET_MAX_TOTAL_CENTS = 1_000_000n; // RM10,000
export const GROUP_PACKET_EXPIRE_MS = 24 * 60 * 60 * 1_000;

async function requireMember(
  tx: Tx,
  userId: string,
  roomId: string,
  options: { canPublish?: boolean } = {},
) {
  const user = await tx.user.findUnique({
    where: { id: userId },
    include: {
      kyc: true,
      wallet: true,
      roomMemberships: {
        where: { roomId },
        include: {
          room: {
            select: {
              chatMutedAt: true,
              chatMuteReason: true,
            },
          },
        },
        take: 1,
      },
    },
  });
  if (!user || user.status !== UserStatus.ACTIVE) throw new GameError('USER_NOT_ACTIVE');
  if (user.kyc?.status !== KycStatus.APPROVED) throw new GameError('KYC_REQUIRED');
  if (!user.wallet) throw new GameError('WALLET_NOT_FOUND');
  const member = user.roomMemberships[0];
  if (member?.status !== 'ACTIVE') throw new GameError('NOT_IN_ROOM');
  if (member.room?.chatMutedAt) {
    throw new GameError('ROOM_GLOBAL_MUTED', {
      mutedAt: member.room.chatMutedAt.toISOString(),
      reason: member.room.chatMuteReason,
    });
  }
  if (
    options.canPublish
    && member.chatMutedAt
    && (!member.chatMutedUntil || member.chatMutedUntil > new Date())
  ) {
    throw new GameError('ROOM_CHAT_MUTED', {
      mutedUntil: member.chatMutedUntil?.toISOString() ?? null,
      reason: member.chatMuteReason,
    });
  }
  return user;
}

function randomBigIntBelow(maxExclusive: bigint): bigint {
  if (maxExclusive <= 0n) throw new GameError('INVALID_PACKET_AMOUNT');
  const bits = maxExclusive.toString(2).length;
  const bytes = Math.ceil(bits / 8);
  const mask = (1n << BigInt(bits)) - 1n;
  while (true) {
    const raw = randomBytes(bytes);
    let candidate = 0n;
    for (const byte of raw) candidate = (candidate << 8n) | BigInt(byte);
    candidate &= mask;
    if (candidate < maxExclusive) return candidate;
  }
}

/** 微信式拼手气：剩 1 份给全部，否则在 [1, 2×人均] 内随机并保证后续每份 ≥1 分。 */
export function randomShare(
  remainingCents: bigint,
  remainingCount: number,
): bigint {
  if (remainingCount <= 1) return remainingCents;
  const futureMinimum = BigInt(remainingCount - 1);
  const maximumAvailable = remainingCents - futureMinimum;
  const luckyCap = (remainingCents / BigInt(remainingCount)) * 2n;
  const upper = luckyCap < maximumAvailable ? luckyCap : maximumAvailable;
  return randomBigIntBelow(upper) + 1n;
}

/** 平分：整除均分，最后一份拿余数 */
function equalShare(remainingCents: bigint, remainingCount: number): bigint {
  if (remainingCount <= 1) return remainingCents;
  return remainingCents / BigInt(remainingCount);
}

export async function sendGroupPacket(params: {
  roomId: string;
  userId: string;
  totalCents: bigint;
  count: number;
  mode?: 'RANDOM' | 'EQUAL';
  greeting?: string;
  requestId: string;
  paymentPin: string;
}) {
  const { totalCents, count } = params;
  const mode = params.mode === 'EQUAL' ? 'EQUAL' : 'RANDOM';
  const greeting = (params.greeting ?? '恭喜发财，大吉大利').trim().slice(0, 40) || '恭喜发财，大吉大利';
  if (!Number.isInteger(count) || count < 1 || count > GROUP_PACKET_MAX_COUNT) {
    throw new GameError('INVALID_PACKET_COUNT');
  }
  if (totalCents < GROUP_PACKET_MIN_TOTAL_CENTS || totalCents > GROUP_PACKET_MAX_TOTAL_CENTS) {
    throw new GameError('INVALID_PACKET_AMOUNT');
  }
  if (totalCents < BigInt(count)) throw new GameError('PACKET_TOO_SMALL'); // 每份至少 1 分

  const matchesRequest = (packet: {
    roomId: string;
    senderId: string;
    totalCents: bigint;
    count: number;
    mode: string;
    greeting: string;
    fundingSource: GroupPacketFundingSource;
    budgetAccountId: string | null;
    gameAdminAssignmentId: string | null;
  }) =>
    packet.roomId === params.roomId &&
    packet.senderId === params.userId &&
    packet.totalCents === totalCents &&
    packet.count === count &&
    packet.mode === mode &&
    packet.greeting === greeting &&
    packet.fundingSource === GroupPacketFundingSource.USER_WALLET &&
    packet.budgetAccountId === null &&
    packet.gameAdminAssignmentId === null;

  const replay = await prisma.groupPacket.findUnique({
    where: {
      senderId_requestId: {
        senderId: params.userId,
        requestId: params.requestId,
      },
    },
  });
  if (replay) {
    if (!matchesRequest(replay)) throw new GameError('IDEMPOTENCY_CONFLICT');
    return { packet: replay, duplicate: true };
  }

  const paymentPinVersion = await verifyPaymentPin(params.userId, params.paymentPin);

  return serializable(async (tx) => {
    const existing = await tx.groupPacket.findUnique({
      where: {
        senderId_requestId: {
          senderId: params.userId,
          requestId: params.requestId,
        },
      },
    });
    if (existing) {
      if (!matchesRequest(existing)) throw new GameError('IDEMPOTENCY_CONFLICT');
      return { packet: existing, duplicate: true };
    }
    await assertPaymentPinVersion(tx, params.userId, paymentPinVersion);
    await requireMember(tx, params.userId, params.roomId, { canPublish: true });
    const packet = await tx.groupPacket.create({
      data: {
        roomId: params.roomId,
        senderId: params.userId,
        requestId: params.requestId,
        totalCents,
        count,
        remainingCents: totalCents,
        remainingCount: count,
        mode,
        greeting,
        expiresAt: new Date(Date.now() + GROUP_PACKET_EXPIRE_MS),
      },
    });
    await transfer(tx, {
      amountCents: totalCents,
      from: { userId: params.userId, accountType: AccountType.USER_AVAILABLE },
      to: { accountType: AccountType.PLATFORM_RESERVE },
      refType: 'group_packet_create',
      refId: packet.id,
      idempotencyKey: `gpk:${packet.id}`,
    });
    return { packet, duplicate: false };
  });
}

/** 游戏管理员从游戏共享预算发红包；操作者身份仍使用其 Telegram 用户资料。 */
export async function sendGameBudgetPacket(params: {
  gameCode: string;
  userId: string;
  totalCents: bigint;
  count: number;
  mode?: 'RANDOM' | 'EQUAL';
  greeting?: string;
  requestId: string;
  paymentPin: string;
  ip?: string;
}) {
  const mode = params.mode === 'EQUAL' ? 'EQUAL' : 'RANDOM';
  const greeting =
    (params.greeting ?? '恭喜发财，大吉大利').trim().slice(0, 40)
    || '恭喜发财，大吉大利';
  if (
    !Number.isInteger(params.count)
    || params.count < 1
    || params.count > GROUP_PACKET_MAX_COUNT
  ) {
    throw new GameError('INVALID_PACKET_COUNT');
  }
  if (params.totalCents < GROUP_PACKET_MIN_TOTAL_CENTS) {
    throw new GameError('INVALID_PACKET_AMOUNT');
  }
  if (params.totalCents < BigInt(params.count)) {
    throw new GameError('PACKET_TOO_SMALL');
  }

  const assignment = await requireGameAdminAssignment({
    userId: params.userId,
    gameCode: params.gameCode,
    permission: 'SEND_BUDGET_PACKET',
  });
  const matchesRequest = (packet: {
    roomId: string;
    senderId: string;
    totalCents: bigint;
    count: number;
    mode: string;
    greeting: string;
    fundingSource: GroupPacketFundingSource;
    gameAdminAssignmentId: string | null;
  }) =>
    packet.roomId === assignment.room.id
    && packet.senderId === params.userId
    && packet.totalCents === params.totalCents
    && packet.count === params.count
    && packet.mode === mode
    && packet.greeting === greeting
    && packet.fundingSource === GroupPacketFundingSource.GAME_BUDGET
    && packet.gameAdminAssignmentId === assignment.id;

  const replay = await prisma.groupPacket.findUnique({
    where: {
      senderId_requestId: {
        senderId: params.userId,
        requestId: params.requestId,
      },
    },
  });
  if (replay) {
    if (!matchesRequest(replay)) throw new GameError('IDEMPOTENCY_CONFLICT');
    return { packet: replay, duplicate: true, assignment };
  }

  const paymentPinVersion = await verifyPaymentPin(params.userId, params.paymentPin);
  return serializable(async (tx) => {
    const lockedAssignment = await requireGameAdminAssignmentInTx(tx, {
      userId: params.userId,
      gameCode: params.gameCode,
      permission: 'SEND_BUDGET_PACKET',
    });
    const existing = await tx.groupPacket.findUnique({
      where: {
        senderId_requestId: {
          senderId: params.userId,
          requestId: params.requestId,
        },
      },
    });
    if (existing) {
      if (!matchesRequest(existing)) throw new GameError('IDEMPOTENCY_CONFLICT');
      return { packet: existing, duplicate: true, assignment: lockedAssignment };
    }

    await assertPaymentPinVersion(tx, params.userId, paymentPinVersion);
    const budget = await ensureGameBudgetAccount(tx, params.gameCode);
    const packet = await tx.groupPacket.create({
      data: {
        roomId: lockedAssignment.room.id,
        senderId: params.userId,
        requestId: params.requestId,
        totalCents: params.totalCents,
        count: params.count,
        remainingCents: params.totalCents,
        remainingCount: params.count,
        mode,
        greeting,
        fundingSource: GroupPacketFundingSource.GAME_BUDGET,
        budgetAccountId: budget.id,
        gameAdminAssignmentId: lockedAssignment.id,
        expiresAt: new Date(Date.now() + GROUP_PACKET_EXPIRE_MS),
      },
    });
    await postGameBudget(tx, {
      budgetAccountId: budget.id,
      direction: LedgerDirection.DEBIT,
      amountCents: params.totalCents,
      refType: 'group_packet_create',
      refId: packet.id,
      idempotencyKey: `gpk-budget:${packet.id}`,
      gameAdminAssignmentId: lockedAssignment.id,
      memo: greeting,
    });
    await post(tx, {
      accountType: AccountType.PLATFORM_RESERVE,
      direction: LedgerDirection.CREDIT,
      amountCents: params.totalCents,
      refType: 'group_packet_create',
      refId: packet.id,
      idempotencyKey: `gpk-budget:${packet.id}:reserve`,
      operatorId: params.userId,
      memo: `游戏管理员预算红包 · ${params.gameCode}`,
    });
    await tx.gameAdminActionLog.create({
      data: {
        assignmentId: lockedAssignment.id,
        gameCode: params.gameCode,
        action: 'PACKET_SEND',
        packetId: packet.id,
        idempotencyKey: `game-admin-packet:${packet.id}`,
        metadata: {
          amountCents: String(params.totalCents),
          count: params.count,
          mode,
          greeting,
          budgetBalanceCents: String(budget.balanceCents - params.totalCents),
        },
        ip: params.ip,
      },
    });
    return { packet, duplicate: false, assignment: lockedAssignment };
  });
}

export async function claimGroupPacket(params: { packetId: string; userId: string }) {
  return serializable(async (tx) => {
    const packet = await tx.groupPacket.findUnique({ where: { id: params.packetId } });
    if (!packet) throw new GameError('PACKET_NOT_FOUND');
    if (packet.status !== 'ACTIVE' || packet.remainingCount <= 0) {
      throw new GameError('PACKET_EMPTY');
    }
    if (packet.expiresAt <= new Date()) throw new GameError('PACKET_EXPIRED');
    await requireMember(tx, params.userId, packet.roomId);

    const existing = await tx.groupPacketClaim.findUnique({
      where: { packetId_userId: { packetId: packet.id, userId: params.userId } },
    });
    if (existing) throw new GameError('ALREADY_CLAIMED');

    const amountCents =
      packet.mode === 'EQUAL'
        ? equalShare(packet.remainingCents, packet.remainingCount)
        : randomShare(packet.remainingCents, packet.remainingCount);
    const claim = await tx.groupPacketClaim.create({
      data: { packetId: packet.id, userId: params.userId, amountCents },
    });
    const remainingCount = packet.remainingCount - 1;
    await tx.groupPacket.update({
      where: { id: packet.id },
      data: {
        remainingCents: packet.remainingCents - amountCents,
        remainingCount,
        status: remainingCount === 0 ? 'FINISHED' : 'ACTIVE',
      },
    });
    try {
      await transfer(tx, {
        amountCents,
        from: { accountType: AccountType.PLATFORM_RESERVE },
        to: { userId: params.userId, accountType: AccountType.USER_AVAILABLE },
        refType: 'group_packet_claim',
        refId: claim.id,
        idempotencyKey: `gpkc:${packet.id}:${params.userId}`,
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'INSUFFICIENT_BALANCE') {
        throw new GameError('PACKET_ESCROW_UNAVAILABLE');
      }
      throw error;
    }
    return {
      amountCents,
      finished: remainingCount === 0,
      roomId: packet.roomId,
      senderId: packet.senderId,
    };
  });
}

export async function groupPacketDetail(packetId: string) {
  const packet = await prisma.groupPacket.findUnique({
    where: { id: packetId },
    include: {
      sender: { select: { uid: true, nickname: true, avatarUrl: true } },
      claims: {
        include: { user: { select: { uid: true, nickname: true, avatarUrl: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!packet) throw new GameError('PACKET_NOT_FOUND');
  return packet;
}

/** 调度器周期调用：24 小时后静默过期，未领余额原路退回发送者。 */
export async function expireGroupPackets(): Promise<void> {
  const due = await prisma.groupPacket.findMany({
    where: { status: 'ACTIVE', expiresAt: { lte: new Date() } },
    take: 50,
  });
  for (const packet of due) {
    await serializable(async (tx) => {
      const current = await tx.groupPacket.findUnique({ where: { id: packet.id } });
      if (!current || current.status !== 'ACTIVE') return;
      await tx.groupPacket.update({
        where: { id: packet.id },
        data: { status: 'EXPIRED' },
      });
      if (current.remainingCents > 0n) {
        if (
          current.fundingSource === GroupPacketFundingSource.GAME_BUDGET
          && current.budgetAccountId
        ) {
          await post(tx, {
            accountType: AccountType.PLATFORM_RESERVE,
            direction: LedgerDirection.DEBIT,
            amountCents: current.remainingCents,
            refType: 'group_packet_refund',
            refId: packet.id,
            idempotencyKey: `gpkr-budget:${packet.id}:reserve`,
            operatorId: current.senderId,
          });
          await postGameBudget(tx, {
            budgetAccountId: current.budgetAccountId,
            direction: LedgerDirection.CREDIT,
            amountCents: current.remainingCents,
            refType: 'group_packet_refund',
            refId: packet.id,
            idempotencyKey: `gpkr-budget:${packet.id}`,
            gameAdminAssignmentId: current.gameAdminAssignmentId ?? undefined,
          });
        } else {
          await transfer(tx, {
            amountCents: current.remainingCents,
            from: { accountType: AccountType.PLATFORM_RESERVE },
            to: { userId: current.senderId, accountType: AccountType.USER_AVAILABLE },
            refType: 'group_packet_refund',
            refId: packet.id,
            idempotencyKey: `gpkr:${packet.id}`,
          });
        }
      }
    });
  }
}

export const TIP_MIN_CENTS = 100n; // RM1
export const TIP_MAX_CENTS = 500_000n; // RM5,000

/** 打赏客服时随机附带的祝福语 */
export const TIP_MESSAGES = [
  '辛苦啦，喝杯奶茶续续命～',
  '谢谢小妹一直在线护航！',
  '手气全靠你，先敬一杯！',
  '服务太赞了，必须支持一下',
  '愿小妹天天开心，财运爆棚',
  '感谢陪伴，下一把继续冲！',
  '小妹最美，打赏一份心意',
  '夜深了，记得休息哦～',
] as const;

export function pickTipMessage(): string {
  return TIP_MESSAGES[Math.floor(Math.random() * TIP_MESSAGES.length)]!;
}

/** 打赏客服小妹：余额 → 平台费用科目 */
export async function tipSupport(params: {
  roomId: string;
  userId: string;
  amountCents: bigint;
  requestId: string;
  paymentPin: string;
}) {
  if (params.amountCents < TIP_MIN_CENTS || params.amountCents > TIP_MAX_CENTS) {
    throw new GameError('INVALID_TIP_AMOUNT');
  }
  const idempotencyKey = `tip:${params.userId}:${params.requestId}`;
  const replay = await prisma.ledgerEntry.findUnique({
    where: { idempotencyKey: `${idempotencyKey}:out` },
  });
  if (replay) {
    if (replay.amountCents !== params.amountCents) {
      throw new GameError('IDEMPOTENCY_CONFLICT');
    }
    return { duplicate: true };
  }

  const paymentPinVersion = await verifyPaymentPin(params.userId, params.paymentPin);

  return serializable(async (tx) => {
    await requireMember(tx, params.userId, params.roomId, { canPublish: true });
    const existing = await tx.ledgerEntry.findUnique({
      where: { idempotencyKey: `${idempotencyKey}:out` },
    });
    if (existing) {
      if (existing.amountCents !== params.amountCents) {
        throw new GameError('IDEMPOTENCY_CONFLICT');
      }
      return { duplicate: true };
    }
    await assertPaymentPinVersion(tx, params.userId, paymentPinVersion);
    await transfer(tx, {
      amountCents: params.amountCents,
      from: { userId: params.userId, accountType: AccountType.USER_AVAILABLE },
      to: { accountType: AccountType.PLATFORM_FEES },
      refType: 'tip',
      refId: params.requestId,
      idempotencyKey,
      memo: '打赏客服',
    });
    return { duplicate: false };
  });
}
