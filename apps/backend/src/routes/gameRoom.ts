/**
 * 网页游戏房（Mini App 内对局）：
 * - HTTP：进房/离房/房间状态/竞标/下注/撤回/续庄
 * - WebSocket：阶段变化推送、房内聊天、在线人数
 * 对局判定与账务全部复用 services/game.ts，本文件只做传输层。
 */
import { BetStatus, RoundPhase } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { bankerContinuationError } from '../engine/bankerContinuation.js';
import { bettingRange, toCentsBigInt } from '../engine/betting.js';
import { prisma } from '../lib/prisma.js';
import {
  canClaimPacket,
  continueBanker,
  currentRoundPhaseForRoom,
  currentRoundForRoom,
  GameError,
  joinRoom,
  leaveRoom,
  placeBankerBid,
  placeBet,
  touchRoomPresence,
  withdrawBet,
} from '../services/game.js';
import { announceBidPlaced } from '../services/bidAuction.js';
import {
  confirmedChatGameAction,
  handleRoomChatCommand,
  isRoomCommandCandidate,
  isChatMuted,
  privateBetConfirmationFor,
  runBankerDiceCeremony,
} from '../services/chatCommands.js';
import {
  claimGroupPacket,
  groupPacketDetail,
  pickTipMessage,
  sendGroupPacket,
  tipSupport,
} from '../services/groupPacket.js';
import { gameBus } from '../services/gameBus.js';
import { getGameSettings, parseSettingsSnapshot } from '../services/gameSettings.js';
import { scheduleVirtualGroupPacketClaims } from '../services/virtualPlayerWorker.js';
import {
  gameDefinition,
  SUPPORTED_GAME_CODES,
} from '../services/gameCatalog.js';
import {
  addClient,
  appendChat,
  appendChatOnce,
  broadcastToRoomCluster,
  onlineCount,
  removeClient,
  type RoomClient,
} from '../services/roomHub.js';

const amountSchema = z.object({
  amount: z
    .string()
    .max(32, '金额过大')
    .regex(/^\d+(\.\d{1,2})?$/, '金额格式不正确'),
});
const tipSchema = amountSchema.extend({
  requestId: z.string().uuid(),
  paymentPin: z.string().regex(/^\d{6}$/),
});
const WS_SESSION_REVALIDATE_MS = 15_000;
const WS_MESSAGE_RATE_WINDOW_MS = 5_000;
const WS_MESSAGE_RATE_LIMIT = 12;
const WS_MESSAGE_QUEUE_LIMIT = 20;
const WS_MESSAGE_MAX_BYTES = 4 * 1024;

function validSocketRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)
    ? value
    : undefined;
}

function parseAmountCents(amount: string): bigint {
  try {
    return toCentsBigInt(amount);
  } catch (error) {
    throw new GameError(
      error instanceof Error && error.message === 'AMOUNT_TOO_LARGE'
        ? 'AMOUNT_TOO_LARGE'
        : 'INVALID_AMOUNT',
    );
  }
}

async function eligiblePlayerCount(roomId: string): Promise<number> {
  return prisma.roomMember.count({
    where: {
      roomId,
      status: 'ACTIVE',
      user: { status: 'ACTIVE', kyc: { status: 'APPROVED' } },
    },
  });
}

async function buildRoomState(roomId: string, userId: string) {
  const [room, member] = await Promise.all([
    prisma.room.findFirst({
      where: {
        id: roomId,
        gameCode: { in: SUPPORTED_GAME_CODES },
      },
      include: { _count: { select: { members: { where: { status: 'ACTIVE' } } } } },
    }),
    prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    }),
  ]);
  if (!room) throw new GameError('ROOM_NOT_FOUND');

  const round = await currentRoundForRoom(roomId);

  const frozenBets = (round?.bets ?? []).filter((bet) => bet.status === BetStatus.FROZEN);
  const myBid = round?.bids.find((bid) => bid.userId === userId) ?? null;
  const myBet = frozenBets.find((bet) => bet.userId === userId) ?? null;
  const myClaim = round?.claims.find((claim) => claim.userId === userId) ?? null;
  const now = new Date();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1_000);

  const [
    settings,
    bankerRow,
    eligiblePlayers,
    claimable,
    diceEvents,
    lastFinished,
    pins,
    playedRounds24h,
  ] = await Promise.all([
    Promise.resolve(
      round?.configSnapshot
        ? parseSettingsSnapshot(round.configSnapshot)
        : getGameSettings(room.gameCode),
    ),
    round?.bankerId
      ? prisma.user.findUnique({
          where: { id: round.bankerId },
          select: { uid: true, nickname: true, avatarUrl: true },
        })
      : Promise.resolve(null),
    round?.phase === RoundPhase.BETTING
      ? eligiblePlayerCount(roomId)
      : Promise.resolve(null),
    round?.packet && round.phase === RoundPhase.CLAIMING && !myClaim
      ? canClaimPacket(round.packet.id, userId)
      : Promise.resolve(false),
    round?.phase === RoundPhase.SENDING_PACKET
      ? prisma.roundEvent.findMany({
          where: {
            roundId: round.id,
            type: {
              in: [
                'BANKER_DICE',
                'BANKER_REPOST_WINDOW',
                'BANKER_DICE_READY_FOR_PACKET',
              ],
            },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { type: true, payload: true, createdAt: true },
        })
      : Promise.resolve([]),
    prisma.round.findFirst({
      where: { roomId, phase: RoundPhase.FINISHED },
      orderBy: { seqNo: 'desc' },
      include: { scoreboard: true },
    }),
    prisma.announcement.findMany({
      where: {
        status: 'PUBLISHED',
        pinned: true,
        target: { in: ['ALL', `ROOM:${roomId}`] },
        OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }],
      },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      take: 7,
      select: { id: true, title: true, body: true },
    }),
    prisma.claim.count({
      where: { userId, createdAt: { gte: since24h } },
    }),
  ]);

  const banker: { uid: string; nickname: string; avatarUrl: string | null } | null =
    bankerRow
      ? {
          uid: bankerRow.uid,
          nickname: bankerRow.nickname ?? bankerRow.uid,
          avatarUrl: bankerRow.avatarUrl,
        }
      : null;
  const betRange =
    round?.phase === RoundPhase.BETTING && eligiblePlayers !== null
      ? bettingRange(
          Number(round.potCents),
          Math.max(1, eligiblePlayers),
          settings.betting,
        )
      : null;
  const topBids = (round?.bids ?? [])
    .slice()
    .sort((a, b) => (a.amountCents === b.amountCents ? 0 : a.amountCents > b.amountCents ? -1 : 1))
    .slice(0, 3)
    .map((bid) => ({
      uid: bid.user.uid,
      nickname: bid.user.nickname,
      avatarUrl: bid.user.avatarUrl,
      amountCents: String(bid.amountCents),
    }));

  const canClaim = Boolean(claimable) && !myClaim;
  const diceThrown = diceEvents.some(
    (event) => event.type === 'BANKER_DICE_READY_FOR_PACKET',
  );
  const latestDiceEvent = diceEvents
    .filter((event) => event.type === 'BANKER_DICE')
    .at(-1);
  const repostWindowEvent = diceEvents.find(
    (event) => event.type === 'BANKER_REPOST_WINDOW',
  );
  const repostWindowPayload =
    repostWindowEvent?.payload
    && typeof repostWindowEvent.payload === 'object'
    && !Array.isArray(repostWindowEvent.payload)
      ? repostWindowEvent.payload as { endsAt?: unknown }
      : null;
  const repostEndsAt =
    typeof repostWindowPayload?.endsAt === 'string'
      ? repostWindowPayload.endsAt
      : null;
  const diceStarted = !!latestDiceEvent;
  const canRepostRound =
    !diceThrown
    && !diceStarted
    && !!repostEndsAt
    && new Date(repostEndsAt).getTime() > now.getTime();

  let continuation: { previousRoundId: string; mine: boolean; deadline: string } | null = null;
  if (lastFinished?.bankerId && lastFinished.configSnapshot && round) {
    const windowSettings = parseSettingsSnapshot(lastFinished.configSnapshot);
    const eligibilityError = bankerContinuationError({
      previous: lastFinished,
      next: round,
      userId: lastFinished.bankerId,
      windowSeconds: windowSettings.round.continuationWindowSeconds,
    });
    if (!eligibilityError && lastFinished.finishedAt) {
      const deadline =
        lastFinished.finishedAt.getTime() +
        windowSettings.round.continuationWindowSeconds * 1_000;
      continuation = {
        previousRoundId: lastFinished.id,
        mine: lastFinished.bankerId === userId,
        deadline: new Date(deadline).toISOString(),
      };
    }
  }

  return {
    room: {
      id: room.id,
      gameCode: room.gameCode,
      title: gameDefinition(room.gameCode)?.title ?? room.title,
      interactionGroupTitle:
        gameDefinition(room.gameCode)?.interactionGroupTitle ?? room.title,
      status: room.status,
      minPlayers: room.minPlayers,
      members: room._count.members,
      online: onlineCount(room.id),
    },
    me: {
      joined: member?.status === 'ACTIVE',
      isBanker: !!round?.bankerId && round.bankerId === userId,
      bidCents: myBid ? String(myBid.amountCents) : null,
      bet: myBet
        ? {
            amountCents: String(myBet.amountCents),
            reservedCents: String(myBet.reservedCents || myBet.amountCents),
            isAllIn: myBet.isAllIn,
          }
        : null,
      canClaim,
      claimedAmountCents: myClaim ? String(myClaim.amountCents) : null,
      playedRounds24h,
    },
    round: round
      ? {
          id: round.id,
          seqNo: round.seqNo,
          phase: round.phase,
          potCents: String(round.potCents),
          bidEndsAt: round.bidEndsAt,
          betEndsAt: round.betEndsAt,
          claimEndsAt: round.claimEndsAt,
          banker,
          topBids,
          bidCount: round.bids.length,
          bets: frozenBets.map((bet) => ({
            uid: bet.user.uid,
            nickname: bet.user.nickname,
            avatarUrl: bet.user.avatarUrl,
            amountCents: String(bet.amountCents),
            isAllIn: bet.isAllIn,
          })),
          claimedCount: round.claims.length,
          diceThrown,
          diceStarted,
          repostEndsAt,
          canRepostRound,
          participantCount: round.packet?.participantCount ?? null,
          /** 发包完成后才暴露，前端据此弹出可领红包：TNG 需有链接，内部红包直接可领 */
          packetId:
            round.packet?.status === 'SENT' &&
            (round.packet.claimUrl || round.packet.channel === 'INTERNAL')
              ? round.packet.id
              : null,
          packetChannel: round.packet?.channel ?? 'TNG',
          packetTotalCents:
            round.packet?.status === 'SENT'
              ? String(round.packet.totalCents)
              : null,
          claims: round.claims.map((claim) => ({
            uid: claim.user.uid,
            nickname: claim.user.nickname,
            avatarUrl: claim.user.avatarUrl,
            amountCents: String(claim.amountCents),
            source: claim.source,
            isBanker: !!round.bankerId && claim.userId === round.bankerId,
            isTail: claim.source === 'AUTO_TAIL',
            at: claim.confirmedAt ?? claim.createdAt,
          })),
          betRange: betRange
            ? {
                betMinCents: betRange.betMinCents,
                betMaxCents: betRange.betMaxCents,
                shMinCents: betRange.shMinCents,
                shMaxCents: betRange.shMaxCents,
              }
            : null,
        }
      : null,
    lastScoreboard: lastFinished?.scoreboard
      ? {
          seqNo: lastFinished.scoreboard.seqNo,
          playerLines: lastFinished.scoreboard.playerLines,
          bankerSummary: lastFinished.scoreboard.bankerSummary,
        }
      : null,
    continuation,
    pins,
    config: {
      bidDurationSeconds: settings.round.bidDurationSeconds,
      betDurationSeconds: settings.round.betDurationSeconds,
      claimDurationSeconds: settings.round.claimDurationSeconds,
      repostWindowSeconds: settings.round.repostWindowSeconds,
      bankerBidMinCents: settings.round.bankerBidMinCents,
      bankerBidMaxCents: settings.round.bankerBidMaxCents,
      autoTailPacketEnabled: settings.round.autoTailPacketEnabled ?? false,
    },
  };
}

function activity(roomId: string, kind: string, user: { uid: string; nickname: string }) {
  void broadcastToRoomCluster(roomId, { type: 'activity', kind, user }).catch(
    () => undefined,
  );
}

function serializeBetAcceptance(result: Awaited<ReturnType<typeof placeBet>>) {
  return {
    requestedAmountCents: String(result.requestedCents),
    amountCents: String(result.acceptedCents),
    reservedCents: String(result.reservedCents),
    liabilityBalanceCents: String(result.liabilityBalanceCents),
    maxAffordableCents: String(result.maxAffordableCents),
    roomMaxCents: String(result.roomMaxCents),
    maxAcceptedCents: String(result.maxAcceptedCents),
    maxMultiplier: result.maxMultiplier,
    liabilityMultiplier: result.liabilityMultiplier,
    adjusted: result.adjusted,
    adjustedBy: result.adjustedBy,
  };
}

export async function gameRoomRoutes(app: FastifyInstance) {
  const requireSupportedGameRoom = async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id?: string };
    if (!id) return;
    const room = await prisma.room.findFirst({
      where: { id, gameCode: { in: SUPPORTED_GAME_CODES } },
      select: { id: true },
    });
    if (!room) await reply.code(404).send({ error: 'GAME_NOT_SUPPORTED' });
  };
  const authenticatedRoom = [app.authUser, requireSupportedGameRoom];
  const player = [app.authUser, requireSupportedGameRoom, app.requireKyc];

  app.post('/api/game/rooms/:id/join', { preHandler: [app.authUser, app.requireKyc] }, async (req) => {
    const { id } = req.params as { id: string };
    const userId = (req.user as { sub: string }).sub;
    const startedAt = performance.now();
    await joinRoom(id, userId, {
      validatedHuman: true,
      allowedGameCodes: SUPPORTED_GAME_CODES,
    });
    const joinedAt = performance.now();
    const state = await buildRoomState(id, userId);
    const finishedAt = performance.now();
    const totalMs = finishedAt - startedAt;
    if (totalMs >= 500) {
      req.log.warn(
        {
          roomId: id,
          joinMs: Math.round(joinedAt - startedAt),
          stateMs: Math.round(finishedAt - joinedAt),
          totalMs: Math.round(totalMs),
        },
        'slow game room join',
      );
    }
    return state;
  });

  /** 60 秒房间连接票据：避免把 12 小时登录 JWT 放进 WebSocket URL/代理日志。 */
  app.post(
    '/api/game/rooms/:id/ws-ticket',
    { preHandler: player },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const claims = req.user as {
        sub: string;
        deviceId?: string;
        deviceVersion?: number;
      };
      const member = await prisma.roomMember.findUnique({
        where: { roomId_userId: { roomId: id, userId: claims.sub } },
        select: { status: true },
      });
      if (member?.status !== 'ACTIVE') {
        return reply.code(403).send({ error: 'NOT_IN_ROOM' });
      }
      const ticket = app.jwt.sign(
        {
          sub: claims.sub,
          kind: 'user_ws',
          roomId: id,
          deviceId: claims.deviceId,
          deviceVersion: claims.deviceVersion,
        },
        { expiresIn: '60s' },
      );
      return { ticket, expiresIn: 60 };
    },
  );

  app.post('/api/game/rooms/:id/leave', { preHandler: authenticatedRoom }, async (req) => {
    const { id } = req.params as { id: string };
    const userId = (req.user as { sub: string }).sub;
    await leaveRoom(id, userId);
    return { ok: true };
  });

  app.get('/api/game/rooms/:id/state', { preHandler: player }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = (req.user as { sub: string }).sub;
    const member = await prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId: id, userId } },
      select: { status: true },
    });
    if (member?.status !== 'ACTIVE') {
      return reply.code(403).send({ error: 'NOT_IN_ROOM' });
    }
    const startedAt = performance.now();
    const state = await buildRoomState(id, userId);
    const totalMs = performance.now() - startedAt;
    if (totalMs >= 500) {
      req.log.warn(
        { roomId: id, totalMs: Math.round(totalMs) },
        'slow game room state',
      );
    }
    return state;
  });

  app.post('/api/game/rooms/:id/bid', { preHandler: player }, async (req) => {
    const { id } = req.params as { id: string };
    const userId = (req.user as { sub: string }).sub;
    const { amount } = amountSchema.parse(req.body);
    const round = await currentRoundForRoom(id);
    if (!round || round.phase !== RoundPhase.BANKER_BID) throw new GameError('INVALID_PHASE');
    const amountCents = parseAmountCents(amount);
    const bid = await placeBankerBid(round.id, userId, amountCents);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { uid: true, nickname: true },
    });
    await announceBidPlaced({
      roundId: round.id,
      roomId: id,
      userId,
      amountCents,
      extendedEndsAt: bid?.extendedEndsAt ?? null,
    }).catch(() => undefined);
    activity(id, 'bid', { uid: user.uid, nickname: user.nickname ?? user.uid });
    return buildRoomState(id, userId);
  });

  app.post('/api/game/rooms/:id/bet', { preHandler: player }, async (req) => {
    const { id } = req.params as { id: string };
    const userId = (req.user as { sub: string }).sub;
    const body = amountSchema.extend({ allIn: z.boolean().default(false) }).parse(req.body);
    const round = await currentRoundForRoom(id);
    if (!round || round.phase !== RoundPhase.BETTING) throw new GameError('INVALID_PHASE');
    const acceptance = await placeBet(
      round.id,
      userId,
      parseAmountCents(body.amount),
      body.allIn,
    );
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { uid: true, nickname: true },
    });
    activity(id, body.allIn ? 'all_in' : 'bet', {
      uid: user.uid,
      nickname: user.nickname ?? user.uid,
    });
    return {
      ...(await buildRoomState(id, userId)),
      betAcceptance: serializeBetAcceptance(acceptance),
    };
  });

  app.post('/api/game/rooms/:id/withdraw-bet', { preHandler: player }, async (req) => {
    const { id } = req.params as { id: string };
    const userId = (req.user as { sub: string }).sub;
    const round = await currentRoundForRoom(id);
    if (!round || round.phase !== RoundPhase.BETTING) throw new GameError('INVALID_PHASE');
    await withdrawBet(round.id, userId);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { uid: true, nickname: true },
    });
    activity(id, 'withdraw', { uid: user.uid, nickname: user.nickname ?? user.uid });
    return buildRoomState(id, userId);
  });

  app.post('/api/game/rooms/:id/continue', { preHandler: player }, async (req) => {
    const { id } = req.params as { id: string };
    const userId = (req.user as { sub: string }).sub;
    const body = z.object({ previousRoundId: z.string().min(1) }).parse(req.body);
    const previous = await prisma.round.findUnique({ where: { id: body.previousRoundId } });
    if (
      !previous
      || previous.roomId !== id
      || previous.phase !== RoundPhase.FINISHED
      || previous.bankerId !== userId
    ) {
      throw new GameError('NOT_ROUND_BANKER');
    }
    const continued = await continueBanker(body.previousRoundId, userId);
    gameBus.transition({
      roundId: continued.id,
      roomId: continued.roomId,
      from: RoundPhase.WAITING,
      to: RoundPhase.BETTING,
    });
    return buildRoomState(id, userId);
  });

  // ── 群内玩家红包 ──
  app.post('/api/game/rooms/:id/group-packets', { preHandler: authenticatedRoom }, async (req) => {
    const { id } = req.params as { id: string };
    const userId = (req.user as { sub: string }).sub;
    const body = z
      .object({
        amount: z.string().regex(/^\d+(\.\d{1,2})?$/, '金额格式不正确'),
        count: z.number().int().min(1).max(50),
        mode: z.enum(['RANDOM', 'EQUAL']).default('RANDOM'),
        greeting: z.string().trim().min(1).max(40).default('恭喜发财，大吉大利'),
        requestId: z.string().uuid(),
        paymentPin: z.string().regex(/^\d{6}$/),
      })
      .parse(req.body);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { uid: true, nickname: true, avatarUrl: true },
    });
    if (!user) throw new GameError('USER_NOT_ACTIVE');
    const result = await sendGroupPacket({
      roomId: id,
      userId,
      totalCents: parseAmountCents(body.amount),
      count: body.count,
      mode: body.mode,
      greeting: body.greeting,
      requestId: body.requestId,
      paymentPin: body.paymentPin,
    });
    const { packet } = result;
    await appendChatOnce(id, `user-packet:${packet.id}`, {
      type: 'USER_PACKET',
      content: JSON.stringify({ id: packet.id, greeting: packet.greeting, mode: packet.mode }),
      from: {
        uid: user.uid,
        nickname: user.nickname ?? user.uid,
        avatarUrl: user.avatarUrl,
      },
    });
    if (!result.duplicate) {
      scheduleVirtualGroupPacketClaims({
        roomId: id,
        packetId: packet.id,
        senderId: userId,
      });
    }
    return { ok: true, packetId: packet.id, duplicate: result.duplicate };
  });

  app.post('/api/game/group-packets/:id/claim', { preHandler: [app.authUser] }, async (req) => {
    const { id } = req.params as { id: string };
    const userId = (req.user as { sub: string }).sub;
    const result = await claimGroupPacket({ packetId: id, userId });
    return { ok: true, amountCents: String(result.amountCents) };
  });

  app.get('/api/game/group-packets/:id', { preHandler: [app.authUser, app.requireKyc] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = (req.user as { sub: string }).sub;
    const packet = await groupPacketDetail(id);
    const member = await prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId: packet.roomId, userId } },
      select: { status: true },
    });
    if (member?.status !== 'ACTIVE') {
      return reply.code(403).send({ error: 'NOT_IN_ROOM' });
    }
    return {
      id: packet.id,
      sender: packet.sender,
      totalCents: String(packet.totalCents),
      count: packet.count,
      remainingCount: packet.remainingCount,
      status: packet.status,
      claims: packet.claims.map((claim) => ({
        uid: claim.user.uid,
        nickname: claim.user.nickname,
        avatarUrl: claim.user.avatarUrl,
        amountCents: String(claim.amountCents),
        at: claim.createdAt,
      })),
    };
  });

  /** 进房后批量恢复本人领取状态，避免重进又显示未领 */
  app.post('/api/game/group-packets/claim-status', { preHandler: [app.authUser] }, async (req) => {
    const userId = (req.user as { sub: string }).sub;
    const body = z
      .object({ ids: z.array(z.string().min(1).max(64)).max(80) })
      .parse(req.body);
    const ids = [...new Set(body.ids)];
    if (!ids.length) {
      return { items: [] as Array<{ id: string; mineCents: string | null; gone: boolean }> };
    }

    const packets = await prisma.groupPacket.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        status: true,
        remainingCount: true,
        claims: {
          where: { userId },
          select: { amountCents: true },
          take: 1,
        },
      },
    });

    return {
      items: packets.map((packet) => ({
        id: packet.id,
        mineCents: packet.claims[0] ? String(packet.claims[0].amountCents) : null,
        gone: packet.status !== 'ACTIVE' || packet.remainingCount <= 0,
      })),
    };
  });

  // ── 打赏客服 ──
  app.post('/api/game/rooms/:id/tip', { preHandler: authenticatedRoom }, async (req) => {
    const { id } = req.params as { id: string };
    const userId = (req.user as { sub: string }).sub;
    const body = tipSchema.parse(req.body);
    const amountCents = parseAmountCents(body.amount);
    const [user, result] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { uid: true, nickname: true, avatarUrl: true },
      }),
      tipSupport({
        roomId: id,
        userId,
        amountCents,
        requestId: body.requestId,
        paymentPin: body.paymentPin,
      }),
    ]);
    if (!user) throw new GameError('USER_NOT_ACTIVE');
    const amount = String(amountCents);
    const message = result.duplicate ? '打赏已确认，本次不会重复扣款。' : pickTipMessage();
    const nickname = user.nickname ?? user.uid;
    if (!result.duplicate) {
      appendChat(id, {
        type: 'USER_TIP',
        content: JSON.stringify({
          amountCents: amount,
          target: 'support',
          label: '客服小妹',
          message,
        }),
        from: {
          uid: user.uid,
          nickname: user.nickname ?? user.uid,
          avatarUrl: user.avatarUrl,
        },
      });
      await broadcastToRoomCluster(id, {
        type: 'tip_thanks',
        nickname,
        amountCents: amount,
        message,
        avatarUrl: user.avatarUrl ?? null,
      });
    }
    return {
      ok: true,
      duplicate: result.duplicate,
      nickname,
      amountCents: amount,
      message,
      avatarUrl: user.avatarUrl ?? null,
    };
  });

  // ── WebSocket：实时阶段推送 + 房内聊天 ──
  app.get('/api/game/rooms/:id/ws', { websocket: true }, async (socket: WebSocket, req) => {
    const { id } = req.params as { id: string };
    const { ticket } = req.query as { ticket?: string };
    let claims: {
      sub: string;
      kind?: string;
      roomId?: string;
      deviceId?: string;
      deviceVersion?: number;
    };
    try {
      claims = app.jwt.verify<{
        sub: string;
        kind?: string;
        roomId?: string;
        deviceId?: string;
        deviceVersion?: number;
      }>(ticket ?? '');
      if (claims.kind !== 'user_ws' || claims.roomId !== id) {
        throw new Error('wrong ticket');
      }
    } catch {
      socket.close(4401, 'UNAUTHORIZED');
      return;
    }
    const [room, user, member] = await Promise.all([
      prisma.room.findFirst({
        where: { id, gameCode: { in: SUPPORTED_GAME_CODES } },
        select: { id: true },
      }),
      prisma.user.findUnique({
        where: { id: claims.sub },
        select: {
          id: true,
          uid: true,
          nickname: true,
          avatarUrl: true,
          status: true,
          kind: true,
          device: {
            select: {
              deviceId: true,
              authVersion: true,
              status: true,
            },
          },
        },
      }),
      prisma.roomMember.findUnique({
        where: { roomId_userId: { roomId: id, userId: claims.sub } },
      }),
    ]);
    if (!room) {
      socket.close(4404, 'GAME_NOT_SUPPORTED');
      return;
    }
    if (!user || user.status !== 'ACTIVE' || user.kind === 'VIRTUAL') {
      socket.close(4403, 'USER_NOT_ACTIVE');
      return;
    }
    if (
      !user.device ||
      user.device.status !== 'ACTIVE' ||
      !claims.deviceId ||
      claims.deviceId !== user.device.deviceId ||
      claims.deviceVersion !== user.device.authVersion
    ) {
      socket.close(4403, 'DEVICE_SESSION_EXPIRED');
      return;
    }
    if (member?.status !== 'ACTIVE') {
      socket.close(4403, 'NOT_IN_ROOM');
      return;
    }

    const client: RoomClient = {
      socket,
      userId: user.id,
      uid: user.uid,
      nickname: user.nickname ?? user.uid,
      avatarUrl: user.avatarUrl,
    };
    addClient(id, client);
    let lastPresenceTouch = 0;
    let cleanedUp = false;
    let lastSessionValidatedAt = Date.now();
    let sessionValidationInFlight: Promise<boolean> | null = null;
    let messageQueue: Promise<void> = Promise.resolve();
    let queuedMessages = 0;
    let lastRateWarningAt = 0;
    let invalidSessionReason = 'DEVICE_SESSION_EXPIRED';
    const messageTimestamps: number[] = [];

    const sessionIsCurrent = async (force = false) => {
      if (!force && Date.now() - lastSessionValidatedAt < WS_SESSION_REVALIDATE_MS) {
        return true;
      }
      if (sessionValidationInFlight) return sessionValidationInFlight;
      sessionValidationInFlight = (async () => {
        const current = await prisma.user.findUnique({
          where: { id: user.id },
          select: {
            status: true,
            kind: true,
            device: {
              select: {
                deviceId: true,
                authVersion: true,
                status: true,
              },
            },
            roomMemberships: {
              where: { roomId: id },
              select: { status: true },
              take: 1,
            },
          },
        });
        const accountValid = Boolean(
          current &&
            current.status === 'ACTIVE' &&
            current.kind !== 'VIRTUAL' &&
            current.device?.status === 'ACTIVE' &&
            current.device.deviceId === claims.deviceId &&
            current.device.authVersion === claims.deviceVersion,
        );
        const memberValid = current?.roomMemberships[0]?.status === 'ACTIVE';
        invalidSessionReason = accountValid && !memberValid
          ? 'NOT_IN_ROOM'
          : 'DEVICE_SESSION_EXPIRED';
        const valid = accountValid && memberValid;
        if (valid) lastSessionValidatedAt = Date.now();
        return valid;
      })();
      try {
        return await sessionValidationInFlight;
      } finally {
        sessionValidationInFlight = null;
      }
    };
    const closeExpiredSession = () => {
      if (socket.readyState === socket.OPEN) socket.close(4403, invalidSessionReason);
    };
    const sessionTimer = setInterval(() => {
      void sessionIsCurrent(true)
        .then((valid) => {
          if (!valid) closeExpiredSession();
        })
        .catch(closeExpiredSession);
    }, WS_SESSION_REVALIDATE_MS);
    sessionTimer.unref?.();

    const warnRateLimit = (requestId?: string) => {
      const now = Date.now();
      if (now - lastRateWarningAt < 1_000 || socket.readyState !== socket.OPEN) return;
      lastRateWarningAt = now;
      socket.send(
        JSON.stringify({
          type: 'chat_error',
          message: '发送过快，请稍后再试',
          ...(requestId ? { requestId } : {}),
        }),
      );
    };

    const processSocketMessage = async (raw: Buffer) => {
        if (cleanedUp) return;
        let payload: { type?: string; content?: string; requestId?: string };
        try {
          payload = JSON.parse(raw.toString('utf8'));
        } catch {
          return;
        }
        if (!(await sessionIsCurrent())) {
          closeExpiredSession();
          return;
        }
        if (payload.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        const requestId = validSocketRequestId(payload.requestId);
        const reply = (message: Record<string, unknown>) => {
          socket.send(
            JSON.stringify(requestId ? { ...message, requestId } : message),
          );
        };
        const rateNow = Date.now();
        while (
          messageTimestamps.length > 0 &&
          messageTimestamps[0]! <= rateNow - WS_MESSAGE_RATE_WINDOW_MS
        ) {
          messageTimestamps.shift();
        }
        if (messageTimestamps.length >= WS_MESSAGE_RATE_LIMIT) {
          warnRateLimit(requestId);
          return;
        }
        messageTimestamps.push(rateNow);
        if (payload.type === 'dice') {
          const result = await runBankerDiceCeremony({ roomId: id, userId: user.id });
          if (result.kind === 'error') {
            reply({ type: 'chat_error', message: result.message });
            return;
          }
          await broadcastToRoomCluster(id, {
            type: 'activity',
            kind: 'dice',
            user: {
              uid: client.uid,
              nickname: client.nickname,
              avatarUrl: client.avatarUrl,
            },
          });
          return;
        }
        // 连接建立时已验明身份；昵称/头像变更会通过 profile_update 同步并更新 client。
        // 不要为每一条聊天再查一次用户表，否则大群刷屏会形成数据库风暴。
        const senderProfile = {
          uid: client.uid,
          nickname: client.nickname,
          avatarUrl: client.avatarUrl,
        };
        if (payload.type === 'sticker') {
          const phase = await currentRoundPhaseForRoom(id);
          if (isChatMuted(phase)) {
            reply({ type: 'chat_error', message: '抢红包阶段禁止发言，请专注领取' });
            return;
          }
          const stickerId = String((payload as { stickerId?: string }).stickerId ?? '');
          if (!stickerId) return;
          const sticker = await prisma.stickerAsset.findFirst({
            where: { id: stickerId, status: 'ACTIVE' },
            select: { url: true },
          });
          if (!sticker) {
            reply({ type: 'chat_error', message: '贴纸不存在或已下架' });
            return;
          }
          appendChat(id, {
            type: 'STICKER',
            content: sticker.url,
            from: senderProfile,
            requestId,
          });
          return;
        }
        if (payload.type === 'chat' || payload.type === 'emoji') {
          const content = String(payload.content ?? '').trim().slice(0, 200);
          if (!content) return;

          const phase = await currentRoundPhaseForRoom(id);
          if (isChatMuted(phase)) {
            reply({
              type: 'chat_error',
              message: '抢红包阶段禁止发言，请专注领取',
            });
            return;
          }

          if (payload.type === 'chat' && isRoomCommandCandidate(content)) {
            const result = await handleRoomChatCommand({
              roomId: id,
              userId: user.id,
              content,
            });
            const privateBetConfirmation = privateBetConfirmationFor(result);
            if (result.kind === 'muted') {
              reply({ type: 'chat_error', message: result.message });
              return;
            }
            if (result.kind === 'error') {
              if (privateBetConfirmation) {
                reply(privateBetConfirmation);
                return;
              }
              reply({ type: 'chat_error', message: result.message });
              return;
            }
            if (result.kind === 'ok') {
              const gameAction = confirmedChatGameAction(result);
              appendChat(id, {
                type: 'TEXT',
                content: result.echo,
                from: senderProfile,
                requestId,
                ...(gameAction ? { gameAction } : {}),
              });
              if (result.action === 'bid') {
                const liveRound = await currentRoundForRoom(id);
                if (liveRound) {
                  await announceBidPlaced({
                    roundId: liveRound.id,
                    roomId: id,
                    userId: user.id,
                    amountCents: parseAmountCents(result.echo),
                    extendedEndsAt: result.bidExtendedEndsAt ?? null,
                  }).catch(() => undefined);
                }
              }
              await broadcastToRoomCluster(id, {
                type: 'activity',
                kind: result.action,
                user: {
                  uid: senderProfile.uid,
                  nickname: senderProfile.nickname,
                  avatarUrl: senderProfile.avatarUrl,
                },
              });
              if (privateBetConfirmation) {
                reply(privateBetConfirmation);
              }
              return;
            }
          }

          appendChat(id, {
            type: payload.type === 'emoji' ? 'EMOJI' : 'TEXT',
            content,
            from: senderProfile,
            requestId,
          });
        }
        if (Date.now() - lastPresenceTouch > 60_000) {
          lastPresenceTouch = Date.now();
          await touchRoomPresence(id, user.id).catch(() => undefined);
        }
    };

    socket.on('message', (raw: Buffer) => {
      if (raw.byteLength > WS_MESSAGE_MAX_BYTES) {
        socket.close(1009, 'MESSAGE_TOO_LARGE');
        return;
      }
      if (queuedMessages >= WS_MESSAGE_QUEUE_LIMIT) {
        let requestId: string | undefined;
        try {
          requestId = validSocketRequestId(
            (JSON.parse(raw.toString('utf8')) as { requestId?: unknown }).requestId,
          );
        } catch {
          requestId = undefined;
        }
        warnRateLimit(requestId);
        return;
      }
      queuedMessages += 1;
      messageQueue = messageQueue
        .then(() => processSocketMessage(raw))
        .catch(() => undefined)
        .finally(() => {
          queuedMessages -= 1;
        });
    });

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(sessionTimer);
      removeClient(id, client);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
}
