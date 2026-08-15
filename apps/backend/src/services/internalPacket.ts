/**
 * 内部红包（小助手直发）收尾编排：
 * 全员认额齐备后自动结算、开下一局并广播成绩单，无需运营手动点「结算」。
 * 由抢包路由（最后一人抢完）与调度器（超时补录后）两处触发，settleGameRound 幂等。
 */
import { PacketChannel, RoundPhase } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { ensureWaitingRound, settleGameRound } from './game.js';
import { gameBus } from './gameBus.js';
import { processRoundRewards } from './rewards.js';

export async function finalizeInternalRound(roundId: string): Promise<boolean> {
  const round = await prisma.round.findUnique({
    where: { id: roundId },
    select: {
      roomId: true,
      phase: true,
      packet: { select: { channel: true, participantCount: true } },
      _count: { select: { claims: true } },
    },
  });
  if (!round?.packet || round.packet.channel !== PacketChannel.INTERNAL) return false;
  if (round.phase !== RoundPhase.CLAIMING && round.phase !== RoundPhase.CLAIM_EXPIRED) {
    return false;
  }
  if (round._count.claims < round.packet.participantCount) return false;

  const fromPhase = round.phase;
  await settleGameRound(roundId, 'SYSTEM');
  // FINISHED 广播会触发客户端刷新与续庄询问，需先保证紧邻 WAITING 局可见。
  await ensureWaitingRound(round.roomId).catch(() => undefined);
  gameBus.transition({
    roundId,
    roomId: round.roomId,
    from: fromPhase,
    to: RoundPhase.FINISHED,
  });
  await processRoundRewards(roundId).catch(() => undefined);
  return true;
}
