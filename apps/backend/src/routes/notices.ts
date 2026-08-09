/**
 * 系统通知：小程序收件箱 + 运营后台自定义发送
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';

function asUidList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).filter(Boolean);
}

async function noticesVisibleToUser(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { kyc: { select: { status: true } } },
  });
  const published = await prisma.systemNotice.findMany({
    where: { status: 'PUBLISHED' },
    orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
    take: 100,
  });
  return published.filter((notice) => {
    if (notice.audience === 'ALL') return true;
    if (notice.audience === 'KYC_APPROVED') return user.kyc?.status === 'APPROVED';
    if (notice.audience === 'UIDS') return asUidList(notice.audienceUids).includes(user.uid);
    return false;
  });
}

async function resolveAudienceUserIds(audience: string, uids: string[]): Promise<string[]> {
  if (audience === 'ALL') {
    const users = await prisma.user.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }
  if (audience === 'KYC_APPROVED') {
    const users = await prisma.user.findMany({
      where: { status: 'ACTIVE', kyc: { status: 'APPROVED' } },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }
  if (audience === 'UIDS') {
    const users = await prisma.user.findMany({
      where: { status: 'ACTIVE', uid: { in: uids } },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }
  return [];
}

export async function noticeRoutes(app: FastifyInstance) {
  /** 小程序：系统通知列表 */
  app.get('/api/notices', { preHandler: [app.authUser] }, async (req) => {
    const userId = (req.user as { sub: string }).sub;
    const notices = await noticesVisibleToUser(userId);
    const reads = await prisma.systemNoticeRead.findMany({
      where: { userId, noticeId: { in: notices.map((n) => n.id) } },
      select: { noticeId: true, readAt: true },
    });
    const readMap = new Map(reads.map((r) => [r.noticeId, r.readAt]));
    return {
      items: notices.map((notice) => ({
        id: notice.id,
        title: notice.title,
        body: notice.body,
        publishedAt: notice.publishedAt ?? notice.createdAt,
        read: readMap.has(notice.id),
        readAt: readMap.get(notice.id) ?? null,
      })),
      unread: notices.filter((n) => !readMap.has(n.id)).length,
    };
  });

  /** 小程序：消息页预览（最新一条 + 未读数） */
  app.get('/api/notices/preview', { preHandler: [app.authUser] }, async (req) => {
    const userId = (req.user as { sub: string }).sub;
    const notices = await noticesVisibleToUser(userId);
    const reads = await prisma.systemNoticeRead.findMany({
      where: { userId, noticeId: { in: notices.map((n) => n.id) } },
      select: { noticeId: true },
    });
    const readSet = new Set(reads.map((r) => r.noticeId));
    const latest = notices[0];
    return {
      unread: notices.filter((n) => !readSet.has(n.id)).length,
      latest: latest
        ? {
            id: latest.id,
            title: latest.title,
            body: latest.body,
            publishedAt: latest.publishedAt ?? latest.createdAt,
            read: readSet.has(latest.id),
          }
        : null,
    };
  });

  /** 小程序：标记已读 */
  app.post('/api/notices/:id/read', { preHandler: [app.authUser] }, async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const { id } = req.params as { id: string };
    const notices = await noticesVisibleToUser(userId);
    if (!notices.some((n) => n.id === id)) {
      return reply.code(404).send({ error: 'NOTICE_NOT_FOUND' });
    }
    await prisma.systemNoticeRead.upsert({
      where: { noticeId_userId: { noticeId: id, userId } },
      create: { noticeId: id, userId },
      update: { readAt: new Date() },
    });
    return { ok: true };
  });

  /** 小程序：全部已读 */
  app.post('/api/notices/read-all', { preHandler: [app.authUser] }, async (req) => {
    const userId = (req.user as { sub: string }).sub;
    const notices = await noticesVisibleToUser(userId);
    await Promise.all(
      notices.map((notice) =>
        prisma.systemNoticeRead.upsert({
          where: { noticeId_userId: { noticeId: notice.id, userId } },
          create: { noticeId: notice.id, userId },
          update: {},
        }),
      ),
    );
    return { ok: true };
  });
}

export async function adminNoticeRoutes(app: FastifyInstance) {
  const operators = [app.authAdmin, app.requireAdminRoles('SUPER', 'OPERATOR')];

  app.get('/api/admin/notices', { preHandler: operators }, async () => ({
    items: await prisma.systemNotice.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { reads: true } } },
    }),
  }));

  app.post('/api/admin/notices', { preHandler: operators }, async (req, reply) => {
    const adminId = (req.user as { sub: string }).sub;
    const body = z
      .object({
        title: z.string().trim().min(1).max(120),
        body: z.string().trim().min(1).max(5_000),
        audience: z.enum(['ALL', 'KYC_APPROVED', 'UIDS']).default('ALL'),
        uids: z.array(z.string().trim().min(1)).max(500).default([]),
        publishNow: z.boolean().default(true),
        pushTelegram: z.boolean().default(false),
      })
      .parse(req.body);

    if (body.audience === 'UIDS' && body.uids.length === 0) {
      return reply.code(400).send({ error: 'UIDS_REQUIRED' });
    }

    const item = await prisma.systemNotice.create({
      data: {
        title: body.title,
        body: body.body,
        audience: body.audience,
        audienceUids: body.audience === 'UIDS' ? body.uids : [],
        pushTelegram: body.pushTelegram,
        createdBy: adminId,
        status: body.publishNow ? 'PUBLISHED' : 'DRAFT',
        publishedAt: body.publishNow ? new Date() : null,
      },
    });

    let push: { total: number; success: number } | null = null;
    if (body.publishNow && body.pushTelegram) {
      const userIds = await resolveAudienceUserIds(body.audience, body.uids);
      let success = 0;
      const text = `📢 ${body.title}\n\n${body.body}`;
      await Promise.all(
        userIds.map(async (userId) => {
          const ok = await app.pushService.sendCustom(userId, text);
          if (ok) success += 1;
        }),
      );
      push = { total: userIds.length, success };
    }

    return { ok: true, item, push };
  });

  app.patch('/api/admin/notices/:id', { preHandler: operators }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        title: z.string().trim().min(1).max(120).optional(),
        body: z.string().trim().min(1).max(5_000).optional(),
        status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
        pushTelegram: z.boolean().optional(),
      })
      .parse(req.body);

    const existing = await prisma.systemNotice.findUniqueOrThrow({ where: { id } });
    const publishing = body.status === 'PUBLISHED' && existing.status !== 'PUBLISHED';
    const item = await prisma.systemNotice.update({
      where: { id },
      data: {
        ...body,
        publishedAt: publishing ? new Date() : existing.publishedAt,
      },
    });
    return { ok: true, item };
  });
}
