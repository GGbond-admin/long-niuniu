import { RoundPhase } from '@prisma/client';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { HAND_LABEL } from '../engine/hand.js';
import { safeDecryptSecret } from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';
import {
  cancelRound,
  claimCandidates,
  claimInternalPacket,
  claimUrlForParticipant,
  closeBetting,
  correctClaim,
  currentRoundForRoom,
  ensureWaitingRound,
  forfeitMissingPlayer,
  GameError,
  pauseAssistantService,
  publishInternalPacket,
  publishPacket,
  refreshUnannouncedClaimDeadline,
  reconcileCancelledPacket,
  reconcilePacketReturn,
  recordClaim,
  resumeBotService,
  settleGameRound,
  startRound,
} from '../services/game.js';
import { gameBus } from '../services/gameBus.js';
import { finalizeInternalRound } from '../services/internalPacket.js';
import {
  getGameSettings,
  setAssistantService,
  setBankerBidMin,
  setPacketChannel,
} from '../services/gameSettings.js';
import { processRoundRewards } from '../services/rewards.js';
import { malaysiaDay } from '../services/rebates.js';
import {
  gameDefinition,
  isSupportedGameCode,
  SUPPORTED_GAME_CODES,
  SUPREME_NIUNIU_GAME_CODE,
  listCatalogGames,
} from '../services/gameCatalog.js';
import {
  gameRuleDocumentInput,
  getAdminGameRules,
  getPublishedGameRules,
  ruleConfigSummary,
  saveGameRules,
  summarizeRuleChanges,
} from '../services/gameRules.js';
import {
  acquireAssistantLease,
  assistantLeaseStatus,
  forceAcquireAssistantLease,
  heartbeatAssistantLease,
  releaseAssistantLease,
  type AssistantLease,
} from '../services/assistantTakeover.js';
import {
  addObserver,
  appendGamePacketMessage,
  broadcastToRoom,
  broadcastToRoomObservers,
  ensureRoundAnnouncement,
  removeObserver,
  systemBanner,
  systemChat,
  systemCountdown,
  type RoomObserver,
} from '../services/roomHub.js';
import {
  buildRoundAnnounceMessages,
  type AnnounceBanner,
} from '../services/roomAnnounce.js';
import {
  getScoreboardPresentation,
  previewScoreboardPresentation,
  restoreAndSyncScoreboardPresentation,
  saveAndSyncScoreboardPresentation,
  scoreboardPresentationInput,
  scoreboardPresentationMutationInput,
  ScoreboardPresentationError,
  syncScoreboardPresentation,
} from '../services/scoreboardPresentation.js';

const idSchema = z.string().cuid();

function scoreboardErrorReply(reply: FastifyReply, error: unknown) {
  if (error instanceof ScoreboardPresentationError) {
    return reply.code(error.statusCode).send({ error: error.code });
  }
  throw error;
}
// 兼容早期种子数据的可读房间 / 牌局 ID，同时限制为安全 URL 标识符。
const resourceIdSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const amountSchema = z.string().regex(/^[1-9]\d*$/);
const gameCodeSchema = z.string().refine(isSupportedGameCode, {
  message: 'GAME_NOT_SUPPORTED',
});
const roomSchema = z
  .object({
    gameCode: gameCodeSchema.default(SUPREME_NIUNIU_GAME_CODE),
    minPlayers: z.number().int().min(2).max(100).default(2),
    // 以下为兼容旧 TG 入口绑定字段；不能用它们复制同一款游戏的互动群。
    chatId: z.string().regex(/^-\d+$/).optional(),
    botId: idSchema.optional(),
    inviteLink: z.string().url().optional(),
  })
  .strict();
const roomUpdateSchema = z
  .object({
    minPlayers: z.number().int().min(2).max(100).optional(),
    inviteLink: z.string().url().nullable().optional(),
    status: z.enum(['ACTIVE', 'PAUSED']).optional(),
    botId: idSchema.nullable().optional(),
  })
  .strict();
const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), force: z.boolean().default(true) }),
  z.object({ action: z.literal('close_bidding') }),
  z.object({ action: z.literal('close_betting') }),
  z.object({ action: z.literal('settle') }),
  z.object({ action: z.literal('cancel'), reason: z.string().min(2).max(200) }),
]);
const assistantBannerKeys = ['bet-start', 'bet-stop', 'claim-start', 'claim-stop'] as const;
const assistantBannerLabels: Record<(typeof assistantBannerKeys)[number], string> = {
  'bet-start': '开始下注',
  'bet-stop': '停止下注',
  'claim-start': '开始抢包',
  'claim-stop': '抢包结束',
};
const assistantMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('TEXT'), content: z.string().trim().min(1).max(1_000) }),
  z.object({ kind: z.literal('BANNER'), key: z.enum(assistantBannerKeys) }),
]);
const assistantPinSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(2_000),
});

function leaseResponse(lease: AssistantLease | null, adminId: string) {
  return {
    mode: lease ? 'ASSISTED' : 'AUTO',
    lease,
    heldByMe: lease?.adminId === adminId,
  };
}

async function supportedRoomById(roomId: string) {
  return prisma.room.findFirst({
    where: {
      id: roomId,
      gameCode: { in: SUPPORTED_GAME_CODES },
    },
  });
}

async function requireSupportedRoom(roomId: string) {
  const room = await supportedRoomById(roomId);
  if (!room) throw new GameError('GAME_NOT_SUPPORTED');
  return room;
}

async function requireSupportedRound(roundId: string) {
  const round = await prisma.round.findFirst({
    where: {
      id: roundId,
      room: { gameCode: { in: SUPPORTED_GAME_CODES } },
    },
    select: { id: true, roomId: true, phase: true },
  });
  if (!round) throw new GameError('GAME_NOT_SUPPORTED');
  return round;
}

async function hasActiveRoomMembership(userId: string, roomId: string): Promise<boolean> {
  const member = await prisma.roomMember.findUnique({
    where: { roomId_userId: { roomId, userId } },
    select: { status: true },
  });
  return member?.status === 'ACTIVE';
}

function emitTransition(
  roundId: string,
  roomId: string,
  from: RoundPhase | string,
  to: RoundPhase | string,
) {
  if (from !== to) gameBus.transition({ roundId, roomId, from, to });
}

const NEXT_ROUND_RECOVERY_DELAYS_MS = [250, 500, 1_000, 2_000] as const;

function recoverNextRoundThenEmit(
  params: {
    roundId: string;
    roomId: string;
    from: RoundPhase | string;
    to: RoundPhase | string;
  },
  attempt = 0,
) {
  const delayMs = NEXT_ROUND_RECOVERY_DELAYS_MS[attempt];
  if (delayMs === undefined) {
    console.error('[game] next round recovery exhausted', params);
    return;
  }
  const timer = setTimeout(() => {
    void ensureWaitingRound(params.roomId)
      .then(() => emitTransition(params.roundId, params.roomId, params.from, params.to))
      .catch((error) => {
        console.error('[game] next round recovery failed', params.roomId, error);
        recoverNextRoundThenEmit(params, attempt + 1);
      });
  }, delayMs);
  timer.unref?.();
}

export async function gameRoutes(app: FastifyInstance) {
  app.get('/api/game/lobby', { preHandler: [app.authUser] }, async (req) => {
    const userId = (req.user as { sub: string }).sub;
    const [user, rooms, announcements] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, include: { kyc: true } }),
      prisma.room.findMany({
        where: {
          status: 'ACTIVE',
          gameCode: { in: SUPPORTED_GAME_CODES },
        },
        include: {
          rounds: {
            where: {
              phase: {
                in: [
                  'WAITING',
                  'BANKER_BID',
                  'BETTING',
                  'SENDING_PACKET',
                  'CLAIMING',
                  'CLAIM_EXPIRED',
                  'SETTLING',
                ],
              },
            },
            orderBy: { seqNo: 'desc' },
            take: 1,
          },
          _count: { select: { members: { where: { status: 'ACTIVE' } } } },
        },
      }),
      prisma.announcement.findMany({
        where: {
          status: 'PUBLISHED',
          target: 'ALL',
          OR: [{ scheduledAt: null }, { scheduledAt: { lte: new Date() } }],
        },
        orderBy: [{ pinned: 'desc' }, { publishedAt: 'desc' }],
        take: 10,
      }),
    ]);
    const kycApproved = user?.kyc?.status === 'APPROVED';
    return {
      announcements,
      games: rooms.map((room) => ({
        gameCode: room.gameCode,
        id: room.id,
        title: gameDefinition(room.gameCode)?.title ?? room.title,
        interactionGroupTitle:
          gameDefinition(room.gameCode)?.interactionGroupTitle ?? room.title,
        inviteLink: kycApproved ? room.inviteLink : null,
        kycRequired: !kycApproved,
        online: room._count.members,
        round: room.rounds[0]
          ? {
              id: room.rounds[0].id,
              seqNo: room.rounds[0].seqNo,
              phase: room.rounds[0].phase,
              bidEndsAt: room.rounds[0].bidEndsAt,
              betEndsAt: room.rounds[0].betEndsAt,
              claimEndsAt: room.rounds[0].claimEndsAt,
            }
          : null,
      })),
    };
  });

  app.get('/api/game/rules', { preHandler: [app.authUser] }, async (req, reply) => {
    const { gameCode } = z
      .object({
        gameCode: gameCodeSchema.default(SUPREME_NIUNIU_GAME_CODE),
      })
      .parse(req.query);
    const [settings, document] = await Promise.all([
      getGameSettings(gameCode),
      getPublishedGameRules(gameCode),
    ]);
    if (!document) {
      return reply.code(404).send({
        error: 'GAME_RULES_NOT_PUBLISHED',
        gameCode,
      });
    }
    return {
      gameCode,
      document: {
        title: document.title,
        summary: document.summary,
        sections: document.sections,
        version: document.version,
        publishedAt: document.publishedAt,
      },
      handLabels: HAND_LABEL,
      config: ruleConfigSummary(settings),
      hand: settings.hand,
      betting: settings.betting,
      fees: settings.fees,
      round: settings.round,
    };
  });

  app.get('/api/game/rooms/:id/round', { preHandler: [app.authUser, app.requireKyc] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = (req.user as { sub: string }).sub;
    const room = await supportedRoomById(id);
    if (!room) return reply.code(404).send({ error: 'GAME_NOT_SUPPORTED' });
    if (!(await hasActiveRoomMembership(userId, id))) {
      return reply.code(403).send({ error: 'NOT_IN_ROOM' });
    }
    const round = await currentRoundForRoom(id);
    if (!round) return { round: null };
    return {
      round: {
        id: round.id,
        seqNo: round.seqNo,
        phase: round.phase,
        potCents: String(round.potCents),
        bidEndsAt: round.bidEndsAt,
        betEndsAt: round.betEndsAt,
        claimEndsAt: round.claimEndsAt,
        bidCount: round.bids.length,
        betCount: round.bets.filter((bet) => bet.status === 'FROZEN').length,
        claimCount: round.claims.length,
      },
    };
  });

  /** 红包结束后仍可点开查看抢包/认额名单（微信式手气榜） */
  app.get('/api/game/packets/:id', { preHandler: [app.authUser, app.requireKyc] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = (req.user as { sub: string }).sub;
    const packet = await prisma.packet.findUnique({
      where: { id },
      include: {
        round: {
          select: {
            roomId: true,
            bankerId: true,
            phase: true,
            claims: {
              include: {
                user: { select: { uid: true, nickname: true, avatarUrl: true } },
              },
              orderBy: { createdAt: 'asc' },
            },
          },
        },
      },
    });
    if (!packet) return reply.code(404).send({ error: 'PACKET_NOT_FOUND' });
    if (!(await hasActiveRoomMembership(userId, packet.round.roomId))) {
      return reply.code(403).send({ error: 'NOT_IN_ROOM' });
    }
    return {
      id: packet.id,
      channel: packet.channel,
      status: packet.status,
      phase: packet.round.phase,
      totalCents: String(packet.totalCents),
      participantCount: packet.participantCount,
      claims: packet.round.claims.map((claim) => ({
        uid: claim.user.uid,
        nickname: claim.user.nickname,
        avatarUrl: claim.user.avatarUrl,
        amountCents: String(claim.amountCents),
        isBanker: !!packet.round.bankerId && claim.userId === packet.round.bankerId,
        isTail: claim.source === 'AUTO_TAIL',
        at: (claim.confirmedAt ?? claim.createdAt).toISOString(),
      })),
    };
  });

  app.post(
    '/api/game/packets/:id/claim',
    { preHandler: [app.authUser, app.requireKyc] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const userId = (req.user as { sub: string }).sub;
      try {
        const packet = await prisma.packet.findUnique({
          where: { id },
          select: { channel: true, roundId: true },
        });
        if (packet?.channel === 'INTERNAL') {
          const result = await claimInternalPacket(id, userId);
          gameBus.claimRecorded({
            roundId: packet.roundId,
            userId,
            amountCents: String(result.claim.amountCents),
          });
          if (result.complete) {
            // 全员抢完立即自动结算；失败留给调度器超时兜底，不影响本次领取。
            void finalizeInternalRound(packet.roundId).catch((error) => {
              app.log.error(error, 'finalize internal round after claim failed');
            });
          }
          return {
            channel: 'INTERNAL',
            amountCents: String(result.claim.amountCents),
            handType: result.claim.handType,
            points: result.claim.points,
          };
        }
        return { url: await claimUrlForParticipant(id, userId) };
      } catch (error) {
        if (error instanceof GameError && error.code === 'NOT_ELIGIBLE_TO_CLAIM') {
          return reply.code(403).send({
            error: 'NOT_ELIGIBLE_TO_CLAIM',
            message: '仅本局庄家与已下注闲家可领取红包',
          });
        }
        throw error;
      }
    },
  );
}

export async function adminGameRoutes(app: FastifyInstance) {
  const operations = [app.authAdmin, app.requireAdminRoles('SUPER', 'OPERATOR')];
  const roomObservers = [
    app.authAdmin,
    app.requireAdminRoles('SUPER', 'OPERATOR', 'REVIEWER', 'FINANCE'),
  ];
  const scoreboardObservers = [
    app.authAdmin,
    app.requireAdminRoles('SUPER', 'OPERATOR', 'REVIEWER'),
  ];

  /** 短时观察票据：避免把 8 小时 admin JWT 放进 WebSocket query。 */
  app.post(
    '/api/admin/rooms/:id/observer-ticket',
    { preHandler: roomObservers },
    async (req, reply) => {
      const { id } = z.object({ id: resourceIdSchema }).parse(req.params);
      const adminId = (req.user as { sub: string }).sub;
      const room = await supportedRoomById(id);
      if (!room) return reply.code(404).send({ error: 'GAME_NOT_SUPPORTED' });
      const admin = await prisma.admin.findUnique({
        where: { id: adminId },
        select: { id: true, role: true, status: true },
      });
      if (!admin || admin.status !== 'ACTIVE') {
        return reply.code(401).send({ error: 'UNAUTHORIZED' });
      }
      const ticket = app.jwt.sign(
        { sub: admin.id, kind: 'admin_ws', roomId: id, role: admin.role },
        { expiresIn: '60s' },
      );
      return { ticket, expiresIn: 60 };
    },
  );

  app.get('/api/admin/rooms/:id/ws', { websocket: true }, async (socket: WebSocket, req) => {
    const { id } = req.params as { id: string };
    const { ticket } = req.query as { ticket?: string };
    if (!resourceIdSchema.safeParse(id).success) {
      socket.close(4400, 'INVALID_ROOM_ID');
      return;
    }
    let claims: { sub: string; kind?: string; roomId?: string };
    try {
      claims = app.jwt.verify<{ sub: string; kind?: string; roomId?: string }>(ticket ?? '');
      if (claims.kind !== 'admin_ws' || claims.roomId !== id) throw new Error('wrong ticket');
    } catch {
      socket.close(4401, 'UNAUTHORIZED');
      return;
    }

    const observer: RoomObserver = {
      socket,
      adminId: claims.sub,
      username: '',
      role: '',
    };
    // 先挂清理再做异步鉴权，避免 await 期间断开造成泄漏。
    const cleanup = () => removeObserver(id, observer);
    socket.on('close', cleanup);
    socket.on('error', cleanup);

    const [admin, room] = await Promise.all([
      prisma.admin.findUnique({
        where: { id: claims.sub },
        select: { id: true, username: true, role: true, status: true },
      }),
      supportedRoomById(id),
    ]);
    if (
      !admin ||
      admin.status !== 'ACTIVE' ||
      !['SUPER', 'OPERATOR', 'REVIEWER', 'FINANCE'].includes(admin.role)
    ) {
      socket.close(4403, 'FORBIDDEN');
      return;
    }
    if (!room) {
      socket.close(4404, 'GAME_NOT_SUPPORTED');
      return;
    }

    observer.username = admin.username;
    observer.role = admin.role;
    addObserver(id, observer);

    const revalidate = async () => {
      const current = await prisma.admin.findUnique({
        where: { id: admin.id },
        select: { status: true, role: true },
      });
      if (
        !current ||
        current.status !== 'ACTIVE' ||
        !['SUPER', 'OPERATOR', 'REVIEWER', 'FINANCE'].includes(current.role)
      ) {
        socket.close(4403, 'FORBIDDEN');
        return false;
      }
      observer.role = current.role;
      return true;
    };

    try {
      const lease = await assistantLeaseStatus(id);
      if (socket.readyState === socket.OPEN) {
        socket.send(
          JSON.stringify({
            type: 'assistant_lease',
            ...leaseResponse(lease, admin.id),
          }),
        );
      }
    } catch {
      if (socket.readyState === socket.OPEN) {
        socket.send(
          JSON.stringify({
            type: 'assistant_lease',
            mode: 'UNAVAILABLE',
            lease: null,
            heldByMe: false,
          }),
        );
      }
    }

    const authTimer = setInterval(() => {
      void revalidate().catch(() => socket.close(4403, 'FORBIDDEN'));
    }, 30_000);
    socket.on('close', () => clearInterval(authTimer));
    socket.on('error', () => clearInterval(authTimer));

    socket.on('message', (raw: Buffer) => {
      try {
        const payload = JSON.parse(raw.toString('utf8')) as { type?: string };
        if (payload.type === 'ping') {
          void revalidate()
            .then((ok) => {
              if (ok && socket.readyState === socket.OPEN) {
                socket.send(JSON.stringify({ type: 'pong' }));
              }
            })
            .catch(() => socket.close(4403, 'FORBIDDEN'));
        }
      } catch {
        // 管理员观察连接只接受 ping；其他入站消息全部忽略。
      }
    });
  });

  app.get(
    '/api/admin/rooms/:id/assistant/status',
    { preHandler: roomObservers },
    async (req, reply) => {
      const { id } = z.object({ id: resourceIdSchema }).parse(req.params);
      const adminId = (req.user as { sub: string }).sub;
      const room = await supportedRoomById(id);
      if (!room) return reply.code(404).send({ error: 'GAME_NOT_SUPPORTED' });
      return leaseResponse(await assistantLeaseStatus(id), adminId);
    },
  );

  app.post(
    '/api/admin/rooms/:id/assistant/takeover',
    { preHandler: operations },
    async (req, reply) => {
      const { id } = z.object({ id: resourceIdSchema }).parse(req.params);
      const adminId = (req.user as { sub: string }).sub;
      const [admin, room] = await Promise.all([
        prisma.admin.findUnique({
          where: { id: adminId },
          select: { username: true },
        }),
        supportedRoomById(id),
      ]);
      if (!room) return reply.code(404).send({ error: 'GAME_NOT_SUPPORTED' });
      if (!admin) return reply.code(401).send({ error: 'UNAUTHORIZED' });
      const result = await acquireAssistantLease({
        roomId: id,
        adminId,
        adminName: admin.username,
      });
      if (!result.acquired) {
        return reply.code(409).send({
          error: 'ASSISTANT_HELD_BY_OTHER',
          ...leaseResponse(result.lease, adminId),
        });
      }
      try {
        await prisma.auditLog.create({
          data: {
            adminId,
            action: 'assistant_takeover',
            target: id,
            after: result.lease
              ? {
                  roomId: result.lease.roomId,
                  holderAdminId: result.lease.adminId,
                  holderName: result.lease.adminName,
                  takenAt: result.lease.takenAt,
                  expiresAt: result.lease.expiresAt,
                }
              : {},
            ip: req.ip,
          },
        });
      } catch (error) {
        await releaseAssistantLease({ roomId: id, adminId }).catch(() => undefined);
        throw error;
      }
      const payload = { type: 'assistant_lease', mode: 'ASSISTED', lease: result.lease };
      broadcastToRoomObservers(id, payload);
      return { ok: true, ...leaseResponse(result.lease, adminId) };
    },
  );

  app.post(
    '/api/admin/rooms/:id/assistant/force-takeover',
    { preHandler: [app.authAdmin, app.requireAdminRoles('SUPER')] },
    async (req, reply) => {
      const { id } = z.object({ id: resourceIdSchema }).parse(req.params);
      const adminId = (req.user as { sub: string }).sub;
      const [admin, room] = await Promise.all([
        prisma.admin.findUnique({
          where: { id: adminId },
          select: { username: true },
        }),
        supportedRoomById(id),
      ]);
      if (!room) return reply.code(404).send({ error: 'GAME_NOT_SUPPORTED' });
      if (!admin) return reply.code(401).send({ error: 'UNAUTHORIZED' });
      const result = await forceAcquireAssistantLease({
        roomId: id,
        adminId,
        adminName: admin.username,
      });
      try {
        await prisma.auditLog.create({
          data: {
            adminId,
            action: 'assistant_force_takeover',
            target: id,
            before: result.previous
              ? {
                  holderAdminId: result.previous.adminId,
                  holderName: result.previous.adminName,
                }
              : {},
            after: {
              roomId: result.lease.roomId,
              holderAdminId: result.lease.adminId,
              holderName: result.lease.adminName,
              takenAt: result.lease.takenAt,
              expiresAt: result.lease.expiresAt,
            },
            ip: req.ip,
          },
        });
      } catch (error) {
        await releaseAssistantLease({ roomId: id, adminId }).catch(() => undefined);
        throw error;
      }
      broadcastToRoomObservers(id, {
        type: 'assistant_lease',
        mode: 'ASSISTED',
        lease: result.lease,
      });
      return { ok: true, ...leaseResponse(result.lease, adminId) };
    },
  );

  app.post(
    '/api/admin/rooms/:id/assistant/heartbeat',
    { preHandler: operations },
    async (req, reply) => {
      const { id } = z.object({ id: resourceIdSchema }).parse(req.params);
      const adminId = (req.user as { sub: string }).sub;
      const lease = await heartbeatAssistantLease(id, adminId);
      if (!lease) return reply.code(409).send({ error: 'ASSISTANT_LEASE_LOST' });
      const payload = { type: 'assistant_lease', mode: 'ASSISTED', lease };
      broadcastToRoomObservers(id, payload);
      return { ok: true, ...leaseResponse(lease, adminId) };
    },
  );

  app.post(
    '/api/admin/rooms/:id/assistant/release',
    { preHandler: operations },
    async (req, reply) => {
      const { id } = z.object({ id: resourceIdSchema }).parse(req.params);
      const adminId = (req.user as { sub: string; role?: string }).sub;
      const role = (req.user as { role?: string }).role;
      const { force } = z.object({ force: z.boolean().default(false) }).parse(req.body ?? {});
      if (force && role !== 'SUPER') return reply.code(403).send({ error: 'FORBIDDEN' });
      const released = await releaseAssistantLease({ roomId: id, adminId, force });
      if (!released) return reply.code(409).send({ error: 'ASSISTANT_LEASE_NOT_OWNED' });
      await prisma.auditLog.create({
        data: {
          adminId,
          action: force ? 'assistant_force_release' : 'assistant_release',
          target: id,
          after: { force },
          ip: req.ip,
        },
      });
      broadcastToRoomObservers(id, { type: 'assistant_lease', mode: 'AUTO', lease: null });
      return { ok: true, ...leaseResponse(null, adminId) };
    },
  );

  app.post(
    '/api/admin/rooms/:id/assistant/messages',
    { preHandler: operations },
    async (req, reply) => {
      const { id } = z.object({ id: resourceIdSchema }).parse(req.params);
      const adminId = (req.user as { sub: string }).sub;
      if (!(await heartbeatAssistantLease(id, adminId))) {
        return reply.code(409).send({ error: 'ASSISTANT_LEASE_REQUIRED' });
      }
      const body = assistantMessageSchema.parse(req.body);
      const round = await currentRoundForRoom(id);
      await prisma.$transaction([
        prisma.auditLog.create({
          data: {
            adminId,
            action: body.kind === 'TEXT' ? 'assistant_say' : 'assistant_banner',
            target: id,
            after: { ...body, roundId: round?.id ?? null },
            ip: req.ip,
          },
        }),
        ...(round
          ? [
              prisma.roundEvent.create({
                data: {
                  roundId: round.id,
                  type: body.kind === 'TEXT' ? 'ASSIST_SAY' : 'ASSIST_BANNER',
                  actorId: adminId,
                  payload: body,
                },
              }),
            ]
          : []),
      ]);
      if (body.kind === 'TEXT') {
        systemChat(id, `【运营接管】${body.content}`, { force: true });
      } else {
        systemChat(id, `【运营接管】补充发送阶段横幅：${assistantBannerLabels[body.key]}`, {
          force: true,
        });
        systemBanner(id, body.key as AnnounceBanner, { force: true });
      }
      return { ok: true };
    },
  );

  app.post(
    '/api/admin/rooms/:id/assistant/replay',
    { preHandler: operations },
    async (req, reply) => {
      const { id } = z.object({ id: resourceIdSchema }).parse(req.params);
      const adminId = (req.user as { sub: string }).sub;
      if (!(await heartbeatAssistantLease(id, adminId))) {
        return reply.code(409).send({ error: 'ASSISTANT_LEASE_REQUIRED' });
      }
      const { roundId } = z.object({ roundId: resourceIdSchema }).parse(req.body);
      const round = await prisma.round.findFirst({
        where: {
          id: roundId,
          roomId: id,
          room: { gameCode: { in: SUPPORTED_GAME_CODES } },
        },
        select: { id: true, roomId: true, phase: true },
      });
      if (!round) {
        return reply.code(404).send({ error: 'ROUND_NOT_FOUND' });
      }
      if (round.phase === RoundPhase.FINISHED) {
        const latestFinished = await prisma.round.findFirst({
          where: { roomId: id, phase: RoundPhase.FINISHED },
          orderBy: { seqNo: 'desc' },
          select: { id: true },
        });
        if (latestFinished?.id !== round.id) {
          return reply.code(409).send({ error: 'REPLAY_ONLY_LATEST_RESULT' });
        }
      } else {
        const current = await currentRoundForRoom(id);
        if (!current || current.id !== round.id) {
          return reply.code(409).send({ error: 'REPLAY_ONLY_CURRENT_ROUND' });
        }
      }
      const messages = await buildRoundAnnounceMessages({
        roundId: round.id,
        to: round.phase,
      });
      await prisma.$transaction([
        prisma.auditLog.create({
          data: {
            adminId,
            action: 'assistant_replay',
            target: id,
            after: { roundId: round.id, phase: round.phase, count: messages.length },
            ip: req.ip,
          },
        }),
        prisma.roundEvent.create({
          data: {
            roundId: round.id,
            type: 'ASSIST_REPLAY',
            actorId: adminId,
            payload: { phase: round.phase, count: messages.length },
          },
        }),
      ]);
      for (const message of messages) {
        if (message.kind === 'banner') {
          systemBanner(id, message.banner, { force: true });
        } else if (message.kind === 'countdown') {
          systemCountdown(
            id,
            { mode: message.mode, endsAt: message.endsAt, template: message.template },
            { force: true },
          );
        } else if (message.content.trim()) {
          systemChat(id, `【运营重播】${message.content}`, { force: true });
        }
      }
      return { ok: true, count: messages.length };
    },
  );

  app.post(
    '/api/admin/rooms/:id/assistant/pin',
    { preHandler: operations },
    async (req, reply) => {
      const { id } = z.object({ id: resourceIdSchema }).parse(req.params);
      const adminId = (req.user as { sub: string }).sub;
      if (!(await heartbeatAssistantLease(id, adminId))) {
        return reply.code(409).send({ error: 'ASSISTANT_LEASE_REQUIRED' });
      }
      const body = assistantPinSchema.parse(req.body);
      const target = `ROOM:${id}`;
      const room = await supportedRoomById(id);
      if (!room) return reply.code(404).send({ error: 'GAME_NOT_SUPPORTED' });
      const item = await prisma.$transaction(async (tx) => {
        await tx.announcement.updateMany({
          where: { target, pinned: true, status: 'PUBLISHED' },
          data: { status: 'ARCHIVED', pinned: false },
        });
        const created = await tx.announcement.create({
          data: {
            ...body,
            target,
            pinned: true,
            status: 'PUBLISHED',
            publishedAt: new Date(),
            createdBy: adminId,
          },
        });
        await tx.auditLog.create({
          data: {
            adminId,
            action: 'assistant_pin',
            target: id,
            after: { announcementId: created.id, ...body },
            ip: req.ip,
          },
        });
        return created;
      });
      broadcastToRoom(id, { type: 'activity', kind: 'pin_updated' });
      return { ok: true, item };
    },
  );

  app.delete(
    '/api/admin/rooms/:id/assistant/pin',
    { preHandler: operations },
    async (req, reply) => {
      const { id } = z.object({ id: resourceIdSchema }).parse(req.params);
      const adminId = (req.user as { sub: string }).sub;
      if (!(await heartbeatAssistantLease(id, adminId))) {
        return reply.code(409).send({ error: 'ASSISTANT_LEASE_REQUIRED' });
      }
      const target = `ROOM:${id}`;
      const count = await prisma.$transaction(async (tx) => {
        const result = await tx.announcement.updateMany({
          where: { target, pinned: true, status: 'PUBLISHED' },
          data: { status: 'ARCHIVED', pinned: false },
        });
        await tx.auditLog.create({
          data: {
            adminId,
            action: 'assistant_unpin',
            target: id,
            after: { count: result.count },
            ip: req.ip,
          },
        });
        return result.count;
      });
      broadcastToRoom(id, { type: 'activity', kind: 'pin_updated' });
      return { ok: true, count };
    },
  );

  app.get('/api/admin/dashboard', { preHandler: [app.authAdmin] }, async () => {
    const dayStart = new Date(`${malaysiaDay()}T00:00:00+08:00`);
    const [
      pendingKyc,
      pendingDeposits,
      pendingWithdrawals,
      activeRounds,
      packetTransit,
      todaySettlements,
      todaySettleSum,
      todayPushFailures,
      reconcileAnomalies,
    ] = await Promise.all([
      prisma.kyc.count({ where: { status: 'PENDING' } }),
      prisma.depositOrder.count({ where: { status: 'PENDING' } }),
      prisma.withdrawOrder.count({ where: { status: 'PENDING' } }),
      prisma.round.count({
        where: {
          phase: {
            in: [
              'BANKER_BID',
              'BETTING',
              'SENDING_PACKET',
              'CLAIMING',
              'CLAIM_EXPIRED',
              'SETTLING',
            ],
          },
        },
      }),
      prisma.platformAccount.findUnique({ where: { accountType: 'TNG_TRANSIT' } }),
      prisma.round.count({ where: { phase: 'FINISHED', settledAt: { gte: dayStart } } }),
      prisma.settlement.aggregate({
        where: { createdAt: { gte: dayStart } },
        _sum: { betCents: true, rakeCents: true },
      }),
      prisma.pushLog.count({ where: { success: false, sentAt: { gte: dayStart } } }),
      prisma.packet.count({
        where: { status: 'EXPIRED', round: { phase: { in: ['FINISHED', 'CANCELLED'] } } },
      }),
    ]);
    return {
      pendingKyc,
      pendingDeposits,
      pendingWithdrawals,
      activeRounds,
      packetTransitCents: String(packetTransit?.balanceCents ?? 0n),
      todaySettlements,
      todayBetsCents: String(todaySettleSum._sum.betCents ?? 0n),
      todayRakeCents: String(todaySettleSum._sum.rakeCents ?? 0n),
      todayPushFailures,
      reconcileAnomalies,
    };
  });

  app.get('/api/admin/games/:gameCode/rules', { preHandler: roomObservers }, async (req) => {
    const { gameCode } = z
      .object({ gameCode: gameCodeSchema })
      .parse(req.params);
    return {
      gameCode,
      document: await getAdminGameRules(gameCode),
    };
  });

  app.put('/api/admin/games/:gameCode/rules', { preHandler: operations }, async (req) => {
    const { gameCode } = z
      .object({ gameCode: gameCodeSchema })
      .parse(req.params);
    const adminId = (req.user as { sub: string }).sub;
    const input = gameRuleDocumentInput.parse(req.body);
    const { before, document } = await saveGameRules(
      gameCode,
      input,
      adminId,
    );
    const changes = summarizeRuleChanges(before, document);
    await prisma.auditLog.create({
      data: {
        adminId,
        action:
          document.status === 'PUBLISHED'
            ? 'game_rules_publish'
            : 'game_rules_save_draft',
        target: `game:${gameCode}:rules`,
        before: before
          ? {
              title: before.title,
              summary: before.summary,
              sections: before.sections,
              status: before.status,
              version: before.version,
            }
          : undefined,
        after: {
          title: document.title,
          summary: document.summary,
          sections: document.sections,
          status: document.status,
          version: document.version,
          changes,
        },
        ip: req.ip,
      },
    });
    return { ok: true, gameCode, document, changes };
  });

  app.get('/api/admin/games', { preHandler: roomObservers }, async () => {
    const items = await listCatalogGames();
    const settingsByGame = new Map(
      await Promise.all(
        items.map(async (item) => [
          item.code,
          await getGameSettings(item.code),
        ] as const),
      ),
    );
    const defaultSettings = settingsByGame.get(SUPREME_NIUNIU_GAME_CODE);
    return {
      items: items.map((item) => {
        const settings = settingsByGame.get(item.code)!;
        return {
          ...item,
          botService: {
            assistantEnabled: settings.round.assistantEnabled !== false,
            autoStart: Boolean(settings.round.autoStart),
          },
          packetChannel: settings.round.packetChannel === 'INTERNAL' ? 'INTERNAL' : 'TNG',
          bankerBidMinCents: settings.round.bankerBidMinCents,
          bankerBidMaxCents: settings.round.bankerBidMaxCents,
        };
      }),
      botService: {
        assistantEnabled: defaultSettings?.round.assistantEnabled !== false,
        autoStart: Boolean(defaultSettings?.round.autoStart),
      },
    };
  });

  app.get('/api/admin/rooms', { preHandler: roomObservers }, async () => {
    const items = await prisma.room.findMany({
      where: { gameCode: { in: SUPPORTED_GAME_CODES } },
      include: {
        bot: { select: { id: true, name: true, username: true } },
        _count: { select: { members: true, rounds: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return {
      items: items.map((item) => {
        const game = gameDefinition(item.gameCode);
        return {
          ...item,
          title: game?.title ?? item.title,
          game: game ?? null,
        };
      }),
    };
  });

  /** 仅允许为目录中尚无互动群的游戏建群；禁止复制同游戏第二张牌桌。 */
  app.post('/api/admin/rooms', { preHandler: operations }, async (req, reply) => {
    const adminId = (req.user as { sub: string }).sub;
    const body = roomSchema.parse(req.body);
    const game = gameDefinition(body.gameCode);
    if (!game) return reply.code(400).send({ error: 'GAME_NOT_SUPPORTED' });
    const existingGame = await prisma.room.findUnique({
      where: { gameCode: body.gameCode },
      select: { id: true },
    });
    if (existingGame) {
      return reply.code(409).send({
        error: 'GAME_ALREADY_HAS_INTERACTION_GROUP',
        roomId: existingGame.id,
        message: `${game.title} 已有唯一互动群，不能再建同游戏群/牌桌`,
      });
    }
    if (body.botId) {
      const bot = await prisma.telegramBot.findUnique({ where: { id: body.botId } });
      if (!bot || bot.status !== 'ACTIVE') {
        return reply.code(400).send({ error: 'BOT_NOT_ACTIVE' });
      }
    }
    const room = await prisma.$transaction(async (tx) => {
      const created = await tx.room.create({
        data: {
          gameCode: body.gameCode,
          title: game.title,
          minPlayers: body.minPlayers,
          botId: body.botId,
          inviteLink: body.inviteLink,
          chatId: body.chatId ? BigInt(body.chatId) : null,
        },
      });
      await tx.auditLog.create({
        data: {
          adminId,
          action: 'game_interaction_group_create',
          target: created.id,
          after: {
            gameCode: body.gameCode,
            title: game.title,
            minPlayers: body.minPlayers,
          },
        },
      });
      return created;
    });
    await ensureWaitingRound(room.id);
    return { ok: true, id: room.id, game };
  });

  app.patch('/api/admin/rooms/:id', { preHandler: operations }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const adminId = (req.user as { sub: string }).sub;
    const body = roomUpdateSchema.parse(req.body);
    const existing = await supportedRoomById(id);
    if (!existing) return reply.code(404).send({ error: 'GAME_NOT_SUPPORTED' });
    if (body.botId) {
      const bot = await prisma.telegramBot.findUnique({ where: { id: body.botId } });
      if (!bot || bot.status !== 'ACTIVE') {
        return reply.code(400).send({ error: 'BOT_NOT_ACTIVE' });
      }
    }
    await prisma.$transaction([
      prisma.room.update({
        where: { id },
        data: {
          ...(body.minPlayers !== undefined ? { minPlayers: body.minPlayers } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          ...(body.inviteLink !== undefined ? { inviteLink: body.inviteLink } : {}),
          ...(body.botId !== undefined ? { botId: body.botId } : {}),
        },
      }),
      prisma.auditLog.create({
        data: {
          adminId,
          action: 'room_update',
          target: id,
          before: {
            title: existing.title,
            botId: existing.botId,
            minPlayers: existing.minPlayers,
            status: existing.status,
            inviteLink: existing.inviteLink,
          },
          after: body,
        },
      }),
    ]);
    return { ok: true };
  });

  app.get('/api/admin/rounds', { preHandler: roomObservers }, async (req) => {
    const adminRole = (req.user as { role?: string }).role;
    const canReadScoreboard = ['SUPER', 'OPERATOR', 'REVIEWER'].includes(
      adminRole ?? '',
    );
    const query = z
      .object({
        phase: z.nativeEnum(RoundPhase).optional(),
        roomId: resourceIdSchema.optional(),
        /** @deprecated 兼容旧客户端；优先使用 page/pageSize */
        limit: z.coerce.number().int().min(1).max(200).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(50).default(20),
      })
      .parse(req.query);
    const pageSize = query.limit ?? query.pageSize;
    const page = query.limit ? 1 : query.page;
    const where = {
      phase: query.phase,
      roomId: query.roomId,
      room: { gameCode: { in: [...SUPPORTED_GAME_CODES] } },
    };
    const activePhases: RoundPhase[] = [
      RoundPhase.WAITING,
      RoundPhase.BANKER_BID,
      RoundPhase.BETTING,
      RoundPhase.SENDING_PACKET,
      RoundPhase.CLAIMING,
      RoundPhase.CLAIM_EXPIRED,
      RoundPhase.SETTLING,
    ];
    const [total, items, activeCount] = await Promise.all([
      prisma.round.count({ where }),
      prisma.round.findMany({
        where,
        include: {
          room: { select: { title: true, gameCode: true } },
          packet: true,
          scoreboard: {
            select: {
              id: true,
              presentationRevision: true,
              presentationSyncStatus: true,
              presentationSyncError: true,
            },
          },
          _count: { select: { bids: true, bets: true, claims: true, settlements: true } },
        },
        orderBy: [{ seqNo: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      query.roomId
        ? prisma.round.count({
            where: {
              roomId: query.roomId,
              phase: { in: activePhases.filter((phase) => phase !== RoundPhase.WAITING) },
            },
          })
        : Promise.resolve(0),
    ]);
    const bankerIds = [
      ...new Set(items.map((item) => item.bankerId).filter((id): id is string => Boolean(id))),
    ];
    const bankers = bankerIds.length
      ? await prisma.user.findMany({
          where: { id: { in: bankerIds } },
          select: { id: true, uid: true, nickname: true },
        })
      : [];
    const bankerById = new Map(bankers.map((user) => [user.id, user]));
    return {
      items: items.map((item) => ({
        ...item,
        scoreboard: canReadScoreboard ? item.scoreboard : null,
        banker: item.bankerId ? bankerById.get(item.bankerId) ?? null : null,
        room: {
          ...item.room,
          title: gameDefinition(item.room.gameCode)?.title ?? item.room.title,
        },
      })),
      total,
      page,
      pageSize,
      hasActiveRound: activeCount > 0,
    };
  });

  app.get('/api/admin/rounds/:id', { preHandler: roomObservers }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const adminRole = (req.user as { role?: string }).role;
    const canReadScoreboard = ['SUPER', 'OPERATOR', 'REVIEWER'].includes(
      adminRole ?? '',
    );
    const round = await prisma.round.findFirst({
      where: {
        id,
        room: { gameCode: { in: SUPPORTED_GAME_CODES } },
      },
      include: {
        room: true,
        bids: { include: { user: { select: { uid: true, nickname: true } } } },
        bets: { include: { user: { select: { uid: true, nickname: true } } } },
        claims: { include: { user: { select: { uid: true, nickname: true } } } },
        packet: true,
        settlements: true,
        ...(canReadScoreboard ? { scoreboard: true } : {}),
        events: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!round) return reply.code(404).send({ error: 'ROUND_NOT_FOUND' });
    return {
      ...round,
      claims: round.claims.map((claim) => ({
        ...claim,
        tngName: claim.tngName ? safeDecryptSecret(claim.tngName) : null,
      })),
    };
  });

  app.get(
    '/api/admin/rounds/:id/scoreboard',
    { preHandler: scoreboardObservers },
    async (req, reply) => {
      const { id } = z.object({ id: resourceIdSchema }).parse(req.params);
      try {
        return { scoreboard: await getScoreboardPresentation(id) };
      } catch (error) {
        return scoreboardErrorReply(reply, error);
      }
    },
  );

  app.post(
    '/api/admin/rounds/:id/scoreboard/preview',
    { preHandler: operations },
    async (req, reply) => {
      const { id } = z.object({ id: resourceIdSchema }).parse(req.params);
      const { presentation } = z
        .object({ presentation: scoreboardPresentationInput })
        .strict()
        .parse(req.body);
      try {
        return await previewScoreboardPresentation(id, presentation);
      } catch (error) {
        return scoreboardErrorReply(reply, error);
      }
    },
  );

  app.patch(
    '/api/admin/rounds/:id/scoreboard',
    { preHandler: operations },
    async (req, reply) => {
      const { id } = z.object({ id: resourceIdSchema }).parse(req.params);
      const adminId = (req.user as { sub: string }).sub;
      const input = scoreboardPresentationMutationInput.parse(req.body);
      try {
        return {
          ok: true,
          scoreboard: await saveAndSyncScoreboardPresentation({
            roundId: id,
            adminId,
            ip: req.ip,
            input,
          }),
        };
      } catch (error) {
        return scoreboardErrorReply(reply, error);
      }
    },
  );

  app.post(
    '/api/admin/rounds/:id/scoreboard/sync',
    { preHandler: operations },
    async (req, reply) => {
      const { id } = z.object({ id: resourceIdSchema }).parse(req.params);
      const adminId = (req.user as { sub: string }).sub;
      try {
        const scoreboard = await syncScoreboardPresentation(id, adminId);
        await prisma.auditLog.create({
          data: {
            adminId,
            action: 'scoreboard_presentation_sync_retry',
            target: id,
            after: {
              revision: scoreboard.presentationRevision,
              syncStatus: scoreboard.presentationSyncStatus,
            },
            ip: req.ip,
          },
        });
        return { ok: true, scoreboard };
      } catch (error) {
        return scoreboardErrorReply(reply, error);
      }
    },
  );

  app.post(
    '/api/admin/rounds/:id/scoreboard/revisions/:revision/restore',
    { preHandler: operations },
    async (req, reply) => {
      const { id, revision } = z
        .object({
          id: resourceIdSchema,
          revision: z.coerce.number().int().min(0),
        })
        .parse(req.params);
      const body = z
        .object({
          expectedRevision: z.number().int().min(1),
          reason: z.string().trim().min(4).max(500),
        })
        .strict()
        .parse(req.body);
      const adminId = (req.user as { sub: string }).sub;
      try {
        return {
          ok: true,
          scoreboard: await restoreAndSyncScoreboardPresentation({
            roundId: id,
            revision,
            expectedRevision: body.expectedRevision,
            reason: body.reason,
            adminId,
            ip: req.ip,
          }),
        };
      } catch (error) {
        return scoreboardErrorReply(reply, error);
      }
    },
  );

  app.post('/api/admin/rooms/:id/start', { preHandler: operations }, async (req) => {
    const { id } = req.params as { id: string };
    const adminId = (req.user as { sub: string }).sub;
    const { force } = z.object({ force: z.boolean().default(true) }).parse(req.body ?? {});
    await requireSupportedRoom(id);
    const waiting = await ensureWaitingRound(id);
    const started = await startRound(waiting.id, force, adminId);
    await prisma.auditLog.create({
      data: {
        adminId,
        action: force ? 'round_force_start' : 'round_start',
        target: started.id,
        before: { phase: RoundPhase.WAITING },
        after: { roomId: id, phase: started.phase },
        ip: req.ip,
      },
    });
    emitTransition(started.id, started.roomId, RoundPhase.WAITING, started.phase);
    return { ok: true, round: started };
  });

  /** 暂停小助手：停止群内自动播报与自动开局，不关闭互动群入口。 */
  app.post('/api/admin/rooms/:id/end', { preHandler: operations }, async (req) => {
    const { id } = req.params as { id: string };
    const adminId = (req.user as { sub: string }).sub;
    const { reason } = z
      .object({ reason: z.string().trim().min(2).max(200).default('运营暂停小助手') })
      .parse(req.body ?? {});
    const room = await requireSupportedRoom(id);
    const result = await pauseAssistantService(id, reason, adminId);
    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'assistant_service_pause',
        target: id,
        before: {
          roomStatus: room.status,
          assistantEnabled: result.assistantEnabledBefore,
          autoStart: result.autoStartBefore,
        },
        after: {
          roomStatus: result.room.status,
          assistantEnabled: false,
          autoStart: false,
          reason,
        },
        ip: req.ip,
      },
    });
    systemChat(
      id,
      `【运营暂停小助手】群内自动播报与自动开局已关闭（入口仍开放）。原因：${reason}`,
      { force: true },
    );
    broadcastToRoomObservers(id, {
      type: 'bot_service',
      roomId: id,
      assistantEnabled: false,
      autoStart: false,
      roomStatus: result.room.status,
    });
    return {
      ok: true,
      room: { id: result.room.id, status: result.room.status },
      botService: { assistantEnabled: false, autoStart: false },
    };
  });

  /** 开启小助手播报（默认不打开自动开局）。 */
  app.post('/api/admin/rooms/:id/resume-bot', { preHandler: operations }, async (req) => {
    const { id } = req.params as { id: string };
    const adminId = (req.user as { sub: string }).sub;
    await requireSupportedRoom(id);
    const result = await resumeBotService(id, adminId);
    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'assistant_service_resume',
        target: id,
        before: {
          assistantEnabled: result.assistantEnabledBefore,
          autoStart: result.autoStartBefore,
        },
        after: {
          assistantEnabled: result.assistantEnabled,
          autoStart: result.autoStart,
        },
        ip: req.ip,
      },
    });
    systemChat(id, '【运营恢复】小助手播报已开启。自动开局仍关闭，请手动开局或打开自动开局。', {
      force: true,
    });
    broadcastToRoomObservers(id, {
      type: 'bot_service',
      roomId: id,
      assistantEnabled: true,
      autoStart: false,
    });
    return {
      ok: true,
      botService: { assistantEnabled: true, autoStart: false },
    };
  });

  /** 开关自动开局（需小助手已开启）。 */
  app.post('/api/admin/rooms/:id/auto-start', { preHandler: operations }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const adminId = (req.user as { sub: string }).sub;
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body ?? {});
    const room = await requireSupportedRoom(id);
    const settings = await getGameSettings(room.gameCode);
    if (enabled && settings.round.assistantEnabled === false) {
      return reply.code(409).send({
        error: 'ASSISTANT_DISABLED',
        message: '请先开启小助手，再打开自动开局',
      });
    }
    const next = await setAssistantService(room.gameCode, { autoStart: enabled }, adminId);
    await prisma.auditLog.create({
      data: {
        adminId,
        action: enabled ? 'auto_start_enable' : 'auto_start_disable',
        target: id,
        after: { autoStart: next.autoStart, assistantEnabled: next.assistantEnabled },
        ip: req.ip,
      },
    });
    broadcastToRoomObservers(id, {
      type: 'bot_service',
      roomId: id,
      assistantEnabled: next.assistantEnabled !== false,
      autoStart: Boolean(next.autoStart),
    });
    return {
      ok: true,
      botService: {
        assistantEnabled: next.assistantEnabled !== false,
        autoStart: Boolean(next.autoStart),
      },
    };
  });

  app.post('/api/admin/rounds/:id/action', { preHandler: operations }, async (req) => {
    const { id } = req.params as { id: string };
    const adminId = (req.user as { sub: string }).sub;
    const body = actionSchema.parse(req.body);
    const before = await requireSupportedRound(id);
    let result: { phase?: RoundPhase };
    if (body.action === 'start') result = await startRound(id, body.force, adminId);
    else if (body.action === 'close_bidding') {
      if (before.phase !== RoundPhase.BANKER_BID) throw new GameError('INVALID_PHASE');
      await prisma.round.updateMany({
        where: { id, phase: RoundPhase.BANKER_BID },
        data: { bidEndsAt: new Date() },
      });
      result = { phase: RoundPhase.BANKER_BID };
    }
    else if (body.action === 'close_betting') {
      await ensureRoundAnnouncement({
        roundId: id,
        roomId: before.roomId,
        to: RoundPhase.BETTING,
      });
      result = await closeBetting(id);
    }
    else if (body.action === 'settle') {
      // 资金入账与 FINISHED 是主事务；奖励/审计/广播失败不得让客户端以为结算未成功。
      await settleGameRound(id, adminId);
      result = { phase: RoundPhase.FINISHED };
    } else {
      result = await cancelRound(id, body.reason, adminId);
    }
    const nextPhase = result.phase ?? before.phase;
    const warnings: string[] = [];
    try {
      await prisma.auditLog.create({
        data: {
          adminId,
          action: `round_${body.action}`,
          target: id,
          before: { phase: before.phase },
          after: {
            phase: nextPhase,
            ...('reason' in body ? { reason: body.reason } : {}),
          },
          ip: req.ip,
        },
      });
    } catch {
      warnings.push('AUDIT_FAILED');
    }
    let transitionReady = true;
    if (nextPhase === RoundPhase.FINISHED || nextPhase === RoundPhase.CANCELLED) {
      try {
        await ensureWaitingRound(before.roomId);
      } catch {
        warnings.push('NEXT_ROUND_FAILED');
        transitionReady = false;
        recoverNextRoundThenEmit({
          roundId: id,
          roomId: before.roomId,
          from: before.phase,
          to: nextPhase,
        });
      }
    }
    if (transitionReady) {
      try {
        // FINISHED 广播会触发客户端刷新和虚拟庄家续庄，必须先让紧邻 WAITING 局可见。
        emitTransition(id, before.roomId, before.phase, nextPhase);
      } catch {
        warnings.push('BROADCAST_FAILED');
      }
    }
    if (body.action === 'settle') {
      try {
        await processRoundRewards(id);
      } catch {
        warnings.push('REWARDS_FAILED');
      }
    }
    return { ok: true, result, warnings };
  });

  app.post('/api/admin/rounds/:id/packet', { preHandler: operations }, async (req) => {
    const { id } = req.params as { id: string };
    const adminId = (req.user as { sub: string }).sub;
    const body = z
      .object({
        // 允许粘贴带前后文案的链接；具体域名/路径由 publishPacket 校验与归一化
        claimUrl: z.string().min(12).max(2_000),
        packerAccount: idSchema,
      })
      .parse(req.body);
    const round = await requireSupportedRound(id);
    const packet = await publishPacket({ roundId: id, ...body, actorId: adminId });
    await appendGamePacketMessage(round.roomId, {
      packetId: packet.id,
      roundId: id,
    });
    await refreshUnannouncedClaimDeadline(id);
    await ensureRoundAnnouncement({
      roundId: id,
      roomId: round.roomId,
      to: RoundPhase.CLAIMING,
    });
    emitTransition(id, round.roomId, round.phase, RoundPhase.CLAIMING);
    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'packet_publish',
        target: packet.id,
        after: {
          roundId: id,
          packerAccount: body.packerAccount,
          claimUrlHost: new URL(body.claimUrl).host,
        },
        ip: req.ip,
      },
    });
    return { ok: true, packet };
  });

  /** 本局改用小助手直发内部红包（不依赖发包方式配置，运营可临时切换） */
  app.post(
    '/api/admin/rounds/:id/packet/internal',
    { preHandler: operations },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const adminId = (req.user as { sub: string }).sub;
      const round = await requireSupportedRound(id);
      let packet;
      try {
        packet = await publishInternalPacket({ roundId: id, actorId: adminId });
      } catch (error) {
        if (error instanceof GameError && error.code === 'BANKER_DICE_NOT_READY') {
          return reply.code(409).send({
            error: 'BANKER_DICE_NOT_READY',
            message: '庄家还未完成投骰，投骰后才能发包',
          });
        }
        throw error;
      }
      await appendGamePacketMessage(round.roomId, {
        packetId: packet.id,
        roundId: id,
      });
      await refreshUnannouncedClaimDeadline(id);
      await ensureRoundAnnouncement({
        roundId: id,
        roomId: round.roomId,
        to: RoundPhase.CLAIMING,
      });
      emitTransition(id, round.roomId, round.phase, RoundPhase.CLAIMING);
      await prisma.auditLog.create({
        data: {
          adminId,
          action: 'packet_publish_internal',
          target: packet.id,
          after: { roundId: id, channel: 'INTERNAL' },
          ip: req.ip,
        },
      });
      return { ok: true, packet };
    },
  );

  /** 切换发包方式（TNG 链接 / 小助手直发）；进行中的牌局沿用原快照，下一局生效 */
  app.post(
    '/api/admin/rooms/:id/packet-channel',
    { preHandler: operations },
    async (req) => {
      const { id } = req.params as { id: string };
      const adminId = (req.user as { sub: string }).sub;
      const { channel } = z
        .object({ channel: z.enum(['TNG', 'INTERNAL']) })
        .parse(req.body ?? {});
      const room = await requireSupportedRoom(id);
      const next = await setPacketChannel(room.gameCode, channel, adminId);
      await prisma.auditLog.create({
        data: {
          adminId,
          action: 'packet_channel_switch',
          target: id,
          after: { gameCode: room.gameCode, packetChannel: next.packetChannel },
          ip: req.ip,
        },
      });
      return { ok: true, packetChannel: next.packetChannel };
    },
  );

  /** 设定上庄起拍价；进行中的牌局沿用原快照，下一局生效 */
  app.post(
    '/api/admin/rooms/:id/banker-bid-min',
    { preHandler: operations },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const adminId = (req.user as { sub: string }).sub;
      const { bankerBidMinCents } = z
        .object({
          bankerBidMinCents: z.number().int().min(1).max(1_000_000_000),
        })
        .parse(req.body ?? {});
      const room = await requireSupportedRoom(id);
      try {
        const next = await setBankerBidMin(room.gameCode, bankerBidMinCents, adminId);
        await prisma.auditLog.create({
          data: {
            adminId,
            action: 'banker_bid_min_update',
            target: id,
            after: { gameCode: room.gameCode, bankerBidMinCents: next.bankerBidMinCents },
            ip: req.ip,
          },
        });
        return { ok: true, bankerBidMinCents: next.bankerBidMinCents };
      } catch (error) {
        if (error instanceof Error && error.message === 'BANKER_BID_MIN_ABOVE_MAX') {
          return reply.code(400).send({
            error: 'BANKER_BID_MIN_ABOVE_MAX',
            message: '起拍价不能高于最高出价，请先在规则与配置里调高上限',
          });
        }
        throw error;
      }
    },
  );

  app.get('/api/admin/claims/candidates', { preHandler: operations }, async (req) => {
    const { name } = z.object({ name: z.string().min(2).max(100) }).parse(req.query);
    return { items: await claimCandidates(name) };
  });

  app.post('/api/admin/rounds/:id/claims', { preHandler: operations }, async (req) => {
    const { id } = req.params as { id: string };
    const adminId = (req.user as { sub: string }).sub;
    const body = z
      .object({
        userId: idSchema,
        amountCents: amountSchema,
        tngName: z.string().min(2).max(100),
        forceMatch: z.boolean().default(false),
        matchOverrideReason: z.string().min(4).max(500).optional(),
      })
      .refine((value) => !value.forceMatch || !!value.matchOverrideReason, {
        message: '强制匹配必须填写原因',
        path: ['matchOverrideReason'],
      })
      .parse(req.body);
    await requireSupportedRound(id);
    const result = await recordClaim({
      roundId: id,
      userId: body.userId,
      amountCents: BigInt(body.amountCents),
      tngName: body.tngName,
      forceMatch: body.forceMatch,
      matchOverrideReason: body.matchOverrideReason,
      enteredBy: adminId,
    });
    await prisma.auditLog.create({
      data: {
        adminId,
        action: body.forceMatch ? 'claim_force_match' : 'claim_record',
        target: result.claim.id,
        after: {
          roundId: id,
          userId: body.userId,
          amountCents: body.amountCents,
          ...(body.matchOverrideReason ? { reason: body.matchOverrideReason } : {}),
        },
        ip: req.ip,
      },
    });
    gameBus.claimRecorded({
      roundId: id,
      userId: body.userId,
      amountCents: body.amountCents,
    });
    return { ok: true, complete: result.complete, settled: false, claim: result.claim };
  });

  app.post('/api/admin/rounds/:id/forfeit', { preHandler: operations }, async (req) => {
    const { id } = req.params as { id: string };
    const adminId = (req.user as { sub: string }).sub;
    const { userId } = z.object({ userId: idSchema }).parse(req.body);
    await requireSupportedRound(id);
    await forfeitMissingPlayer(id, userId, adminId);
    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'claim_forfeit_player',
        target: id,
        after: { userId },
        ip: req.ip,
      },
    });
    return { ok: true };
  });

  app.post('/api/admin/claims/:id/correct', { preHandler: operations }, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const adminId = (req.user as { sub: string }).sub;
    const body = z
      .object({
        amountCents: amountSchema,
        tngName: z.string().min(2).max(100),
        reason: z.string().min(4).max(500),
        forceMatch: z.boolean().default(false),
      })
      .parse(req.body);
    const result = await correctClaim({
      claimId: id,
      amountCents: BigInt(body.amountCents),
      tngName: body.tngName,
      reason: body.reason,
      forceMatch: body.forceMatch,
      enteredBy: adminId,
    });
    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'claim_correct',
        target: id,
        before: { amountCents: String(result.before.amountCents) },
        after: {
          amountCents: String(result.claim.amountCents),
          reason: body.reason,
          forceMatch: body.forceMatch,
        },
        ip: req.ip,
      },
    });
    gameBus.claimRecorded({
      roundId: result.claim.roundId,
      userId: result.claim.userId,
      amountCents: String(result.claim.amountCents),
    });
    return { ok: true, claim: result.claim };
  });

  app.post(
    '/api/admin/packets/:id/reconcile-return',
    { preHandler: [app.authAdmin, app.requireAdminRoles('SUPER', 'FINANCE')] },
    async (req) => {
      const { id } = z.object({ id: idSchema }).parse(req.params);
      const { returnedCents } = z
        .object({ returnedCents: z.string().regex(/^\d+$/) })
        .parse(req.body);
      const adminId = (req.user as { sub: string }).sub;
      const packet = await reconcilePacketReturn(id, BigInt(returnedCents), adminId);
      await prisma.auditLog.create({
        data: {
          adminId,
          action: 'PACKET_RETURN_RECONCILE',
          target: id,
          after: { returnedCents },
        },
      });
      return { ok: true, packet };
    },
  );

  app.post(
    '/api/admin/packets/:id/reconcile-cancelled',
    { preHandler: [app.authAdmin, app.requireAdminRoles('SUPER', 'FINANCE')] },
    async (req) => {
      const { id } = z.object({ id: idSchema }).parse(req.params);
      const body = z
        .object({
          claimedCents: z.string().regex(/^\d+$/),
          returnedCents: z.string().regex(/^\d+$/),
        })
        .parse(req.body);
      const adminId = (req.user as { sub: string }).sub;
      const packet = await reconcileCancelledPacket(
        id,
        BigInt(body.claimedCents),
        BigInt(body.returnedCents),
        adminId,
      );
      await prisma.auditLog.create({
        data: {
          adminId,
          action: 'CANCELLED_PACKET_RECONCILE',
          target: id,
          after: body,
          ip: req.ip,
        },
      });
      return { ok: true, packet };
    },
  );

  app.get(
    '/api/admin/finance/accounts',
    { preHandler: [app.authAdmin, app.requireAdminRoles('SUPER', 'FINANCE')] },
    async () => {
      const [accounts, recentLedger] = await Promise.all([
        prisma.platformAccount.findMany({ orderBy: { accountType: 'asc' } }),
        prisma.ledgerEntry.findMany({
          where: { userId: null },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
      ]);
      return { accounts, recentLedger };
    },
  );

  // 财务日报：抽水 / 三费 / 充提 / 奖励返水支出 / 备付与在途（03 文档 §3.11）
  app.get(
    '/api/admin/finance/daily-report',
    { preHandler: [app.authAdmin, app.requireAdminRoles('SUPER', 'FINANCE')] },
    async (req) => {
      const { date } = z
        .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(malaysiaDay()) })
        .parse(req.query);
      const from = new Date(`${date}T00:00:00+08:00`);
      const until = new Date(from.getTime() + 86_400_000);
      const window = { gte: from, lt: until };

      const platformCredit = (accountType: 'PLATFORM_RAKE' | 'PLATFORM_FEES' | 'PLATFORM_RESERVE', refTypes?: string[]) =>
        prisma.ledgerEntry.aggregate({
          where: {
            accountType,
            direction: 'CREDIT',
            userId: null,
            createdAt: window,
            ...(refTypes ? { refType: { in: refTypes } } : {}),
          },
          _sum: { amountCents: true },
        });
      const platformDebit = (
        accountType: 'PLATFORM_REWARD' | 'PLATFORM_REBATE' | 'PLATFORM_PROFIT_POOL',
      ) =>
        prisma.ledgerEntry.aggregate({
          where: { accountType, direction: 'DEBIT', userId: null, createdAt: window },
          _sum: { amountCents: true },
        });

      const [
        settleSum,
        rakePlayerSum,
        rakeBankerSum,
        rakeLedger,
        seatFees,
        serviceFees,
        packetFees,
        rewardsPaid,
        rebatesPaid,
        profitSharesPaid,
        deposits,
        withdrawals,
        settledRounds,
        cancelledRounds,
        accounts,
        pendingPackets,
      ] = await Promise.all([
        prisma.settlement.aggregate({
          where: { createdAt: window },
          _sum: { betCents: true, rakeCents: true, paidCents: true, shortfallCents: true },
        }),
        prisma.settlement.aggregate({
          where: { createdAt: window, outcome: 'PLAYER_WIN' },
          _sum: { rakeCents: true },
        }),
        prisma.settlement.aggregate({
          where: { createdAt: window, outcome: 'BANKER_WIN' },
          _sum: { rakeCents: true },
        }),
        platformCredit('PLATFORM_RAKE'),
        platformCredit('PLATFORM_FEES', ['fee_banker_seat']),
        platformCredit('PLATFORM_FEES', ['fee_service']),
        platformCredit('PLATFORM_RESERVE', ['fee_packet_agent']),
        platformDebit('PLATFORM_REWARD'),
        platformDebit('PLATFORM_REBATE'),
        platformDebit('PLATFORM_PROFIT_POOL'),
        prisma.depositOrder.aggregate({
          where: { status: 'COMPLETED', reviewedAt: window },
          _sum: { amountCents: true },
          _count: { _all: true },
        }),
        prisma.withdrawOrder.aggregate({
          where: { status: 'COMPLETED', reviewedAt: window },
          _sum: { amountCents: true },
          _count: { _all: true },
        }),
        prisma.round.count({ where: { phase: 'FINISHED', settledAt: window } }),
        prisma.round.count({ where: { phase: 'CANCELLED', finishedAt: window } }),
        prisma.platformAccount.findMany(),
        prisma.packet.findMany({
          where: { status: 'EXPIRED', round: { phase: { in: ['FINISHED', 'CANCELLED'] } } },
          select: { totalCents: true, reconciledCents: true, returnedCents: true },
        }),
      ]);

      const outstandingCents = pendingPackets.reduce(
        (sum, packet) =>
          sum + (packet.totalCents - packet.reconciledCents - packet.returnedCents),
        0n,
      );
      const balances = Object.fromEntries(
        accounts.map((account) => [account.accountType, String(account.balanceCents)]),
      );
      // 平台当日净利（现金口径）= 抽水 + 上庄费 + 服务费 − 奖励 − 返水 − 代理分成
      // 代包费与红包备付（PLATFORM_RESERVE）勾稽，不计入净利。
      const netProfitCents =
        (rakeLedger._sum.amountCents ?? 0n) +
        (seatFees._sum.amountCents ?? 0n) +
        (serviceFees._sum.amountCents ?? 0n) -
        (rewardsPaid._sum.amountCents ?? 0n) -
        (rebatesPaid._sum.amountCents ?? 0n) -
        (profitSharesPaid._sum.amountCents ?? 0n);
      return {
        date,
        settledRounds,
        cancelledRounds,
        betsCents: String(settleSum._sum.betCents ?? 0n),
        payoutsCents: String(settleSum._sum.paidCents ?? 0n),
        shortfallCents: String(settleSum._sum.shortfallCents ?? 0n),
        rakeCents: String(rakeLedger._sum.amountCents ?? 0n),
        rakePlayerCents: String(rakePlayerSum._sum.rakeCents ?? 0n),
        rakeBankerCents: String(rakeBankerSum._sum.rakeCents ?? 0n),
        seatFeeCents: String(seatFees._sum.amountCents ?? 0n),
        serviceFeeCents: String(serviceFees._sum.amountCents ?? 0n),
        packetFeeCents: String(packetFees._sum.amountCents ?? 0n),
        rewardsPaidCents: String(rewardsPaid._sum.amountCents ?? 0n),
        rebatesPaidCents: String(rebatesPaid._sum.amountCents ?? 0n),
        profitSharesPaidCents: String(profitSharesPaid._sum.amountCents ?? 0n),
        netProfitCents: String(netProfitCents),
        depositsCents: String(deposits._sum.amountCents ?? 0n),
        depositsCount: deposits._count._all,
        withdrawalsCents: String(withdrawals._sum.amountCents ?? 0n),
        withdrawalsCount: withdrawals._count._all,
        packetOutstandingCents: String(outstandingCents),
        packetOutstandingCount: pendingPackets.length,
        accountBalances: balances,
      };
    },
  );

  app.get(
    '/api/admin/tng/reconciliation',
    { preHandler: [app.authAdmin, app.requireAdminRoles('SUPER', 'FINANCE', 'OPERATOR')] },
    async (req) => {
      const { status } = z
        .object({
          status: z.enum(['CREATED', 'SENT', 'EXPIRED', 'CANCELLED', 'RECONCILED']).optional(),
        })
        .parse(req.query);
      const items = await prisma.packet.findMany({
        where: { status },
        include: {
          round: {
            select: {
              seqNo: true,
              phase: true,
              room: { select: { title: true } },
            },
          },
          claims: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      return { items };
    },
  );
}

export { GameError };
