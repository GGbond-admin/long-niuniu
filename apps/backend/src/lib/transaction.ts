import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

type Tx = Prisma.TransactionClient;

interface SerializableOptions {
  maxWaitMs?: number;
  timeoutMs?: number;
}

/** Executes a money/state mutation at serializable isolation and retries conflicts. */
export async function serializable<T>(
  work: (tx: Tx) => Promise<T>,
  retries = 3,
  options: SerializableOptions = {},
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        ...(options.maxWaitMs === undefined ? {} : { maxWait: options.maxWaitMs }),
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      const databaseCode = (error as { meta?: { code?: string } }).meta?.code;
      const retryable =
        code === 'P2034' ||
        code === '40001' ||
        databaseCode === '40001' ||
        databaseCode === '40P01';
      if (!retryable || attempt >= retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
      attempt += 1;
    }
  }
}
