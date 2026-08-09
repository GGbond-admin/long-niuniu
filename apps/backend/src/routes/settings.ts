import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { changePaymentPin, setPaymentPin } from '../services/paymentPin.js';

const pinSchema = z.object({
  pin: z.string().regex(/^\d{6}$/),
});

const changePinSchema = z.object({
  currentPin: z.string().regex(/^\d{6}$/),
  newPin: z.string().regex(/^\d{6}$/),
});

function maskedDeviceId(deviceId: string): string {
  return deviceId.length > 8 ? `•••• ${deviceId.slice(-8)}` : '•••• ••••';
}

export async function settingsRoutes(app: FastifyInstance) {
  app.get(
    '/api/settings/security',
    { preHandler: [app.authUser] },
    async (req) => {
      const userId = (req.user as { sub: string }).sub;
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          kyc: { select: { status: true } },
          paymentPin: {
            select: {
              isSet: true,
              lockedUntil: true,
              setAt: true,
              updatedAt: true,
            },
          },
          device: {
            select: {
              deviceId: true,
              status: true,
              boundAt: true,
            },
          },
        },
      });
      return {
        kycStatus: user.kyc?.status ?? 'NONE',
        paymentPin: {
          set: Boolean(user.paymentPin?.isSet),
          lockedUntil:
            user.paymentPin?.isSet &&
            user.paymentPin.lockedUntil &&
            user.paymentPin.lockedUntil > new Date()
              ? user.paymentPin.lockedUntil
              : null,
          setAt: user.paymentPin?.isSet ? user.paymentPin.setAt : null,
          updatedAt: user.paymentPin?.isSet ? user.paymentPin.updatedAt : null,
        },
        device: user.device
          ? {
              status: user.device.status,
              maskedId: maskedDeviceId(user.device.deviceId),
              boundAt: user.device.boundAt,
            }
          : null,
      };
    },
  );

  app.get(
    '/api/settings/device',
    { preHandler: [app.authUser] },
    async (req) => {
      const userId = (req.user as { sub: string }).sub;
      const device = await prisma.device.findUnique({
        where: { userId },
        select: {
          deviceId: true,
          status: true,
          boundAt: true,
        },
      });
      return {
        device: device
          ? {
              status: device.status,
              maskedId: maskedDeviceId(device.deviceId),
              boundAt: device.boundAt,
            }
          : null,
        policy: {
          oneAccountOneDevice: true,
          selfUnbindAllowed: false,
        },
      };
    },
  );

  app.post(
    '/api/settings/payment-pin',
    {
      preHandler: [app.authUser, app.requireKyc],
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    },
    async (req) => {
      const userId = (req.user as { sub: string }).sub;
      const { pin } = pinSchema.parse(req.body);
      await setPaymentPin(userId, pin);
      return { ok: true, paymentPinSet: true };
    },
  );

  app.patch(
    '/api/settings/payment-pin',
    {
      preHandler: [app.authUser, app.requireKyc],
      config: { rateLimit: { max: 8, timeWindow: '15 minutes' } },
    },
    async (req) => {
      const userId = (req.user as { sub: string }).sub;
      const body = changePinSchema.parse(req.body);
      await changePaymentPin(userId, body.currentPin, body.newPin);
      return { ok: true, paymentPinSet: true };
    },
  );
}
