import { prisma } from '../src/lib/prisma.js';

async function main() {
  const configs = await prisma.gameConfig.findMany({ where: { key: 'hand' } });
  for (const config of configs) {
    const value = config.value as Record<string, unknown>;
    console.log(
      `gameCode=${config.gameCode} bustEnabled=${value.bustEnabled} bustThreshold=${value.bustThreshold} updatedAt=${config.updatedAt.toISOString()}`,
    );
  }

  const rounds = await prisma.round.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true, seqNo: true, configSnapshot: true, createdAt: true },
  });
  for (const round of rounds) {
    const snapshot = round.configSnapshot as { hand?: Record<string, unknown> } | null;
    console.log(
      `round #${round.seqNo} (${round.createdAt.toISOString()}) hand=`,
      snapshot?.hand
        ? {
            bustEnabled: snapshot.hand.bustEnabled,
            bustThreshold: snapshot.hand.bustThreshold,
          }
        : 'no snapshot',
    );
  }
}

main().finally(() => prisma.$disconnect());
