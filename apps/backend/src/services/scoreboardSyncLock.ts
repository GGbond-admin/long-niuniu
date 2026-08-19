import { randomUUID } from 'node:crypto';
import { env } from '../config.js';
import { redis } from '../lib/redis.js';

const SCOREBOARD_LOCK_TTL_MS = 60_000;
const SCOREBOARD_LOCK_RENEW_MS = 10_000;

export class ScoreboardSyncLockUnavailableError extends Error {
  constructor() {
    super('SCOREBOARD_SYNC_LOCK_UNAVAILABLE');
  }
}

export class ScoreboardSyncLockLostError extends Error {
  constructor() {
    super('SCOREBOARD_SYNC_LOCK_LOST');
  }
}

export type ScoreboardSyncLease = {
  /** Redis Lua 写操作使用同一 token 做原子 fencing。开发降级时为 null。 */
  fence: { key: string; token: string } | null;
  /** 在每次外部副作用前校验并续租，锁丢失后禁止继续改写消息。 */
  assertHeld: () => Promise<void>;
};

const renewScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
  return 1
end
return 0
`;

const releaseScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

async function tryWithScoreboardSyncLock<T>(
  key: string,
  work: (lease: ScoreboardSyncLease) => Promise<T>,
): Promise<T | null> {
  const instance = redis();
  const token = `${process.pid}:${randomUUID()}`;
  try {
    const acquired = await instance.set(
      key,
      token,
      'PX',
      SCOREBOARD_LOCK_TTL_MS,
      'NX',
    );
    if (acquired !== 'OK') return null;
  } catch {
    if (env.nodeEnv === 'production') return null;
    return work({ fence: null, assertHeld: async () => undefined });
  }

  let lost = false;
  let renewal: Promise<void> | null = null;
  const renew = () => {
    if (renewal) return renewal;
    renewal = (async () => {
      try {
        const held = await instance.eval(
          renewScript,
          1,
          key,
          token,
          String(SCOREBOARD_LOCK_TTL_MS),
        );
        if (Number(held) !== 1) lost = true;
      } catch {
        if (env.nodeEnv === 'production') lost = true;
      } finally {
        renewal = null;
      }
    })();
    return renewal;
  };
  const lease: ScoreboardSyncLease = {
    fence: { key, token },
    assertHeld: async () => {
      if (lost) throw new ScoreboardSyncLockLostError();
      await renew();
      if (lost) throw new ScoreboardSyncLockLostError();
    },
  };
  const heartbeat = setInterval(() => {
    void renew();
  }, SCOREBOARD_LOCK_RENEW_MS);
  heartbeat.unref?.();

  try {
    await lease.assertHeld();
    const result = await work(lease);
    // 覆盖“最后一个副作用执行期间 heartbeat 才发现丢锁”的窗口。
    await lease.assertHeld();
    return result;
  } finally {
    clearInterval(heartbeat);
    await renewal;
    await instance.eval(releaseScript, 1, key, token).catch(() => undefined);
  }
}

/**
 * 自动结算播报与后台展示同步共用同一把分布式锁，避免旧文案覆盖新修订。
 * 持锁期间定时续租，并要求调用方在每个消息副作用前校验 lease；
 * Redis 不可用或锁长期被占用时 fail-closed。
 */
export async function withScoreboardSyncLock<T>(
  roundId: string,
  work: (lease: ScoreboardSyncLease) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await tryWithScoreboardSyncLock(
      `niuniu:round:${roundId}:scoreboard-presentation`,
      work,
    );
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new ScoreboardSyncLockUnavailableError();
}
