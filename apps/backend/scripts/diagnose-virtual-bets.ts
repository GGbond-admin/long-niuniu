import { prisma } from '../src/lib/prisma.js';
import { getGameSettings } from '../src/services/gameSettings.js';
import { listEnabledVirtualsForRoom } from '../src/services/virtualPlayers.js';

async function main() {
  const settings = await getGameSettings();
  const room = await prisma.room.findFirst({ where: { gameCode: 'SUPREME_NIUNIU' } });
  if (!room) throw new Error('no room');

  const virtuals = await listEnabledVirtualsForRoom(room.id);
  const rounds = await prisma.round.findMany({
    where: { roomId: room.id },
    orderBy: { seqNo: 'desc' },
    take: 5,
    include: {
      bets: {
        include: { user: { select: { nickname: true, kind: true } } },
      },
      bids: {
        include: { user: { select: { nickname: true, kind: true } } },
      },
    },
  });

  console.log(JSON.stringify({
    assistantEnabled: settings.round.assistantEnabled,
    autoStart: settings.round.autoStart,
    roundCfg: settings.round,
    roomStatus: room.status,
    enabledVirtuals: virtuals.length,
    canBet: virtuals.filter((v) => v.canBet).length,
    inRoom: virtuals.filter((v) => v.user.roomMemberships.length).length,
    rounds: rounds.map((r) => ({
      seqNo: r.seqNo,
      phase: r.phase,
      pot: String(r.potCents),
      bankerId: r.bankerId,
      bids: r.bids.map((b) => ({
        nick: b.user.nickname,
        kind: b.user.kind,
        amount: String(b.amountCents),
      })),
      bets: r.bets.map((b) => ({
        nick: b.user.nickname,
        kind: b.user.kind,
        amount: String(b.amountCents),
        status: b.status,
      })),
    })),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
