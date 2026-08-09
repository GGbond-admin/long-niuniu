import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { env } from '../config.js';

const PREFIX = 'enc:v1:';
const key = createHash('sha256').update(env.sensitiveDataKey).digest();

/**
 * Encrypts credentials and personal identifiers at rest with AES-256-GCM.
 * Existing unencrypted development rows are accepted by decryptSecret so
 * installations can migrate without downtime.
 */
export function encryptSecret(value: string): string {
  if (!value || value.startsWith(PREFIX)) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptSecret(value: string): string {
  if (!value.startsWith(PREFIX)) return value;
  const [ivRaw, tagRaw, ciphertextRaw] = value.slice(PREFIX.length).split('.');
  if (!ivRaw || !tagRaw || !ciphertextRaw) throw new Error('INVALID_ENCRYPTED_VALUE');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** 对已解密明文做脱敏（不要传入密文）。 */
export function maskPlaintext(plain: string, visible = 4): string {
  if (plain.length <= visible) return '*'.repeat(plain.length);
  return `${'*'.repeat(Math.max(4, plain.length - visible))}${plain.slice(-visible)}`;
}

export function maskSecret(value: string, visible = 4): string {
  return maskPlaintext(decryptSecret(value), visible);
}

/** 密钥轮换或数据损坏时的占位符，避免单行坏数据让整个列表接口 500。 */
export const UNREADABLE_SECRET = '⚠ 无法解密';

/** 展示用解密：失败返回占位符而非抛错。安全校验路径请继续用 decryptSecret。 */
export function safeDecryptSecret(
  value: string | null | undefined,
  fallback: string = UNREADABLE_SECRET,
): string {
  if (value === null || value === undefined || value === '') return '';
  try {
    return decryptSecret(value);
  } catch {
    return fallback;
  }
}

/** 展示用脱敏：失败返回占位符而非抛错。 */
export function safeMaskSecret(
  value: string | null | undefined,
  visible = 4,
  fallback: string = UNREADABLE_SECRET,
): string {
  if (value === null || value === undefined || value === '') return '';
  try {
    return maskSecret(value, visible);
  } catch {
    return fallback;
  }
}

export function normalizeIdentity(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleUpperCase('en-MY');
}

/** Deterministic keyed index for exact-match searches without storing plaintext. */
export function blindIndex(value: string): string {
  return createHmac('sha256', key).update(normalizeIdentity(value)).digest('hex');
}

/** KYC 字段盲索引：完整 DuitNow / 银行账号，以及账号后四位（客服按尾号查）。 */
export function kycSearchHashes(input: {
  duitnowId: string;
  bankAccount: string;
}): {
  duitnowHash: string;
  bankAccountHash: string;
  bankAccountLast4Hash: string | null;
} {
  const account = input.bankAccount.replace(/\s+/g, '');
  const last4 = account.slice(-4);
  return {
    duitnowHash: blindIndex(input.duitnowId.trim()),
    bankAccountHash: blindIndex(account),
    bankAccountLast4Hash: /^\d{4}$/.test(last4) ? blindIndex(last4) : null,
  };
}
