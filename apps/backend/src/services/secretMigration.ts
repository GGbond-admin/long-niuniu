import { Prisma } from '@prisma/client';
import { blindIndex, decryptSecret, encryptSecret, kycSearchHashes } from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';

function encryptSnapshot(value: Prisma.JsonValue): Prisma.InputJsonValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value as Prisma.InputJsonValue;
  const snapshot = { ...(value as Record<string, Prisma.JsonValue>) };
  for (const field of ['duitnowId', 'name', 'bankAccount', 'holder']) {
    if (typeof snapshot[field] === 'string') snapshot[field] = encryptSecret(snapshot[field]);
  }
  return snapshot as Prisma.InputJsonValue;
}

function normalizeProofReference(value: string | null): string | null {
  if (!value || value.startsWith('upload://')) return value;
  try {
    const filename = new URL(value).pathname.match(
      /\/uploads\/([0-9a-f-]{36}\.(?:jpg|png|webp|pdf))$/,
    )?.[1];
    return filename ? `upload://${filename}` : null;
  } catch {
    return null;
  }
}

/** One-way startup migration for rows created before field encryption was enabled. */
export async function migrateLegacySecrets(): Promise<void> {
  const [kycRows, bots, withdrawals, deposits] = await Promise.all([
    prisma.kyc.findMany(),
    prisma.telegramBot.findMany(),
    prisma.withdrawOrder.findMany(),
    prisma.depositOrder.findMany({ where: { proofUrl: { not: null } } }),
  ]);

  const updates: Prisma.PrismaPromise<unknown>[] = [];

  for (const row of kycRows) {
    try {
      const plainDuitnow = decryptSecret(row.duitnowId);
      const plainAccount = decryptSecret(row.bankAccount);
      const hashes = kycSearchHashes({ duitnowId: plainDuitnow, bankAccount: plainAccount });
      updates.push(
        prisma.kyc.update({
          where: { id: row.id },
          data: {
            realName: encryptSecret(row.realName),
            realNameHash: row.realNameHash ?? blindIndex(decryptSecret(row.realName)),
            duitnowId: encryptSecret(row.duitnowId),
            duitnowHash: row.duitnowHash ?? hashes.duitnowHash,
            bankAccount: encryptSecret(row.bankAccount),
            bankAccountHash: row.bankAccountHash ?? hashes.bankAccountHash,
            bankAccountLast4Hash: row.bankAccountLast4Hash ?? hashes.bankAccountLast4Hash,
            accountHolder: encryptSecret(row.accountHolder),
          },
        }),
      );
    } catch {
      // 旧环境密钥轮换后无法解密的行跳过，避免阻塞整站启动。
    }
  }

  for (const bot of bots) {
    try {
      updates.push(
        prisma.telegramBot.update({
          where: { id: bot.id },
          data: { token: encryptSecret(bot.token) },
        }),
      );
    } catch {
      // ignore undecryptable bot tokens
    }
  }

  for (const order of withdrawals) {
    try {
      updates.push(
        prisma.withdrawOrder.update({
          where: { id: order.id },
          data: { targetSnapshot: encryptSnapshot(order.targetSnapshot) },
        }),
      );
    } catch {
      // ignore undecryptable snapshots
    }
  }

  for (const order of deposits) {
    updates.push(
      prisma.depositOrder.update({
        where: { id: order.id },
        data: { proofUrl: normalizeProofReference(order.proofUrl) },
      }),
    );
  }

  if (updates.length) await prisma.$transaction(updates);
}
