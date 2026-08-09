import { dressUpVirtualPlayers, listVirtualPlayers } from '../src/services/virtualPlayers.js';
import { prisma } from '../src/lib/prisma.js';

async function main() {
  const roomId = process.argv[2];
  const before = await listVirtualPlayers(roomId);
  const result = await dressUpVirtualPlayers(roomId);
  console.log(
    JSON.stringify(
      {
        before: before.map((item) => ({
          id: item.id,
          nickname: item.user.nickname,
          avatarUrl: item.user.avatarUrl,
        })),
        after: result.items.map((item) => ({
          id: item.id,
          nickname: item.user.nickname,
          avatarUrl: item.user.avatarUrl,
          avatarDisplayUrl: item.user.avatarDisplayUrl,
        })),
        count: result.count,
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
