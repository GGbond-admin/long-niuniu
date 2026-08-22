import { PacketStatus, Prisma, RoundPhase } from '@prisma/client';

/** 后台「有效局」：未取消的牌局（含进行中、等待下一局、已完成）。 */
export const VALID_ROUND_PHASE_WHERE: Prisma.EnumRoundPhaseFilter = {
  not: RoundPhase.CANCELLED,
};

/** 已发出但尚未核销完毕的取消局红包，财务仍要能打开登记。 */
export const UNRECONCILED_CANCELLED_PACKET_WHERE: Prisma.PacketWhereInput = {
  sentAt: { not: null },
  status: { not: PacketStatus.RECONCILED },
};

export function isValidAdminRoundPhase(phase: unknown): boolean {
  return phase !== RoundPhase.CANCELLED;
}

export function adminRoundsWhere(params: {
  roomId?: string;
  phase?: RoundPhase;
}): Prisma.RoundWhereInput {
  const where: Prisma.RoundWhereInput = {};
  if (params.roomId) where.roomId = params.roomId;
  if (params.phase === RoundPhase.CANCELLED) {
    where.phase = RoundPhase.CANCELLED;
    return where;
  }
  if (params.phase) {
    where.phase = params.phase;
    return where;
  }
  where.OR = [
    { phase: VALID_ROUND_PHASE_WHERE },
    {
      phase: RoundPhase.CANCELLED,
      packet: UNRECONCILED_CANCELLED_PACKET_WHERE,
    },
  ];
  return where;
}
