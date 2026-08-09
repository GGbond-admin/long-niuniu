import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TelegramInitUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
}

export interface VerifiedInitData {
  user: TelegramInitUser;
  authDate: number;
  startParam?: string;
  raw: URLSearchParams;
}

/**
 * 校验 Telegram Mini App initData 签名。
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function verifyInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 24 * 3600,
): VerifiedInitData | null {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const suppliedBuffer = Buffer.from(hash, 'hex');
  if (
    expectedBuffer.length !== suppliedBuffer.length ||
    !timingSafeEqual(expectedBuffer, suppliedBuffer)
  ) {
    return null;
  }

  const authDate = parseInt(params.get('auth_date') ?? '0', 10);
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (!Number.isFinite(authDate) || authDate <= 0 || ageSeconds < -30) return null;
  if (maxAgeSeconds > 0 && ageSeconds > maxAgeSeconds) return null;

  const userJson = params.get('user');
  if (!userJson) return null;
  let user: TelegramInitUser;
  try {
    user = JSON.parse(userJson);
  } catch {
    return null;
  }

  return {
    user,
    authDate,
    startParam: params.get('start_param') ?? undefined,
    raw: params,
  };
}

/** 从 start 参数解析邀请人 UID：ref_960867156 → 960867156 */
export function parseRefParam(startParam?: string | null): string | null {
  if (!startParam) return null;
  const m = /^ref_(\d{6,20})$/.exec(startParam.trim());
  return m ? m[1] : null;
}
