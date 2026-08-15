import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { GameError } from '../services/game.js';
import { isPresetAvatarUrl } from '../data/presetAvatars.js';
import {
  createVirtualPlayer,
  dressUpVirtualPlayers,
  fundVirtualPlayer,
  getVirtualPlayer,
  joinVirtualPlayer,
  leaveVirtualPlayer,
  listVirtualPlayers,
  randomizeVirtualIdentity,
  setVirtualPlayersEnabled,
  updateVirtualPlayer,
} from '../services/virtualPlayers.js';
import { actAsVirtualPlayer } from '../services/virtualPlayerWorker.js';

const idSchema = z.string().cuid();
// 房间存在早期种子/兼容 ID；与游戏路由保持同一安全 URL 标识符约束。
const roomIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);
const centsSchema = z.union([z.string(), z.number()]).transform((value) => BigInt(value));
const avatarSchema = z
  .string()
  .trim()
  .max(120)
  .refine((value) => isPresetAvatarUrl(value), { message: 'INVALID_AVATAR' })
  .nullable()
  .optional();

const capabilitySchema = z.object({
  enabled: z.boolean().optional(),
  canJoin: z.boolean().optional(),
  canChat: z.boolean().optional(),
  canBid: z.boolean().optional(),
  canBet: z.boolean().optional(),
  canAllIn: z.boolean().optional(),
  canBanker: z.boolean().optional(),
  canContinue: z.boolean().optional(),
  canThrowDice: z.boolean().optional(),
  canGroupPacket: z.boolean().optional(),
  canClaimGroupPacket: z.boolean().optional(),
  canClaimSim: z.boolean().optional(),
  bidWeight: z.number().min(0).max(1).optional(),
  betRatioMin: z.number().min(0).max(1).optional(),
  betRatioMax: z.number().min(0).max(1).optional(),
  chatPhrases: z.array(z.string().min(1).max(80)).max(20).optional(),
  targetBalanceCents: centsSchema.optional(),
});

export async function adminVirtualPlayerRoutes(app: FastifyInstance) {
  const operators = [app.authAdmin, app.requireAdminRoles('SUPER', 'OPERATOR')];

  app.get('/api/admin/virtual-players', { preHandler: operators }, async (req) => {
    const { roomId } = z
      .object({ roomId: roomIdSchema.optional() })
      .parse(req.query ?? {});
    return { items: await listVirtualPlayers(roomId) };
  });

  app.post('/api/admin/virtual-players', { preHandler: operators }, async (req, reply) => {
    const adminId = (req.user as { sub: string }).sub;
    const body = capabilitySchema
      .extend({
        nickname: z.string().trim().min(2).max(32).optional(),
        autoNickname: z.boolean().optional(),
        avatarUrl: avatarSchema,
        roomId: roomIdSchema,
        initialFundCents: centsSchema.optional(),
        joinRoom: z.boolean().optional(),
      })
      .parse(req.body);

    try {
      const item = await createVirtualPlayer({
        ...body,
        autoNickname: body.autoNickname ?? !body.nickname,
        createdBy: adminId,
      });
      await prisma.auditLog.create({
        data: {
          adminId,
          action: 'virtual_player_create',
          target: item.id,
          after: {
            userId: item.userId,
            nickname: item.user.nickname,
            avatarUrl: item.user.avatarUrl,
            roomId: item.roomId,
          },
          ip: req.ip,
        },
      });
      return { item };
    } catch (error) {
      if (error instanceof GameError) {
        return reply.code(400).send({ error: error.code, details: error.details });
      }
      throw error;
    }
  });

  /** 一键启用/停用（可限定单个互动群） */
  app.post('/api/admin/virtual-players/bulk-enabled', { preHandler: operators }, async (req, reply) => {
    const adminId = (req.user as { sub: string }).sub;
    const body = z
      .object({
        enabled: z.boolean(),
        roomId: roomIdSchema.optional(),
      })
      .parse(req.body ?? {});
    try {
      const result = await setVirtualPlayersEnabled(body.enabled, body.roomId);
      await prisma.auditLog.create({
        data: {
          adminId,
          action: body.enabled ? 'virtual_player_bulk_enable' : 'virtual_player_bulk_disable',
          target: body.roomId ?? 'all',
          after: { count: result.count, roomId: body.roomId ?? null, enabled: body.enabled },
          ip: req.ip,
        },
      });
      return { ok: true, count: result.count };
    } catch (error) {
      if (error instanceof GameError) {
        return reply.code(400).send({ error: error.code, details: error.details });
      }
      throw error;
    }
  });

  app.post('/api/admin/virtual-players/dress-up', { preHandler: operators }, async (req, reply) => {
    const adminId = (req.user as { sub: string }).sub;
    const body = z
      .object({ roomId: roomIdSchema.optional() })
      .parse(req.body ?? {});
    try {
      const result = await dressUpVirtualPlayers(body.roomId);
      await prisma.auditLog.create({
        data: {
          adminId,
          action: 'virtual_player_dress_up',
          target: body.roomId ?? 'all',
          after: { count: result.count, roomId: body.roomId ?? null },
          ip: req.ip,
        },
      });
      return result;
    } catch (error) {
      if (error instanceof GameError) {
        return reply.code(400).send({ error: error.code, details: error.details });
      }
      throw error;
    }
  });

  app.post('/api/admin/virtual-players/:id/randomize-identity', { preHandler: operators }, async (req, reply) => {
    const adminId = (req.user as { sub: string }).sub;
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = z
      .object({
        rename: z.boolean().optional(),
        reavatar: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    try {
      const item = await randomizeVirtualIdentity(id, body);
      await prisma.auditLog.create({
        data: {
          adminId,
          action: 'virtual_player_randomize_identity',
          target: id,
          after: {
            nickname: item.user.nickname,
            avatarUrl: item.user.avatarUrl,
          },
          ip: req.ip,
        },
      });
      return { item };
    } catch (error) {
      if (error instanceof GameError) {
        const status = error.code === 'VIRTUAL_NOT_FOUND' ? 404 : 400;
        return reply.code(status).send({ error: error.code, details: error.details });
      }
      throw error;
    }
  });

  app.patch('/api/admin/virtual-players/:id', { preHandler: operators }, async (req, reply) => {
    const adminId = (req.user as { sub: string }).sub;
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = capabilitySchema
      .extend({
        nickname: z.string().trim().min(2).max(32).optional(),
        avatarUrl: avatarSchema,
        roomId: roomIdSchema.optional(),
      })
      .parse(req.body ?? {});
    try {
      const item = await updateVirtualPlayer(id, body);
      await prisma.auditLog.create({
        data: {
          adminId,
          action: 'virtual_player_update',
          target: id,
          after: {
            ...body,
            targetBalanceCents:
              body.targetBalanceCents !== undefined
                ? String(body.targetBalanceCents)
                : undefined,
          },
          ip: req.ip,
        },
      });
      return { item };
    } catch (error) {
      if (error instanceof GameError) {
        const status = error.code === 'VIRTUAL_NOT_FOUND' ? 404 : 400;
        return reply.code(status).send({ error: error.code, details: error.details });
      }
      throw error;
    }
  });

  app.post('/api/admin/virtual-players/:id/fund', { preHandler: operators }, async (req, reply) => {
    const adminId = (req.user as { sub: string }).sub;
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = z
      .object({
        amountCents: centsSchema,
        reason: z.string().trim().min(2).max(200).default('虚拟玩家补款'),
      })
      .parse(req.body ?? {});
    try {
      const profile = await getVirtualPlayer(id);
      const wallet = await fundVirtualPlayer(
        profile.userId,
        body.amountCents,
        adminId,
        body.reason,
      );
      await prisma.auditLog.create({
        data: {
          adminId,
          action: 'virtual_player_fund',
          target: id,
          after: {
            amountCents: String(body.amountCents),
            availableCents: String(wallet.availableCents),
            reason: body.reason,
          },
          ip: req.ip,
        },
      });
      return { ok: true, item: await getVirtualPlayer(id) };
    } catch (error) {
      if (error instanceof GameError) {
        return reply.code(400).send({ error: error.code, details: error.details });
      }
      throw error;
    }
  });

  app.post('/api/admin/virtual-players/:id/join', { preHandler: operators }, async (req, reply) => {
    const adminId = (req.user as { sub: string }).sub;
    const { id } = z.object({ id: idSchema }).parse(req.params);
    try {
      const item = await joinVirtualPlayer(id);
      await prisma.auditLog.create({
        data: {
          adminId,
          action: 'virtual_player_join',
          target: id,
          after: { roomId: item.roomId },
          ip: req.ip,
        },
      });
      return { item };
    } catch (error) {
      if (error instanceof GameError) {
        return reply.code(400).send({ error: error.code, details: error.details });
      }
      throw error;
    }
  });

  app.post('/api/admin/virtual-players/:id/leave', { preHandler: operators }, async (req, reply) => {
    const adminId = (req.user as { sub: string }).sub;
    const { id } = z.object({ id: idSchema }).parse(req.params);
    try {
      const item = await leaveVirtualPlayer(id);
      await prisma.auditLog.create({
        data: {
          adminId,
          action: 'virtual_player_leave',
          target: id,
          ip: req.ip,
        },
      });
      return { item };
    } catch (error) {
      if (error instanceof GameError) {
        return reply.code(400).send({ error: error.code, details: error.details });
      }
      throw error;
    }
  });

  app.post('/api/admin/virtual-players/:id/act', { preHandler: operators }, async (req, reply) => {
    const adminId = (req.user as { sub: string }).sub;
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = z
      .object({
        action: z.enum(['bid', 'bet', 'dice', 'chat']),
        amountCents: centsSchema.optional(),
        isAllIn: z.boolean().optional(),
        text: z.string().trim().min(1).max(200).optional(),
      })
      .parse(req.body ?? {});
    try {
      const result = await actAsVirtualPlayer({
        virtualPlayerId: id,
        action: body.action,
        amountCents: body.amountCents,
        isAllIn: body.isAllIn,
        text: body.text,
      });
      await prisma.auditLog.create({
        data: {
          adminId,
          action: 'virtual_player_act',
          target: id,
          after: {
            action: body.action,
            amountCents: body.amountCents ? String(body.amountCents) : null,
            isAllIn: body.isAllIn ?? false,
          },
          ip: req.ip,
        },
      });
      return { ok: true, result };
    } catch (error) {
      if (error instanceof GameError) {
        return reply.code(400).send({
          error: error.code,
          details: error.details,
          message: typeof error.details?.message === 'string' ? error.details.message : undefined,
        });
      }
      throw error;
    }
  });
}
