import { prisma } from '../src/lib/prisma.js';
import {
  createVirtualPlayer,
  listVirtualPlayers,
  VIRTUAL_ROOM_CAP,
} from '../src/services/virtualPlayers.js';

async function main() {
  const target = Number(process.argv[2] || 15);
  if (!Number.isFinite(target) || target < 1) {
    throw new Error('usage: tsx scripts/import-virtual-players.ts [count]');
  }

  const room = await prisma.room.findFirst({ where: { gameCode: 'SUPREME_NIUNIU' } });
  if (!room) throw new Error('ROOM_NOT_FOUND');

  const existing = await listVirtualPlayers(room.id);
  const need = Math.max(0, target - existing.length);
  if (need === 0) {
    console.log(JSON.stringify({
      roomId: room.id,
      message: `已有 ${existing.length} 人，无需再导入`,
      total: existing.length,
      players: existing.map((item) => ({
        nickname: item.user.nickname,
        uid: item.user.uid,
        avatarUrl: item.user.avatarUrl,
      })),
    }, null, 2));
    return;
  }
  if (existing.length + need > VIRTUAL_ROOM_CAP) {
    throw new Error(`超过单群上限 ${VIRTUAL_ROOM_CAP}（当前 ${existing.length}，还要 ${need}）`);
  }

  const created: Array<{ nickname: string | null; uid: string; avatarUrl: string | null }> = [];
  for (let i = 0; i < need; i += 1) {
    const item = await createVirtualPlayer({
      roomId: room.id,
      autoNickname: true,
      initialFundCents: 500_000n,
      targetBalanceCents: 500_000n,
      joinRoom: true,
      createdBy: 'IMPORT',
    });
    created.push({
      nickname: item.user.nickname,
      uid: item.user.uid,
      avatarUrl: item.user.avatarUrl,
    });
  }

  const after = await listVirtualPlayers(room.id);
  console.log(JSON.stringify({
    roomId: room.id,
    created: created.length,
    total: after.length,
    players: created,
  }, null, 2));
}

main()
  .catch(async (error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
