import { createHmac } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { compare, hash } from 'bcryptjs';
import { env } from '../config.js';
import { prisma } from '../lib/prisma.js';

export const PAYMENT_PIN_LENGTH = 6;
export const PAYMENT_PIN_MAX_FAILURES = 5;
export const PAYMENT_PIN_LOCK_MS = 15 * 60 * 1_000;
const PAYMENT_PIN_BCRYPT_ROUNDS = 12;

const COMMON_WEAK_PINS = new Set([
  '012345',
  '123456',
  '234567',
  '345678',
  '456789',
  '987654',
  '876543',
  '765432',
  '654321',
  '543210',
  '112233',
  '121212',
  '123123',
  '520520',
]);

export class PaymentPinError extends Error {
  constructor(
    public code: string,
    public details?: Record<string, unknown>,
  ) {
    super(code);
  }
}

function paymentPinMaterial(userId: string, pin: string): string {
  return createHmac('sha256', env.sensitiveDataKey)
    .update(`payment-pin:v1:${userId}:${pin}`)
    .digest('hex');
}

export function isWeakPaymentPin(pin: string): boolean {
  if (!new RegExp(`^\\d{${PAYMENT_PIN_LENGTH}}$`).test(pin)) return true;
  if (/^(\d)\1{5}$/.test(pin)) return true;
  return COMMON_WEAK_PINS.has(pin);
}

function assertStrongPaymentPin(pin: string): void {
  if (!/^\d{6}$/.test(pin)) {
    throw new PaymentPinError('PAYMENT_PIN_FORMAT');
  }
  if (isWeakPaymentPin(pin)) {
    throw new PaymentPinError('PAYMENT_PIN_TOO_WEAK');
  }
}

export async function hashPaymentPin(userId: string, pin: string): Promise<string> {
  return hash(paymentPinMaterial(userId, pin), PAYMENT_PIN_BCRYPT_ROUNDS);
}

export async function setPaymentPin(userId: string, pin: string): Promise<void> {
  assertStrongPaymentPin(pin);
  const hashValue = await hashPaymentPin(userId, pin);
  try {
    const created = await paymentPinTransaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "user_id"
        FROM "payment_pins"
        WHERE "user_id" = ${userId}
        FOR UPDATE
      `;
      const existing = await tx.paymentPin.findUnique({ where: { userId } });
      if (existing?.isSet) return false;
      if (existing) {
        await tx.paymentPin.update({
          where: { userId },
          data: {
            hash: hashValue,
            isSet: true,
            failedAttempts: 0,
            lockedUntil: null,
            version: { increment: 1 },
            setAt: new Date(),
          },
        });
      } else {
        await tx.paymentPin.create({
          data: {
            userId,
            hash: hashValue,
            isSet: true,
            failedAttempts: 0,
            lockedUntil: null,
          },
        });
      }
      return true;
    });
    if (!created) throw new PaymentPinError('PAYMENT_PIN_ALREADY_SET');
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      throw new PaymentPinError('PAYMENT_PIN_ALREADY_SET');
    }
    throw error;
  }
}

type PaymentPinCredential = {
  hash: string;
  version: number;
  failedAttempts: number;
  lockedUntil: Date | null;
};

type PaymentPinVerification =
  | { ok: true; credential: PaymentPinCredential }
  | {
      ok: false;
      code:
        | 'PAYMENT_PIN_REQUIRED'
        | 'PAYMENT_PIN_INVALID'
        | 'PAYMENT_PIN_LOCKED'
        | 'PAYMENT_PIN_UNCHANGED';
      lockedUntil?: Date;
      remainingAttempts?: number;
    };

function paymentPinTransaction<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(work, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  });
}

/**
 * PostgreSQL 的行锁会把同一账号的验密、改密和后台重置串行化。
 * bcrypt 必须在锁内完成，否则较慢的旧密码校验可能在锁定或改密后仍然放行。
 */
async function verifyPaymentPinLocked(
  tx: Prisma.TransactionClient,
  userId: string,
  pin: string,
): Promise<PaymentPinVerification> {
  await tx.$queryRaw`
    SELECT "user_id"
    FROM "payment_pins"
    WHERE "user_id" = ${userId}
    FOR UPDATE
  `;
  const credential = await tx.paymentPin.findUnique({ where: { userId } });
  if (!credential?.isSet) return { ok: false, code: 'PAYMENT_PIN_REQUIRED' };

  const now = new Date();
  if (credential.lockedUntil && credential.lockedUntil > now) {
    return {
      ok: false,
      code: 'PAYMENT_PIN_LOCKED',
      lockedUntil: credential.lockedUntil,
    };
  }

  const valid = await compare(paymentPinMaterial(userId, pin), credential.hash);
  if (valid) {
    if (credential.failedAttempts > 0 || credential.lockedUntil) {
      await tx.paymentPin.update({
        where: { userId },
        data: { failedAttempts: 0, lockedUntil: null },
      });
    }
    return {
      ok: true,
      credential: {
        hash: credential.hash,
        version: credential.version,
        failedAttempts: 0,
        lockedUntil: null,
      },
    };
  }

  const previousFailures =
    credential.lockedUntil && credential.lockedUntil <= now ? 0 : credential.failedAttempts;
  const failedAttempts = previousFailures + 1;
  const lockedUntil =
    failedAttempts >= PAYMENT_PIN_MAX_FAILURES
      ? new Date(now.getTime() + PAYMENT_PIN_LOCK_MS)
      : null;
  await tx.paymentPin.update({
    where: { userId },
    data: { failedAttempts, lockedUntil },
  });
  return lockedUntil
    ? {
        ok: false,
        code: 'PAYMENT_PIN_LOCKED',
        lockedUntil,
      }
    : {
        ok: false,
        code: 'PAYMENT_PIN_INVALID',
        remainingAttempts: PAYMENT_PIN_MAX_FAILURES - failedAttempts,
      };
}

function throwPaymentPinFailure(result: Exclude<PaymentPinVerification, { ok: true }>): never {
  if (result.code === 'PAYMENT_PIN_LOCKED') {
    throw new PaymentPinError(result.code, {
      lockedUntil: result.lockedUntil?.toISOString(),
    });
  }
  if (result.code === 'PAYMENT_PIN_INVALID') {
    throw new PaymentPinError(result.code, {
      remainingAttempts: result.remainingAttempts,
    });
  }
  throw new PaymentPinError(result.code);
}

/**
 * 返回本次成功校验的凭证版本。资金事务必须再次确认该版本，避免验密后改密/重置的竞态。
 */
export async function verifyPaymentPin(userId: string, pin: string): Promise<number> {
  if (!/^\d{6}$/.test(pin)) throw new PaymentPinError('PAYMENT_PIN_INVALID');
  const result = await paymentPinTransaction((tx) =>
    verifyPaymentPinLocked(tx, userId, pin),
  );
  if (!result.ok) throwPaymentPinFailure(result);
  return result.credential.version;
}

export async function assertPaymentPinVersion(
  tx: Prisma.TransactionClient,
  userId: string,
  expectedVersion: number,
): Promise<void> {
  await tx.$queryRaw`
    SELECT "user_id"
    FROM "payment_pins"
    WHERE "user_id" = ${userId}
    FOR UPDATE
  `;
  const current = await tx.paymentPin.findUnique({
    where: { userId },
    select: { isSet: true, version: true, lockedUntil: true },
  });
  if (!current?.isSet || current.version !== expectedVersion) {
    throw new PaymentPinError('PAYMENT_PIN_CHANGED');
  }
  if (current.lockedUntil && current.lockedUntil > new Date()) {
    throw new PaymentPinError('PAYMENT_PIN_LOCKED', {
      lockedUntil: current.lockedUntil.toISOString(),
    });
  }
}

export async function changePaymentPin(
  userId: string,
  currentPin: string,
  newPin: string,
): Promise<void> {
  assertStrongPaymentPin(newPin);
  if (!/^\d{6}$/.test(currentPin)) throw new PaymentPinError('PAYMENT_PIN_INVALID');
  const nextHash = await hashPaymentPin(userId, newPin);
  const result = await paymentPinTransaction(async (tx) => {
    const verification = await verifyPaymentPinLocked(tx, userId, currentPin);
    if (!verification.ok) return verification;
    const unchanged = await compare(
      paymentPinMaterial(userId, newPin),
      verification.credential.hash,
    );
    if (unchanged) {
      return { ok: false as const, code: 'PAYMENT_PIN_UNCHANGED' as const };
    }
    await tx.paymentPin.update({
      where: { userId },
      data: {
        hash: nextHash,
        failedAttempts: 0,
        lockedUntil: null,
        version: { increment: 1 },
        setAt: new Date(),
      },
    });
    return {
      ok: true as const,
      credential: {
        ...verification.credential,
        hash: nextHash,
        version: verification.credential.version + 1,
      },
    };
  });
  if (!result.ok) throwPaymentPinFailure(result);
}
