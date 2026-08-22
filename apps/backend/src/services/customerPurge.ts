import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { invalidateUserConnections } from './roomHub.js';

export const CUSTOMER_PURGE_CONFIRM_TEXT = '确认删除';

const LIVE_ROUND_PHASES = [
  'BANKER_BID',
  'BETTING',
  'SENDING_PACKET',
  'CLAIMING',
  'CLAIM_EXPIRED',
  'SETTLING',
] as const;

type DbClient = Prisma.TransactionClient | typeof prisma;

export class CustomerPurgeError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 409,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'CustomerPurgeError';
  }
}

export const CUSTOMER_PURGE_MESSAGES: Record<string, string> = {
  USER_NOT_FOUND: '未找到该用户',
  VIRTUAL_USER_CANNOT_PURGE: '虚拟玩家请到游戏运营中心删除，不能从用户中心整户清除',
  PURGE_CONFIRMATION_INVALID: '二次确认未通过：请输入正确的 UID 和“确认删除”',
  USER_IS_AGENT: '该账号仍是代理，请先在代理网络中移除代理身份',
  USER_IS_GAME_ADMIN: '该账号仍是游戏管理员，请先解除授权',
  USER_IN_ACTIVE_ROUND: '该客户仍在进行中的牌局里，请等本局结束后再删除',
  USER_HAS_FROZEN_FUNDS: '该客户仍有冻结资金，请先处理庄池、下注或提现冻结',
  USER_HAS_AVAILABLE_BALANCE: '该客户仍有可用余额，请先调出或提现后再删除',
  USER_HAS_ACTIVE_GROUP_PACKET: '该客户还有未领完的群红包，请等过期退回或领完后再删除',
  USER_HAS_PENDING_ORDERS: '该客户仍有待审核充值或提现，请先处理完再删除',
};

export function customerPurgeMessage(code: string): string {
  return CUSTOMER_PURGE_MESSAGES[code] ?? '无法删除该客户';
}

function liveRoundFilter(): Prisma.RoundWhereInput {
  return { phase: { in: [...LIVE_ROUND_PHASES] } };
}

async function assertCanPurge(
  tx: DbClient,
  input: { userId: string; confirmUid: string; confirmText: string },
) {
  const user = await tx.user.findUnique({
    where: { id: input.userId },
    select: {
      id: true,
      uid: true,
      kind: true,
      nickname: true,
      tgId: true,
      tgUsername: true,
      status: true,
      agentProfile: { select: { id: true } },
      gameAdminAssignments: { select: { id: true, gameCode: true, status: true } },
      wallet: {
        select: {
          availableCents: true,
          freezeBankerCents: true,
          freezeBetCents: true,
          freezeWithdrawCents: true,
        },
      },
    },
  });
  if (!user) throw new CustomerPurgeError('USER_NOT_FOUND', 404);
  if (user.kind === 'VIRTUAL') throw new CustomerPurgeError('VIRTUAL_USER_CANNOT_PURGE');
  if (
    input.confirmUid.trim() !== user.uid ||
    input.confirmText.trim() !== CUSTOMER_PURGE_CONFIRM_TEXT
  ) {
    throw new CustomerPurgeError('PURGE_CONFIRMATION_INVALID', 400);
  }
  if (user.agentProfile) throw new CustomerPurgeError('USER_IS_AGENT');
  if (user.gameAdminAssignments.length) throw new CustomerPurgeError('USER_IS_GAME_ADMIN');

  const wallet = user.wallet;
  if (wallet && wallet.availableCents > 0n) {
    throw new CustomerPurgeError('USER_HAS_AVAILABLE_BALANCE', 409, {
      availableCents: wallet.availableCents.toString(),
    });
  }
  if (
    wallet &&
    (wallet.freezeBankerCents > 0n ||
      wallet.freezeBetCents > 0n ||
      wallet.freezeWithdrawCents > 0n)
  ) {
    throw new CustomerPurgeError('USER_HAS_FROZEN_FUNDS');
  }

  const [
    bankerLive,
    betLive,
    bidLive,
    claimLive,
    pendingDeposits,
    pendingWithdrawals,
    activeGroupPackets,
  ] = await Promise.all([
    tx.round.count({
      where: { bankerId: user.id, ...liveRoundFilter() },
    }),
    tx.bet.count({
      where: { userId: user.id, round: liveRoundFilter() },
    }),
    tx.bankerBid.count({
      where: { userId: user.id, round: liveRoundFilter() },
    }),
    tx.claim.count({
      where: { userId: user.id, round: liveRoundFilter() },
    }),
    tx.depositOrder.count({
      where: { userId: user.id, status: 'PENDING' },
    }),
    tx.withdrawOrder.count({
      where: { userId: user.id, status: 'PENDING' },
    }),
    tx.groupPacket.count({
      where: { senderId: user.id, status: 'ACTIVE' },
    }),
  ]);
  if (bankerLive + betLive + bidLive + claimLive > 0) {
    throw new CustomerPurgeError('USER_IN_ACTIVE_ROUND');
  }
  if (pendingDeposits + pendingWithdrawals > 0) {
    throw new CustomerPurgeError('USER_HAS_PENDING_ORDERS');
  }
  if (activeGroupPackets > 0) {
    throw new CustomerPurgeError('USER_HAS_ACTIVE_GROUP_PACKET', 409, {
      activeGroupPackets,
    });
  }
  return user;
}

async function deleteOwnedRecords(tx: Prisma.TransactionClient, userId: string) {
  await tx.gameAdminActionLog.updateMany({
    where: { targetUserId: userId },
    data: { targetUserId: null },
  });
  await tx.room.updateMany({
    where: { supportHostUserId: userId },
    data: { supportHostUserId: null },
  });
  await tx.user.updateMany({
    where: { inviterId: userId },
    data: { inviterId: null },
  });
  await tx.user.updateMany({
    where: { grandInviterId: userId },
    data: { grandInviterId: null },
  });

  await tx.settlement.deleteMany({ where: { userId } });
  await tx.claim.deleteMany({ where: { userId } });
  await tx.bet.deleteMany({ where: { userId } });
  await tx.bankerBid.deleteMany({ where: { userId } });
  await tx.bankerStat.deleteMany({ where: { userId } });
  await tx.round.updateMany({
    where: { bankerId: userId },
    data: { bankerId: null },
  });

  await tx.rewardGrant.deleteMany({ where: { userId } });
  await tx.rebateSettlement.deleteMany({ where: { userId } });
  await tx.dailyHandProgress.deleteMany({ where: { userId } });
  await tx.turnoverDaily.deleteMany({ where: { userId } });
  await tx.pushLog.deleteMany({ where: { userId } });
  await tx.ledgerEntry.deleteMany({ where: { userId } });
  await tx.systemNoticeRead.deleteMany({ where: { userId } });
  await tx.chatMessage.deleteMany({ where: { userId } });

  const sentPackets = await tx.groupPacket.findMany({
    where: { senderId: userId },
    select: { id: true },
  });
  const sentPacketIds = sentPackets.map((packet) => packet.id);
  if (sentPacketIds.length) {
    await tx.groupPacketClaim.deleteMany({ where: { packetId: { in: sentPacketIds } } });
    await tx.groupPacket.deleteMany({ where: { id: { in: sentPacketIds } } });
  }
  await tx.groupPacketClaim.deleteMany({ where: { userId } });

  await tx.roomMember.deleteMany({ where: { userId } });
  await tx.depositOrder.deleteMany({ where: { userId } });
  await tx.withdrawOrder.deleteMany({ where: { userId } });
  await tx.withdrawAccount.deleteMany({ where: { userId } });
  await tx.agentPlayer.deleteMany({ where: { userId } });
  await tx.device.deleteMany({ where: { userId } });
  await tx.kyc.deleteMany({ where: { userId } });
  await tx.paymentPin.deleteMany({ where: { userId } });
  await tx.wallet.deleteMany({ where: { userId } });
  await tx.virtualPlayer.deleteMany({ where: { userId } });
  await tx.user.delete({ where: { id: userId } });
}

export async function purgeCustomer(input: {
  userId: string;
  adminId: string;
  confirmUid: string;
  confirmText: string;
  reason: string;
  ip?: string;
}) {
  const reason = input.reason.trim();
  if (reason.length < 4 || reason.length > 500) {
    throw new CustomerPurgeError('PURGE_CONFIRMATION_INVALID', 400);
  }

  const purged = await prisma.$transaction(
    async (tx) => {
      const user = await assertCanPurge(tx, input);
      await tx.auditLog.create({
        data: {
          adminId: input.adminId,
          action: 'user_purge',
          target: user.uid,
          before: {
            userId: user.id,
            uid: user.uid,
            nickname: user.nickname,
            tgId: user.tgId?.toString() ?? null,
            tgUsername: user.tgUsername,
            status: user.status,
            availableCents: user.wallet?.availableCents.toString() ?? '0',
          },
          after: { reason, confirmUid: input.confirmUid },
          ip: input.ip,
        },
      });
      await deleteOwnedRecords(tx, user.id);
      return { id: user.id, uid: user.uid };
    },
    { maxWait: 10_000, timeout: 60_000 },
  );

  await invalidateUserConnections(purged.id, 'USER_PURGED').catch(() => undefined);
  return purged;
}
