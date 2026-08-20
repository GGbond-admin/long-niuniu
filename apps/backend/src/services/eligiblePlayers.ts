import { KycStatus, Prisma, UserStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

type DbClient = Prisma.TransactionClient | typeof prisma;

/** 与下注接受、顶栏范围、开注播报共用：在场且已实名的房间成员。 */
export function eligiblePlayerWhere(roomId: string) {
  return {
    roomId,
    status: 'ACTIVE' as const,
    user: { status: UserStatus.ACTIVE, kyc: { status: KycStatus.APPROVED } },
  };
}

export async function countEligiblePlayers(
  roomId: string,
  db: DbClient = prisma,
): Promise<number> {
  return db.roomMember.count({ where: eligiblePlayerWhere(roomId) });
}
