import { GameAdminAssignmentStatus } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { toCentsBigInt } from '../engine/betting.js';
import { sendGameBudgetPacket } from '../services/groupPacket.js';
import { appendChatOnce } from '../services/roomHub.js';
import { scheduleVirtualGroupPacketClaims } from '../services/virtualPlayerWorker.js';
import {
  fundGameBudget,
  GameBudgetError,
  reclaimGameBudget,
} from '../services/gameBudget.js';
import {
  createGameAdminAssignment,
  GAME_ADMIN_PERMISSIONS,
  getGameAdminConsole,
  getPlatformGameAdminOverview,
  listGameAdminActions,
  listGameAdminCandidates,
  listGameAdminMembers,
  listMyGameAdminAssignments,
  muteGameAdminMember,
  unmuteGameAdminMember,
  updateGameAdminAssignment,
} from '../services/gameAdmin.js';

const gameCodeSchema = z.string().trim().min(2).max(64).regex(/^[A-Z0-9_]+$/);
const resourceIdSchema = z.string().trim().min(1).max(64);
const requestIdSchema = z.string().uuid();
const permissionSchema = z.enum(GAME_ADMIN_PERMISSIONS);

const assignmentBodySchema = z.object({
  userId: resourceIdSchema,
  permissions: z.array(permissionSchema).min(1).max(GAME_ADMIN_PERMISSIONS.length),
});

const assignmentUpdateSchema = z
  .object({
    permissions: z.array(permissionSchema).min(1).max(GAME_ADMIN_PERMISSIONS.length).optional(),
    status: z.nativeEnum(GameAdminAssignmentStatus).optional(),
  })
  .refine((value) => value.permissions !== undefined || value.status !== undefined);

const budgetMutationSchema = z.object({
  amount: z.string().trim().min(1).max(32),
  requestId: requestIdSchema,
  reason: z.string().trim().min(4).max(200),
});

const packetSchema = z.object({
  amount: z.string().trim().min(1).max(32),
  count: z.number().int().min(1).max(50),
  mode: z.enum(['RANDOM', 'EQUAL']).default('RANDOM'),
  greeting: z.string().trim().min(1).max(40).default('恭喜发财，大吉大利'),
  requestId: requestIdSchema,
  paymentPin: z.string().regex(/^\d{6}$/),
});

const muteSchema = z.object({
  durationMinutes: z.number().int().min(1).max(43_200).nullable(),
  reason: z.string().trim().min(2).max(120),
  requestId: requestIdSchema,
});

const unmuteSchema = z.object({
  reason: z.string().trim().min(2).max(120),
  requestId: requestIdSchema,
});

function budgetAmount(value: string) {
  try {
    const amountCents = toCentsBigInt(value);
    if (amountCents <= 0n) throw new Error('INVALID_AMOUNT');
    return amountCents;
  } catch (error) {
    throw new GameBudgetError(
      error instanceof Error && error.message === 'AMOUNT_TOO_LARGE'
        ? 'BUDGET_AMOUNT_TOO_LARGE'
        : 'INVALID_BUDGET_AMOUNT',
    );
  }
}

export async function gameAdminRoutes(app: FastifyInstance) {
  const observers = [
    app.authAdmin,
    app.requireAdminRoles('SUPER', 'OPERATOR', 'REVIEWER', 'FINANCE'),
  ];
  const assignmentManagers = [app.authAdmin, app.requireAdminRoles('SUPER')];
  const budgetManagers = [
    app.authAdmin,
    app.requireAdminRoles('SUPER', 'FINANCE'),
  ];

  app.get(
    '/api/admin/games/:gameCode/game-admins/overview',
    { preHandler: observers },
    async (req) => {
      const { gameCode } = z.object({ gameCode: gameCodeSchema }).parse(req.params);
      return getPlatformGameAdminOverview(gameCode);
    },
  );

  app.post(
    '/api/game-admin/games/:gameCode/packets',
    {
      preHandler: [app.authUser],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req) => {
      const { gameCode } = z.object({ gameCode: gameCodeSchema }).parse(req.params);
      const body = packetSchema.parse(req.body);
      const userId = (req.user as { sub: string }).sub;
      const result = await sendGameBudgetPacket({
        gameCode,
        userId,
        totalCents: budgetAmount(body.amount),
        count: body.count,
        mode: body.mode,
        greeting: body.greeting,
        requestId: body.requestId,
        paymentPin: body.paymentPin,
        ip: req.ip,
      });
      const { packet, assignment } = result;
      await appendChatOnce(assignment.room.id, `user-packet:${packet.id}`, {
        type: 'USER_PACKET',
        content: JSON.stringify({
          id: packet.id,
          greeting: packet.greeting,
          mode: packet.mode,
          source: 'GAME_ADMIN',
        }),
        from: {
          uid: assignment.user.uid,
          nickname: assignment.user.nickname ?? assignment.user.uid,
          avatarUrl: assignment.user.avatarUrl,
        },
      });
      if (!result.duplicate) {
        scheduleVirtualGroupPacketClaims({
          roomId: assignment.room.id,
          packetId: packet.id,
          senderId: userId,
        });
      }
      return {
        ok: true,
        packetId: packet.id,
        duplicate: result.duplicate,
      };
    },
  );

  app.post(
    '/api/game-admin/games/:gameCode/members/:userId/mute',
    {
      preHandler: [app.authUser],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req) => {
      const { gameCode, userId } = z
        .object({
          gameCode: gameCodeSchema,
          userId: resourceIdSchema,
        })
        .parse(req.params);
      const body = muteSchema.parse(req.body);
      const result = await muteGameAdminMember({
        actorUserId: (req.user as { sub: string }).sub,
        gameCode,
        targetUserId: userId,
        durationMinutes: body.durationMinutes,
        reason: body.reason,
        requestId: body.requestId,
        ip: req.ip,
      });
      return {
        ok: true,
        duplicate: result.duplicate,
        moderation: result.moderation,
      };
    },
  );

  app.post(
    '/api/game-admin/games/:gameCode/members/:userId/unmute',
    {
      preHandler: [app.authUser],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req) => {
      const { gameCode, userId } = z
        .object({
          gameCode: gameCodeSchema,
          userId: resourceIdSchema,
        })
        .parse(req.params);
      const body = unmuteSchema.parse(req.body);
      const result = await unmuteGameAdminMember({
        actorUserId: (req.user as { sub: string }).sub,
        gameCode,
        targetUserId: userId,
        reason: body.reason,
        requestId: body.requestId,
        ip: req.ip,
      });
      return { ok: true, duplicate: result.duplicate };
    },
  );

  app.get(
    '/api/admin/games/:gameCode/game-admin-candidates',
    { preHandler: assignmentManagers },
    async (req) => {
      const { gameCode } = z.object({ gameCode: gameCodeSchema }).parse(req.params);
      const query = z
        .object({
          q: z.string().trim().max(100).optional(),
          limit: z.coerce.number().int().min(1).max(30).default(12),
        })
        .parse(req.query);
      return {
        items: await listGameAdminCandidates(gameCode, query.q, query.limit),
      };
    },
  );

  app.post(
    '/api/admin/games/:gameCode/game-admins',
    { preHandler: assignmentManagers },
    async (req) => {
      const { gameCode } = z.object({ gameCode: gameCodeSchema }).parse(req.params);
      const body = assignmentBodySchema.parse(req.body);
      const platformAdminId = (req.user as { sub: string }).sub;
      const assignment = await createGameAdminAssignment({
        gameCode,
        userId: body.userId,
        permissions: body.permissions,
        platformAdminId,
        ip: req.ip,
      });
      return { ok: true, assignment };
    },
  );

  app.patch(
    '/api/admin/games/:gameCode/game-admins/:assignmentId',
    { preHandler: assignmentManagers },
    async (req) => {
      const { gameCode, assignmentId } = z
        .object({
          gameCode: gameCodeSchema,
          assignmentId: resourceIdSchema,
        })
        .parse(req.params);
      const body = assignmentUpdateSchema.parse(req.body);
      const platformAdminId = (req.user as { sub: string }).sub;
      const assignment = await updateGameAdminAssignment({
        gameCode,
        assignmentId,
        permissions: body.permissions,
        status: body.status,
        platformAdminId,
        ip: req.ip,
      });
      return { ok: true, assignment };
    },
  );

  app.post(
    '/api/admin/games/:gameCode/game-budget/fund',
    { preHandler: budgetManagers },
    async (req) => {
      const { gameCode } = z.object({ gameCode: gameCodeSchema }).parse(req.params);
      const body = budgetMutationSchema.parse(req.body);
      const result = await fundGameBudget({
        gameCode,
        amountCents: budgetAmount(body.amount),
        requestId: body.requestId,
        reason: body.reason,
        platformAdminId: (req.user as { sub: string }).sub,
        ip: req.ip,
      });
      return { ok: true, ...result };
    },
  );

  app.post(
    '/api/admin/games/:gameCode/game-budget/reclaim',
    { preHandler: budgetManagers },
    async (req) => {
      const { gameCode } = z.object({ gameCode: gameCodeSchema }).parse(req.params);
      const body = budgetMutationSchema.parse(req.body);
      const result = await reclaimGameBudget({
        gameCode,
        amountCents: budgetAmount(body.amount),
        requestId: body.requestId,
        reason: body.reason,
        platformAdminId: (req.user as { sub: string }).sub,
        ip: req.ip,
      });
      return { ok: true, ...result };
    },
  );

  app.get('/api/game-admin/me', { preHandler: [app.authUser] }, async (req) => ({
    items: await listMyGameAdminAssignments((req.user as { sub: string }).sub),
  }));

  app.get(
    '/api/game-admin/games/:gameCode',
    { preHandler: [app.authUser] },
    async (req) => {
      const { gameCode } = z.object({ gameCode: gameCodeSchema }).parse(req.params);
      return getGameAdminConsole((req.user as { sub: string }).sub, gameCode);
    },
  );

  app.get(
    '/api/game-admin/games/:gameCode/members',
    { preHandler: [app.authUser] },
    async (req) => {
      const { gameCode } = z.object({ gameCode: gameCodeSchema }).parse(req.params);
      const query = z
        .object({
          q: z.string().trim().max(100).optional(),
          cursor: resourceIdSchema.optional(),
          limit: z.coerce.number().int().min(1).max(80).default(30),
        })
        .parse(req.query);
      return listGameAdminMembers({
        actorUserId: (req.user as { sub: string }).sub,
        gameCode,
        ...query,
      });
    },
  );

  app.get(
    '/api/game-admin/games/:gameCode/actions',
    { preHandler: [app.authUser] },
    async (req) => {
      const { gameCode } = z.object({ gameCode: gameCodeSchema }).parse(req.params);
      const query = z
        .object({
          cursor: resourceIdSchema.optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
        })
        .parse(req.query);
      return listGameAdminActions({
        actorUserId: (req.user as { sub: string }).sub,
        gameCode,
        ...query,
      });
    },
  );
}
