import { prisma } from '../lib/prisma.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { env } from '../config.js';

export const VPAY_PROVIDER = 'VPAY';

/** VPay 文档给出的通道代码；后台从中勾选商户实际已开通的项。 */
export const VPAY_TRADE_CODE_CATALOG: Array<{ code: string; label: string }> = [
  { code: '1', label: 'P2P 网银转账' },
  { code: '2', label: 'DuitNow' },
  { code: '3', label: 'TNG PIN' },
  { code: '4', label: 'Telco PIN' },
  { code: '5', label: "Touch 'n Go" },
  { code: '7', label: '动态 DuitNow' },
];

export type VpayTradeCode = { code: string; label: string; enabled: boolean };

export type VpayConfig = {
  enabled: boolean;
  baseUrl: string;
  traderId: string;
  /** 明文密钥，仅服务端签名使用，不得出经 API 返回 */
  apiToken: string;
  tradeCodes: VpayTradeCode[];
  notifyIps: string[];
  timezoneOffsetMinutes: number;
  notifyUrl: string;
  callbackUrl: string;
  orderTitle: string;
  minAmountCents: bigint;
  maxAmountCents: bigint;
};

const DEFAULTS: VpayConfig = {
  enabled: false,
  baseUrl: '',
  traderId: '',
  apiToken: '',
  tradeCodes: VPAY_TRADE_CODE_CATALOG.map((item) => ({ ...item, enabled: false })),
  notifyIps: [],
  timezoneOffsetMinutes: 480,
  notifyUrl: '',
  callbackUrl: '',
  orderTitle: 'Deposit',
  minAmountCents: 10_000n,
  maxAmountCents: 0n,
};

const CACHE_TTL_MS = 10_000;
let cache: { value: VpayConfig; expiresAt: number } | null = null;

function normalizeTradeCodes(value: unknown): VpayTradeCode[] {
  const saved = new Map<string, VpayTradeCode>();
  if (Array.isArray(value)) {
    for (const raw of value) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Record<string, unknown>;
      const code = String(row.code ?? '').trim();
      if (!code) continue;
      saved.set(code, {
        code,
        label: String(row.label ?? code),
        enabled: row.enabled === true,
      });
    }
  }
  // 以官方目录为准补齐，避免后台漏配后前端拿不到标签
  return VPAY_TRADE_CODE_CATALOG.map((item) => ({
    code: item.code,
    label: saved.get(item.code)?.label ?? item.label,
    enabled: saved.get(item.code)?.enabled ?? false,
  }));
}

function normalizeIps(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 50);
}

export function clearVpayConfigCache(): void {
  cache = null;
}

export async function getVpayConfig(): Promise<VpayConfig> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  const row = await prisma.paymentProviderConfig.findUnique({
    where: { provider: VPAY_PROVIDER },
  });
  const value: VpayConfig = row
    ? {
        enabled: row.enabled,
        baseUrl: row.baseUrl.trim().replace(/\/+$/, ''),
        traderId: row.traderId.trim(),
        apiToken: row.apiToken ? decryptSecret(row.apiToken) : '',
        tradeCodes: normalizeTradeCodes(row.tradeCodes),
        notifyIps: normalizeIps(row.notifyIps),
        timezoneOffsetMinutes: row.timezoneOffsetMinutes,
        notifyUrl: row.notifyUrl.trim(),
        callbackUrl: row.callbackUrl.trim(),
        orderTitle: row.orderTitle.trim() || 'Deposit',
        minAmountCents: row.minAmountCents,
        maxAmountCents: row.maxAmountCents,
      }
    : DEFAULTS;
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export type VpayConfigPatch = {
  enabled?: boolean;
  baseUrl?: string;
  traderId?: string;
  /** 省略表示保留原密钥；空串表示清除 */
  apiToken?: string;
  tradeCodes?: Array<{ code: string; enabled: boolean }>;
  notifyIps?: string[];
  timezoneOffsetMinutes?: number;
  notifyUrl?: string;
  callbackUrl?: string;
  orderTitle?: string;
  minAmountCents?: bigint;
  maxAmountCents?: bigint;
};

export async function saveVpayConfig(patch: VpayConfigPatch, adminId?: string): Promise<VpayConfig> {
  const current = await getVpayConfig();
  const tradeCodes = patch.tradeCodes
    ? normalizeTradeCodes(
        VPAY_TRADE_CODE_CATALOG.map((item) => ({
          code: item.code,
          label: item.label,
          enabled: patch.tradeCodes?.some((row) => row.code === item.code && row.enabled) ?? false,
        })),
      )
    : current.tradeCodes;

  const data = {
    enabled: patch.enabled ?? current.enabled,
    baseUrl: (patch.baseUrl ?? current.baseUrl).trim().replace(/\/+$/, ''),
    traderId: (patch.traderId ?? current.traderId).trim(),
    tradeCodes: tradeCodes as unknown as object,
    notifyIps: normalizeIps(patch.notifyIps ?? current.notifyIps) as unknown as object,
    timezoneOffsetMinutes: patch.timezoneOffsetMinutes ?? current.timezoneOffsetMinutes,
    notifyUrl: (patch.notifyUrl ?? current.notifyUrl).trim(),
    callbackUrl: (patch.callbackUrl ?? current.callbackUrl).trim(),
    orderTitle: (patch.orderTitle ?? current.orderTitle).trim() || 'Deposit',
    minAmountCents: patch.minAmountCents ?? current.minAmountCents,
    maxAmountCents: patch.maxAmountCents ?? current.maxAmountCents,
    updatedBy: adminId,
  };
  const nextToken = patch.apiToken === undefined ? current.apiToken : patch.apiToken.trim();
  const apiToken = nextToken ? encryptSecret(nextToken) : '';

  await prisma.paymentProviderConfig.upsert({
    where: { provider: VPAY_PROVIDER },
    create: { provider: VPAY_PROVIDER, ...data, apiToken },
    update: { ...data, apiToken },
  });
  clearVpayConfigCache();
  return getVpayConfig();
}

/** 回调地址必须是可直连、且不带查询参数的 URL（VPay 文档硬性要求）。 */
export function resolveNotifyUrl(config: VpayConfig): string {
  return config.notifyUrl || `${env.publicApiUrl.replace(/\/+$/, '')}/api/payments/vpay/notify`;
}

export function resolveCallbackUrl(config: VpayConfig): string {
  return config.callbackUrl || `${env.miniappUrl.replace(/\/+$/, '')}/wallet/orders`;
}

export function enabledTradeCodes(config: VpayConfig): VpayTradeCode[] {
  return config.tradeCodes.filter((item) => item.enabled);
}

/** 商户资料填全且至少开通一个通道时，玩家端才会看到 VPay 入口。 */
export function isVpayReady(config: VpayConfig): boolean {
  return (
    config.enabled &&
    config.baseUrl.startsWith('http') &&
    config.traderId.length > 0 &&
    config.apiToken.length > 0 &&
    enabledTradeCodes(config).length > 0
  );
}
