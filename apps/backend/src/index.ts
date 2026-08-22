import { AccountType } from '@prisma/client';
import { buildServer } from './server.js';
import { startBots, stopBots } from './bot/index.js';
import { env } from './config.js';
import { prisma } from './lib/prisma.js';
import { hashPassword } from './routes/admin.js';
import { migrateLegacySecrets } from './services/secretMigration.js';
import { connectRedis, disconnectRedis } from './lib/redis.js';
import { roundScheduler } from './services/roundScheduler.js';
import { ensureRewardDefaults } from './services/rewards.js';
import { backgroundJobs } from './services/backgroundJobs.js';
import { ensureGameConfigDefaults } from './services/gameSettings.js';
import { ensureCatalogInteractionGroups } from './services/gameCatalog.js';
import { initVirtualPlayerWorker } from './services/virtualPlayerWorker.js';
import { initTngSchedulerWorker, stopTngSchedulerWorker } from './services/tngSchedulerWorker.js';
import { ensureMissingUserAvatars } from './services/user.js';
import { ensureHouseInviter } from './services/houseInviter.js';
import { ensureGameRuleDefaults } from './services/gameRules.js';

async function ensureSeedAdmin() {
  const count = await prisma.admin.count();
  if (count === 0 && env.seedAdminPassword) {
    await prisma.admin.create({
      data: {
        username: env.seedAdminUsername,
        passwordHash: await hashPassword(env.seedAdminPassword),
        role: 'SUPER',
      },
    });
    console.log(`[seed] created initial admin: ${env.seedAdminUsername}`);
  } else if (count === 0) {
    throw new Error('No admin exists. Set SEED_ADMIN_PASSWORD for the first production start.');
  }
}

async function ensurePlatformAccounts() {
  const accountTypes = Object.values(AccountType).filter(
    (type) => !type.startsWith('USER_'),
  );
  await Promise.all(
    accountTypes.map((accountType) =>
      prisma.platformAccount.upsert({
        where: { accountType },
        create: { accountType, balanceCents: 0 },
        update: {},
      }),
    ),
  );
}

async function main() {
  const app = await buildServer();
  await ensureSeedAdmin();
  await ensurePlatformAccounts();
  await migrateLegacySecrets();
  await ensureGameConfigDefaults();
  await ensureRewardDefaults();
  await ensureGameRuleDefaults();
  await ensureCatalogInteractionGroups();
  const avatarsBackfilled = await ensureMissingUserAvatars();
  if (avatarsBackfilled > 0) {
    console.log(`[avatar] assigned defaults to ${avatarsBackfilled} existing users`);
  }
  const house = await ensureHouseInviter();
  console.log(`[house] official invite code ${house.uid}`);
  const redisReady = await connectRedis();
  console.log(`[redis] ${redisReady ? 'connected' : 'unavailable; database fallback active'}`);
  await app.listen({ port: env.port, host: '0.0.0.0' });
  console.log(`[api] listening on :${env.port}`);

  // Bot 长轮询（无 token 时跳过）
  await startBots().catch((e) => {
    console.error('[bot] failed to start:', e.message);
    return [];
  });
  roundScheduler.start();
  backgroundJobs.start();
  initVirtualPlayerWorker();
  initTngSchedulerWorker();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal}`);
    roundScheduler.stop();
    backgroundJobs.stop();
    stopTngSchedulerWorker();
    await stopBots();
    await app.close();
    await disconnectRedis();
    await prisma.$disconnect();
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
