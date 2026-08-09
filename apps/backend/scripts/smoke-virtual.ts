import { prisma } from '../src/lib/prisma.js';
import { createVirtualPlayer, listVirtualPlayers } from '../src/services/virtualPlayers.js';

async function main() {
  const room = await prisma.room.findFirst({ where: { gameCode: 'SUPREME_NIUNIU' } });
  if (!room) throw new Error('no room');
  const existing = await prisma.virtualPlayer.findFirst({
    where: { user: { nickname: '测试假人甲' } },
  });
  const item = existing
    ? (await listVirtualPlayers(room.id)).find((row) => row.id === existing.id)!
    : await createVirtualPlayer({
        nickname: '测试假人甲',
        roomId: room.id,
        initialFundCents: 500_000n,
        targetBalanceCents: 500_000n,
        joinRoom: true,
        createdBy: 'SMOKE',
      });
  const list = await listVirtualPlayers(room.id);
  console.log(
    JSON.stringify(
      {
        id: item.id,
        uid: item.user.uid,
        balance: item.user.wallet?.availableCents,
        inRoom: item.user.roomMemberships?.[0]?.status,
        count: list.length,
      },
      null,
      2,
    ),
  );
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
