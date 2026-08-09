import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { env } from '../config.js';

let client: Redis | null = null;

export function redis(): Redis {
  if (!client) {
    client = new Redis(env.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    client.on('error', () => undefined);
  }
  return client;
}

export async function connectRedis(): Promise<boolean> {
  const instance = redis();
  try {
    if (instance.status === 'wait') await instance.connect();
    await instance.ping();
    return true;
  } catch {
    return false;
  }
}

export async function disconnectRedis(): Promise<void> {
  if (!client) return;
  await client.quit().catch(() => client?.disconnect());
  client = null;
}

export async function withRedisLock<T>(
  key: string,
  ttlMs: number,
  work: () => Promise<T>,
): Promise<T | null> {
  const instance = redis();
  const token = `${process.pid}:${randomUUID()}`;
  try {
    const acquired = await instance.set(key, token, 'PX', ttlMs, 'NX');
    if (acquired !== 'OK') return null;
  } catch {
    // 生产可能多实例：Redis 不可用时 fail-closed，避免并发推进；
    // 开发单实例依赖 PostgreSQL 幂等事务，直接放行以便本地无 Redis 也能跑。
    if (env.nodeEnv === 'production') return null;
    return work();
  }
  try {
    return await work();
  } finally {
    await instance
      .eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
        1,
        key,
        token,
      )
      .catch(() => undefined);
  }
}
