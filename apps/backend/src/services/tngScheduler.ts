import { prisma } from '../lib/prisma.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';

export const TNG_SCHEDULER_PROVIDER = 'TNG_SCHEDULER';

export type TngSchedulerConfig = {
  enabled: boolean;
  baseUrl: string;
  keyId: string;
  /** 明文密钥，仅服务端签名使用，不得经 API 返回 */
  secret: string;
};

const DEFAULTS: TngSchedulerConfig = {
  enabled: false,
  baseUrl: '',
  keyId: '',
  secret: '',
};

const CACHE_TTL_MS = 10_000;
let cache: { value: TngSchedulerConfig; expiresAt: number } | null = null;

export function clearTngSchedulerConfigCache(): void {
  cache = null;
}

export async function getTngSchedulerConfig(): Promise<TngSchedulerConfig> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  const row = await prisma.paymentProviderConfig.findUnique({
    where: { provider: TNG_SCHEDULER_PROVIDER },
  });
  const value: TngSchedulerConfig = row
    ? {
        enabled: row.enabled,
        baseUrl: row.baseUrl.trim().replace(/\/+$/, ''),
        keyId: row.traderId.trim(),
        secret: row.apiToken ? decryptSecret(row.apiToken) : '',
      }
    : DEFAULTS;
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export type TngSchedulerConfigPatch = {
  enabled?: boolean;
  baseUrl?: string;
  keyId?: string;
  /** 省略表示保留原密钥；空串表示清除 */
  secret?: string;
};

export async function saveTngSchedulerConfig(
  patch: TngSchedulerConfigPatch,
  adminId?: string,
): Promise<TngSchedulerConfig> {
  const current = await getTngSchedulerConfig();
  const data = {
    enabled: patch.enabled ?? current.enabled,
    baseUrl: (patch.baseUrl ?? current.baseUrl).trim().replace(/\/+$/, ''),
    traderId: (patch.keyId ?? current.keyId).trim(),
    updatedBy: adminId,
  };
  const nextSecret = patch.secret === undefined ? current.secret : patch.secret.trim();
  const apiToken = nextSecret ? encryptSecret(nextSecret) : '';

  await prisma.paymentProviderConfig.upsert({
    where: { provider: TNG_SCHEDULER_PROVIDER },
    create: { provider: TNG_SCHEDULER_PROVIDER, ...data, apiToken },
    update: { ...data, apiToken },
  });
  clearTngSchedulerConfigCache();
  return getTngSchedulerConfig();
}

export function isTngSchedulerReady(config: TngSchedulerConfig): boolean {
  return (
    config.enabled &&
    /^https?:\/\//i.test(config.baseUrl) &&
    config.keyId.length > 0 &&
    config.secret.length >= 32
  );
}
