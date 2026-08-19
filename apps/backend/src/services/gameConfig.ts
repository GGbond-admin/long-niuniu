import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

const cache = new Map<string, { value: unknown; expiresAt: number }>();
const TTL_MS = 10_000;
export const PLATFORM_CONFIG_SCOPE = 'PLATFORM';

function scopedCacheKey(gameCode: string, key: string): string {
  return `${gameCode}:${key}`;
}

export function deepMerge<T>(base: T, override: unknown): T {
  if (
    !base ||
    typeof base !== 'object' ||
    Array.isArray(base) ||
    !override ||
    typeof override !== 'object' ||
    Array.isArray(override)
  ) {
    return (override === undefined ? base : override) as T;
  }
  const result = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    result[key] = key in result ? deepMerge(result[key], value) : value;
  }
  return result as T;
}

/** 读取指定游戏配置（带默认值与短缓存，后台改后 10s 内生效） */
export async function getGameConfig<T>(
  gameCode: string,
  key: string,
  defaultValue: T,
): Promise<T> {
  const cacheKey = scopedCacheKey(gameCode, key);
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const row = await prisma.gameConfig.findUnique({
    where: { gameCode_key: { gameCode, key } },
  });
  const value = row ? deepMerge(defaultValue, row.value) : defaultValue;
  cache.set(cacheKey, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

export async function setGameConfig(
  gameCode: string,
  key: string,
  value: unknown,
  updatedBy?: string,
): Promise<void> {
  await prisma.gameConfig.upsert({
    where: { gameCode_key: { gameCode, key } },
    create: { gameCode, key, value: value as object, updatedBy },
    update: { value: value as object, updatedBy },
  });
  cache.delete(scopedCacheKey(gameCode, key));
}

/** 结构性配置变更在同一数据库事务内读取，绕过进程缓存以参与串行化校验。 */
export async function getGameConfigInTransaction<T>(
  tx: Prisma.TransactionClient,
  gameCode: string,
  key: string,
  defaultValue: T,
): Promise<T> {
  const row = await tx.gameConfig.findUnique({
    where: { gameCode_key: { gameCode, key } },
  });
  return row ? deepMerge(defaultValue, row.value) : defaultValue;
}

export async function setGameConfigInTransaction(
  tx: Prisma.TransactionClient,
  gameCode: string,
  key: string,
  value: unknown,
  updatedBy?: string,
): Promise<void> {
  await tx.gameConfig.upsert({
    where: { gameCode_key: { gameCode, key } },
    create: { gameCode, key, value: value as object, updatedBy },
    update: { value: value as object, updatedBy },
  });
  cache.delete(scopedCacheKey(gameCode, key));
}
