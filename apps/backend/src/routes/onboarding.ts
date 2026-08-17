import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { blindIndex, encryptSecret, kycSearchHashes, normalizeIdentity } from '../lib/crypto.js';
import { serializable } from '../lib/transaction.js';
import { autoBindReferralPlayer } from '../services/profitPool.js';

const bindInviterSchema = z.object({ inviterUid: z.string().regex(/^\d{6,20}$/) });
// 上限与登录接口的 deviceId 校验保持一致（256），避免同一标识登录能过、绑定被拒
const bindDeviceSchema = z.object({ deviceId: z.string().min(8).max(256) });
/** 实名只收姓名 + DuitNow；银行卡改由提现账户独立添加。 */
const kycSchema = z.object({
  realName: z.string().min(2).max(64),
  duitnowId: z.string().min(4).max(64),
  agreed: z.literal(true),
});

export async function onboardingRoutes(app: FastifyInstance) {
  /** 邀请人预览（绑定前确认头像/昵称） */
  app.get('/api/onboarding/inviter/:uid', { preHandler: [app.authUser] }, async (req, reply) => {
    const { uid } = req.params as { uid: string };
    const inviter = await prisma.user.findUnique({
      where: { uid },
      select: { uid: true, nickname: true, avatarUrl: true },
    });
    if (!inviter) return reply.code(404).send({ error: 'INVITER_NOT_FOUND' });
    return { inviter };
  });

  /** 绑定邀请人（不可更换；不可绑定自己；两级冗余；同邀请人重复提交幂等） */
  app.post('/api/onboarding/inviter', { preHandler: [app.authUser] }, async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const { inviterUid } = bindInviterSchema.parse(req.body);

    const result = await serializable(async (tx) => {
      const me = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        include: { inviter: { select: { uid: true, nickname: true } } },
      });
      if (me.inviterId) {
        // 已绑定同一邀请人 → 幂等成功（防双点/重试）；绑定了别人 → 冲突
        if (me.inviter?.uid === inviterUid) {
          return { inviter: me.inviter, alreadyBound: true as const };
        }
        return { error: 'ALREADY_BOUND' as const };
      }
      const inviter = await tx.user.findUnique({ where: { uid: inviterUid } });
      if (!inviter || inviter.status !== 'ACTIVE') {
        return { error: 'INVITER_NOT_FOUND' as const };
      }
      if (inviter.id === userId) return { error: 'CANNOT_BIND_SELF' as const };

      let ancestorId: string | null = inviter.id;
      for (let depth = 0; ancestorId && depth < 100; depth += 1) {
        if (ancestorId === userId) return { error: 'CIRCULAR_REFERRAL' as const };
        const ancestor: { inviterId: string | null } | null = await tx.user.findUnique({
          where: { id: ancestorId },
          select: { inviterId: true },
        });
        ancestorId = ancestor?.inviterId ?? null;
      }
      if (ancestorId) return { error: 'REFERRAL_DEPTH_EXCEEDED' as const };

      const updated = await tx.user.updateMany({
        where: { id: userId, inviterId: null },
        data: {
          inviterId: inviter.id,
          grandInviterId: inviter.inviterId,
          inviterBoundAt: new Date(),
        },
      });
      if (updated.count !== 1) {
        const current = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          include: { inviter: { select: { uid: true, nickname: true } } },
        });
        if (current.inviter?.uid === inviterUid) {
          return { inviter: current.inviter, alreadyBound: true as const };
        }
        return { error: 'ALREADY_BOUND' as const };
      }
      await tx.user.updateMany({
        where: { inviterId: userId, grandInviterId: null },
        data: { grandInviterId: inviter.id },
      });
      // 称桶代理体系：沿邀请链向上找最近的启用代理，自动把新玩家归属其名下（失败不阻断注册）
      try {
        await autoBindReferralPlayer(tx, userId, inviter.id);
      } catch (referralBindError) {
        req.log?.warn?.({ err: referralBindError }, 'auto bind referral agent failed');
      }
      return { inviter: { uid: inviter.uid, nickname: inviter.nickname }, alreadyBound: false as const };
    });
    if ('error' in result) {
      const status = result.error === 'INVITER_NOT_FOUND' ? 404 : result.error === 'ALREADY_BOUND' ? 409 : 400;
      return reply.code(status).send({ error: result.error });
    }
    return { ok: true, inviter: result.inviter, alreadyBound: result.alreadyBound };
  });

  /** 绑定本设备（一账号一设备；换设备走后台解绑） */
  app.post('/api/onboarding/device', { preHandler: [app.authUser] }, async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const { deviceId } = bindDeviceSchema.parse(req.body);

    const result = await serializable(async (tx) => {
      const existing = await tx.device.upsert({
        where: { userId },
        create: { userId, deviceId },
        update: {},
      });
      if (existing.status === 'ACTIVE') {
        return existing.deviceId === deviceId
          ? { ok: true as const, alreadyBound: true }
          : { ok: false as const };
      }
      const updated = await tx.device.updateMany({
        where: { id: existing.id, status: 'UNBOUND' },
        data: { deviceId, status: 'ACTIVE', boundAt: new Date() },
      });
      if (updated.count === 1) return { ok: true as const, alreadyBound: false };
      const current = await tx.device.findUniqueOrThrow({ where: { id: existing.id } });
      return current.status === 'ACTIVE' && current.deviceId === deviceId
        ? { ok: true as const, alreadyBound: true }
        : { ok: false as const };
    });
    if (!result.ok) {
      return reply.code(409).send({
        error: 'DEVICE_MISMATCH',
        message: '该账号已绑定其他设备，请联系客服更换',
      });
    }
    return result;
  });

  /** 提交实名认证（姓名 + DuitNow；银行卡请走提现账户） */
  app.post('/api/onboarding/kyc', { preHandler: [app.authUser] }, async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const body = kycSchema.parse(req.body);

    const existing = await prisma.kyc.findUnique({ where: { userId } });
    if (existing && existing.status === 'APPROVED') return reply.code(409).send({ error: 'ALREADY_APPROVED' });
    if (existing && existing.status === 'PENDING') return reply.code(409).send({ error: 'ALREADY_PENDING' });

    const hashes = kycSearchHashes({
      duitnowId: body.duitnowId,
      bankAccount: '',
    });
    const normalizedName = normalizeIdentity(body.realName);
    const data = {
      realName: encryptSecret(normalizedName),
      realNameHash: blindIndex(body.realName),
      duitnowId: encryptSecret(body.duitnowId.trim()),
      duitnowHash: hashes.duitnowHash,
      // 兼容旧列：银行卡改由 WithdrawAccount 管理，KYC 不再要求填写。
      bankName: '',
      bankAccount: encryptSecret(''),
      bankAccountHash: hashes.bankAccountHash,
      bankAccountLast4Hash: hashes.bankAccountLast4Hash,
      accountHolder: encryptSecret(normalizedName),
      status: 'PENDING' as const,
      rejectReason: null,
      submittedAt: new Date(),
    };

    await prisma.kyc.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });

    // 推送「实名已提交」（Bot 私聊，尽力而为）
    app.pushService?.notifyKycSubmitted(userId).catch(() => {});
    return { ok: true, status: 'PENDING' };
  });
}
