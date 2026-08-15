import { createHash, timingSafeEqual } from 'node:crypto';
import type { VpayConfig } from './paymentProviders.js';

/**
 * VPay Trader 网关协议（https://gateway.vpay.club/api/doc/trader_en）
 *
 * 签名：非空参数按 ASCII 升序拼 key=value&… → MD5 转大写 → 拼
 * `token={api_token}&dt={dt}&ap={md5}` → Base64。dt 为 Query 上 `t`
 * 时间戳按商户本地时区格式化后的 "yyyy-MM-dd HH:mm:ss"。
 */

export type VpayResponse<T = Record<string, unknown>> = {
  code: number;
  msg: string;
  data?: T;
};

const REQUEST_TIMEOUT_MS = 20_000;

/** 把 Unix 秒按指定时区偏移格式化成 VPay 要求的 "yyyy-MM-dd HH:mm:ss"。 */
export function formatDt(unixSeconds: number, offsetMinutes: number): string {
  const shifted = new Date((unixSeconds + offsetMinutes * 60) * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    ` ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  );
}

/** 排序拼接待签名串：剔除 sign 与空值，参数名大小写敏感。 */
export function buildSignSource(params: Record<string, unknown>): string {
  return Object.keys(params)
    .filter((key) => key !== 'sign')
    .filter((key) => {
      const value = params[key];
      return value !== undefined && value !== null && String(value) !== '';
    })
    .sort()
    .map((key) => `${key}=${String(params[key])}`)
    .join('&');
}

export function md5Upper(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex').toUpperCase();
}

export function buildSign(
  params: Record<string, unknown>,
  options: { apiToken: string; unixSeconds: number; timezoneOffsetMinutes: number },
): string {
  const ap = md5Upper(buildSignSource(params));
  const dt = formatDt(options.unixSeconds, options.timezoneOffsetMinutes);
  return Buffer.from(`token=${options.apiToken}&dt=${dt}&ap=${ap}`, 'utf8').toString('base64');
}

/**
 * 反解平台下发的 sign。回调 URL 不允许带查询参数，因此无从得知平台用了哪个
 * 时间戳；直接从签名里取出 dt 与 ap 再比对，避免依赖本地时区推测。
 */
export function parseSign(sign: string): { token: string; dt: string; ap: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(sign, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const matched = /^token=(.*)&dt=([^&]*)&ap=([0-9A-Fa-f]{32})$/.exec(decoded);
  if (!matched) return null;
  return { token: matched[1], dt: matched[2], ap: matched[3].toUpperCase() };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 校验平台回调签名：密钥一致且参数摘要吻合。 */
export function verifyNotifySign(
  params: Record<string, unknown>,
  sign: string,
  apiToken: string,
): boolean {
  if (!sign || !apiToken) return false;
  const parsed = parseSign(sign);
  if (!parsed) return false;
  if (!safeEqual(parsed.token, apiToken)) return false;
  return safeEqual(parsed.ap, md5Upper(buildSignSource(params)));
}

/** 分 → VPay 金额字符串（RM，两位小数）。 */
export function centsToAmount(cents: bigint): string {
  const negative = cents < 0n;
  const value = negative ? -cents : cents;
  return `${negative ? '-' : ''}${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}

/** VPay 金额字符串 → 分；非法格式返回 null。 */
export function amountToCents(amount: unknown): bigint | null {
  const text = String(amount ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [integer, decimal = ''] = text.split('.');
  return BigInt(integer) * 100n + BigInt((decimal + '00').slice(0, 2));
}

export class VpayError extends Error {
  constructor(
    message: string,
    readonly code: number | string,
  ) {
    super(message);
    this.name = 'VpayError';
  }
}

async function callVpay<T>(
  config: VpayConfig,
  payload: Record<string, unknown>,
): Promise<VpayResponse<T>> {
  if (!config.baseUrl || !config.traderId || !config.apiToken) {
    throw new VpayError('VPAY_NOT_CONFIGURED', 'CONFIG');
  }
  const unixSeconds = Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    trader_id: config.traderId,
    sign: buildSign(
      { ...payload, trader_id: config.traderId },
      {
        apiToken: config.apiToken,
        unixSeconds,
        timezoneOffsetMinutes: config.timezoneOffsetMinutes,
      },
    ),
  };

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/app/v1/trader/rest?t=${unixSeconds}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new VpayError(`VPAY_UNREACHABLE: ${(error as Error).message}`, 'NETWORK');
  }
  if (!response.ok) {
    throw new VpayError(`VPAY_HTTP_${response.status}`, response.status);
  }
  const parsed = (await response.json().catch(() => null)) as VpayResponse<T> | null;
  if (!parsed || typeof parsed.code !== 'number') {
    throw new VpayError('VPAY_INVALID_RESPONSE', 'PARSE');
  }
  return parsed;
}

export type VpayOrderResult = {
  trade_no?: string;
  out_trade_no?: string;
  amount?: string;
  pay_url?: string;
  expired_time?: string;
  acc_name?: string;
  acc_no?: string;
  bank_name?: string;
  open_bank_name?: string;
};

export async function createVpayOrder(
  config: VpayConfig,
  input: {
    outTradeNo: string;
    title: string;
    amountCents: bigint;
    tradeCode: string;
    notifyUrl: string;
    callbackUrl: string;
    payerName?: string;
  },
): Promise<VpayResponse<VpayOrderResult>> {
  return callVpay<VpayOrderResult>(config, {
    action: 'TRADER_ORDER',
    out_trade_no: input.outTradeNo,
    title: input.title,
    amount: centsToAmount(input.amountCents),
    trade_code: input.tradeCode,
    notify_url: input.notifyUrl,
    callback_url: input.callbackUrl,
    ...(input.payerName ? { payer_name: input.payerName } : {}),
  });
}

export type VpayQueryResult = {
  trade_no?: string;
  out_trade_no?: string;
  state?: string | number;
  amount?: string;
  notify_state?: string | number;
  expired_time?: string;
  pay_url?: string;
};

export async function queryVpayOrder(
  config: VpayConfig,
  outTradeNo: string,
): Promise<VpayResponse<VpayQueryResult>> {
  return callVpay<VpayQueryResult>(config, {
    action: 'ORDER_GET',
    out_trade_no: outTradeNo,
  });
}

export type VpayBalanceResult = {
  trader_balance?: string;
  trader_real_balance?: string;
  freeze_balance?: string;
};

export async function queryVpayBalance(
  config: VpayConfig,
): Promise<VpayResponse<VpayBalanceResult>> {
  return callVpay<VpayBalanceResult>(config, { action: 'TRADER_BALANCE' });
}

/** 0=未生成 1=失败 2=待支付 3=已支付 4=已冲正 5=风控中 */
export type VpayOrderState = 0 | 1 | 2 | 3 | 4 | 5;

export function mapOrderState(state: unknown): 'PENDING' | 'COMPLETED' | 'REJECTED' | 'UNKNOWN' {
  const value = Number(state);
  if (value === 3) return 'COMPLETED';
  if (value === 1 || value === 4) return 'REJECTED';
  if (value === 0 || value === 2 || value === 5) return 'PENDING';
  return 'UNKNOWN';
}

export function describeOrderState(state: unknown): string {
  const labels: Record<number, string> = {
    0: '未生成',
    1: '支付失败',
    2: '待支付',
    3: '已支付',
    4: '已冲正',
    5: '风控审核中',
  };
  return labels[Number(state)] ?? `未知状态(${String(state)})`;
}
