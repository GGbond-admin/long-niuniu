import { env } from '../config.js';
import { redis } from '../lib/redis.js';

export const ASSISTANT_LEASE_TTL_MS = 60_000;

export interface AssistantLease {
  roomId: string;
  adminId: string;
  adminName: string;
  takenAt: string;
  expiresAt: string;
}

const memoryLeases = new Map<string, AssistantLease>();

function leaseKey(roomId: string) {
  return `niuniu:assist:room:${roomId}`;
}

function parseLease(raw: string | null): AssistantLease | null {
  if (!raw) return null;
  try {
    const lease = JSON.parse(raw) as AssistantLease;
    if (
      !lease.roomId ||
      !lease.adminId ||
      !lease.adminName ||
      !lease.takenAt ||
      !lease.expiresAt
    ) {
      return null;
    }
    return lease;
  } catch {
    return null;
  }
}

function activeMemoryLease(roomId: string): AssistantLease | null {
  const lease = memoryLeases.get(roomId) ?? null;
  if (!lease) return null;
  if (new Date(lease.expiresAt).getTime() <= Date.now()) {
    memoryLeases.delete(roomId);
    return null;
  }
  return lease;
}

function nextLease(params: {
  roomId: string;
  adminId: string;
  adminName: string;
  takenAt?: string;
}): AssistantLease {
  const now = new Date();
  return {
    roomId: params.roomId,
    adminId: params.adminId,
    adminName: params.adminName,
    takenAt: params.takenAt ?? now.toISOString(),
    expiresAt: new Date(now.getTime() + ASSISTANT_LEASE_TTL_MS).toISOString(),
  };
}

async function withDevelopmentFallback<T>(
  redisWork: () => Promise<T>,
  fallback: () => T,
): Promise<T> {
  try {
    return await redisWork();
  } catch {
    if (env.nodeEnv === 'production') {
      throw new Error('ASSISTANT_LEASE_UNAVAILABLE');
    }
    return fallback();
  }
}

export async function assistantLeaseStatus(roomId: string): Promise<AssistantLease | null> {
  return withDevelopmentFallback(
    async () => parseLease(await redis().get(leaseKey(roomId))),
    () => activeMemoryLease(roomId),
  );
}

export async function acquireAssistantLease(params: {
  roomId: string;
  adminId: string;
  adminName: string;
}): Promise<{ acquired: boolean; lease: AssistantLease | null }> {
  const lease = nextLease(params);
  return withDevelopmentFallback(
    async () => {
      const acquired = await redis().set(
        leaseKey(params.roomId),
        JSON.stringify(lease),
        'PX',
        ASSISTANT_LEASE_TTL_MS,
        'NX',
      );
      if (acquired === 'OK') return { acquired: true, lease };
      return {
        acquired: false,
        lease: parseLease(await redis().get(leaseKey(params.roomId))),
      };
    },
    () => {
      const current = activeMemoryLease(params.roomId);
      if (current) return { acquired: false, lease: current };
      memoryLeases.set(params.roomId, lease);
      return { acquired: true, lease };
    },
  );
}

/** SUPER 强制接管：单次覆盖写租约，避免 release+acquire 竞态窗口。 */
export async function forceAcquireAssistantLease(params: {
  roomId: string;
  adminId: string;
  adminName: string;
}): Promise<{ lease: AssistantLease; previous: AssistantLease | null }> {
  const lease = nextLease(params);
  return withDevelopmentFallback(
    async () => {
      const previous = parseLease(await redis().get(leaseKey(params.roomId)));
      await redis().set(
        leaseKey(params.roomId),
        JSON.stringify(lease),
        'PX',
        ASSISTANT_LEASE_TTL_MS,
      );
      return { lease, previous };
    },
    () => {
      const previous = activeMemoryLease(params.roomId);
      memoryLeases.set(params.roomId, lease);
      return { lease, previous };
    },
  );
}

export async function heartbeatAssistantLease(
  roomId: string,
  adminId: string,
): Promise<AssistantLease | null> {
  return withDevelopmentFallback(
    async () => {
      const expiresAt = new Date(Date.now() + ASSISTANT_LEASE_TTL_MS).toISOString();
      const result = await redis().eval(
        `
          local raw = redis.call('get', KEYS[1])
          if not raw then return nil end
          local value = cjson.decode(raw)
          if value.adminId ~= ARGV[1] then return nil end
          value.expiresAt = ARGV[2]
          local next = cjson.encode(value)
          redis.call('set', KEYS[1], next, 'PX', ARGV[3])
          return next
        `,
        1,
        leaseKey(roomId),
        adminId,
        expiresAt,
        String(ASSISTANT_LEASE_TTL_MS),
      );
      return parseLease(typeof result === 'string' ? result : null);
    },
    () => {
      const current = activeMemoryLease(roomId);
      if (!current || current.adminId !== adminId) return null;
      const lease = nextLease({
        roomId,
        adminId,
        adminName: current.adminName,
        takenAt: current.takenAt,
      });
      memoryLeases.set(roomId, lease);
      return lease;
    },
  );
}

export async function releaseAssistantLease(params: {
  roomId: string;
  adminId: string;
  force?: boolean;
}): Promise<boolean> {
  return withDevelopmentFallback(
    async () => {
      if (params.force) {
        return (await redis().del(leaseKey(params.roomId))) > 0;
      }
      const result = await redis().eval(
        `
          local raw = redis.call('get', KEYS[1])
          if not raw then return 0 end
          local value = cjson.decode(raw)
          if value.adminId ~= ARGV[1] then return 0 end
          return redis.call('del', KEYS[1])
        `,
        1,
        leaseKey(params.roomId),
        params.adminId,
      );
      return Number(result) > 0;
    },
    () => {
      const current = activeMemoryLease(params.roomId);
      if (!current) return false;
      if (!params.force && current.adminId !== params.adminId) return false;
      memoryLeases.delete(params.roomId);
      return true;
    },
  );
}
