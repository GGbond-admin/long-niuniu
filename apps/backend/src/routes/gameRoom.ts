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
import { bettingRange, toCents } from '../engine/betting.js';
import { prisma } from '../lib/prisma.js';
import {
  canClaimPacket,
  continueBanker,
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
  handleRoomChatCommand,
  isChatMuted,
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
import {
  gameDefinition,
  SUPPORTED_GAME_CODES,
} from '../services/gameCatalog.js';
import {
  addClient,
  appendChat,
  appendChatOnce,
  broadcastToRoom,
  onlineCount,
  removeClient,
  type RoomClient,
} from '../services/roomHub.js';

const amountSchema = z.object({
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/, '金额格式不正确'),
});
const tipSchema = amountSchema.extend({
  requestId: z.string().uuid(),
});

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
  const room = await prisma.room.findFirst({
    where: {
      id: roomId,
      gameCode: { in: SUPPORTED_GAME_CODES },
    },
    include: { _count: { select: { members: { where: { status: 'ACTIVE' } } } } },
  });
  if (!room) throw new GameError('ROOM_NOT_FOUND');
  const member = await prisma.roomMember.findUnique({
    where: { roomId_userId: { roomId, userId } },
  });

  const round = await currentRoundForRoom(roomId);
  const settings = round?.configSnapshot
    ? parseSettingsSnapshot(round.configSnapshot)
    : await getGameSettings(room.gameCode);

  let banker: { uid: string; nickname: string; avatarUrl: string | null } | null = null;
  if (round?.bankerId) {
    const row = await prisma.user.findUnique({
      where: { id: round.bankerId },
      select: { uid: true, nickname: true, avatarUrl: true },
    });
    if (row) {
      banker = {
        uid: row.uid,
        nickname: row.nickname ?? row.uid,
        avatarUrl: row.avatarUrl,
      };
    }
  }

  let betRange: ReturnType<typeof bettingRange> | null = null;
  if (round && round.phase === RoundPhase.BETTING) {
    const players = await eligiblePlayerCount(roomId);
    betRange = bettingRange(Number(round.potCents), Math.max(1, players), settings.betting);
  }

  const frozenBets = (round?.bets ?? []).filter((bet) => bet.status === BetStatus.FROZEN);
  const myBid = round?.bids.find((bid) => bid.userId === userId) ?? null;
  const myBet = frozenBets.find((bet) => bet.userId === userId) ?? null;
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

  let canClaim = false;
  if (round?.packet && round.phase === RoundPhase.CLAIMING) {
    canClaim = await canClaimPacket(round.packet.id, userId);
  }

  let diceThrown = false;
  if (round && round.phase === RoundPhase.SENDING_PACKET) {
    diceThrown = !!(await prisma.roundEvent.findFirst({
      where: { roundId: round.id, type: 'BANKER_DICE_READY_FOR_PACKET' },
      select: { id: true },
    }));
  }

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1_000);
  const [lastFinished, pins, playedRounds24h] = await Promise.all([
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
        OR: [{ scheduledAt: null }, { scheduledAt: { lte: new Date() } }],
      },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      take: 7,
      select: { id: true, title: true, body: true },
    }),
    prisma.claim.count({
      where: { userId, createdAt: { gte: since24h } },
    }),
  ]);

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
        ? { amountCents: String(myBet.amountCents), isAllIn: myBet.isAllIn }
        : null,
      canClaim,
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
          participantCount: round.packet?.participantCount ?? null,
          /** 仅 TNG 发包完成后才暴露，前端据此弹出可领红包 */
          packetId:
            round.packet?.status === 'SENT' && round.packet.claimUrl
              ? round.packet.id
              : null,
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
      bankerBidMinCents: settings.round.bankerBidMinCents,
      bankerBidMaxCents: settings.round.bankerBidMaxCents,
      autoTailPacketEnabled: settings.round.autoTailPacketEnabled ?? false,
    },
  };
}

function activity(roomId: string, kind: string, user: { uid: string; nickname: string }) {
  broadcastToRoom(roomId, { type: 'activity', kind, user });
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

  app.post('/api/game/rooms/:id/join', { preHandler: player }, async (req) => {
    const { id } = req.params as { id: string };
    const userId = (req.user as { sub: string }).sub;
    await joinRoom(id, userId);
    return buildRoomState(id, userId);
  });

  app.post('/api/game/rooms/:id/leave', { preHandler: authenticatedRoom }, async (req) => {
    const { id } = req.params as { id: string };
    const userId = (req.user as { sub: string }).sub;
    await leaveRoom(id, userId);
    return { ok: true };
  });

  app.get('/api/game/rooms/:id/state', { preHandler: authenticatedRoom }, async (req) => {
    const { id } = req.params as { id: string };
    const userId = (req.user as { sub: string }).sub;
    return buildRoomState(id, userId);
  });

  app.post('/api/game/rooms/:id/bid', { preHandler: player }, async (req) => {
    const { id } = req.params as { id: string };
    const userId = (req.user as { sub: string }).sub;
    const { amount } = amountSchema.parse(req.body);
    const round = await currentRoundForRoom(id);
    if (!round || round.phase !== RoundPhase.BANKER_BID) throw new GameError('INVALID_PHASE');
    const amountCents = BigInt(toCents(amount));
    await placeBankerBid(round.id, userId, amountCents);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { uid: true, nickname: true },
    });
    await announceBidPlaced({
      roundId: round.id,
      roomId: id,
      userId,
      amountCents,
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
    await placeBet(round.id, userId, BigInt(toCents(body.amount)), body.allIn);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { uid: true, nickname: true },
    });
    activity(id, body.allIn ? 'all_in' : 'bet', {
      uid: user.uid,
      nickname: user.nickname ?? user.uid,
    });
    return buildRoomState(id, userId);
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
      totalCents: BigInt(toCents(body.amount)),
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
    return { ok: true, packetId: packet.id, duplicate: result.duplicate };
  });

  app.post('/api/game/group-packets/:id/claim', { preHandler: [app.authUser] }, async (req) => {
    const { id } = req.params as { id: string };
    const userId = (req.user as { sub: string }).sub;
    const result = await claimGroupPacket({ packetId: id, userId });
    return { ok: true, amountCents: String(result.amountCents) };
  });

  app.get('/api/game/group-packets/:id', { preHandler: [app.authUser] }, async (req) => {
    const { id } = req.params as { id: string };
    const packet = await groupPacketDetail(id);
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
    const amountCents = BigInt(toCents(body.amount));
    const [user, result] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { uid: true, nickname: true, avatarUrl: true },
      }),
      tipSupport({ roomId: id, userId, amountCents, requestId: body.requestId }),
    ]);
    if (!user) throw new GameError('USER_NOT_ACTIVE');
    const amount = String(amountCents);
    const message = result.duplicate ? '打赏已确认，本次不会重复扣款。' : pickTipMessage();
    const nickname = result.nickname;
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
      broadcastToRoom(id, {
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
    const { token } = req.query as { token?: string };
    let claims: {
      sub: string;
      kind?: string;
      deviceId?: string;
      deviceVersion?: number;
    };
    try {
      claims = app.jwt.verify<{
        sub: string;
        kind?: string;
        deviceId?: string;
        deviceVersion?: number;
      }>(token ?? '');
      if (claims.kind !== 'user') throw new Error('wrong kind');
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

    const sessionIsCurrent = async () => {
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
        },
      });
      return Boolean(
        current &&
          current.status === 'ACTIVE' &&
          current.kind !== 'VIRTUAL' &&
          current.device?.status === 'ACTIVE' &&
          current.device.deviceId === claims.deviceId &&
          current.device.authVersion === claims.deviceVersion,
      );
    };
    const closeExpiredSession = () => {
      if (socket.readyState === socket.OPEN) socket.close(4403, 'DEVICE_SESSION_EXPIRED');
    };
    const sessionTimer = setInterval(() => {
      void sessionIsCurrent()
        .then((valid) => {
          if (!valid) closeExpiredSession();
        })
        .catch(closeExpiredSession);
    }, 15_000);
    sessionTimer.unref?.();

    socket.on('message', (raw: Buffer) => {
      void (async () => {
        let payload: { type?: string; content?: string };
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
        if (payload.type === 'dice') {
          const result = await runBankerDiceCeremony({ roomId: id, userId: user.id });
          if (result.kind === 'error') {
            socket.send(JSON.stringify({ type: 'chat_error', message: result.message }));
            return;
          }
          return;
        }
        const sender =
          payload.type === 'sticker' || payload.type === 'chat' || payload.type === 'emoji'
            ? await prisma.user.findUnique({
                where: { id: user.id },
                select: { uid: true, nickname: true, avatarUrl: true },
              })
            : null;
        const senderProfile = {
          uid: sender?.uid ?? user.uid,
          nickname: sender?.nickname ?? sender?.uid ?? user.nickname ?? user.uid,
          avatarUrl: sender ? sender.avatarUrl : user.avatarUrl,
        };
        if (payload.type === 'sticker') {
          const round = await currentRoundForRoom(id);
          if (isChatMuted(round?.phase)) {
            socket.send(
              JSON.stringify({ type: 'chat_error', message: '抢红包阶段禁止发言，请专注领取' }),
            );
            return;
          }
          const stickerId = String((payload as { stickerId?: string }).stickerId ?? '');
          if (!stickerId) return;
          const sticker = await prisma.stickerAsset.findFirst({
            where: { id: stickerId, status: 'ACTIVE' },
            select: { url: true },
          });
          if (!sticker) {
            socket.send(JSON.stringify({ type: 'chat_error', message: '贴纸不存在或已下架' }));
            return;
          }
          appendChat(id, {
            type: 'STICKER',
            content: sticker.url,
            from: senderProfile,
          });
          return;
        }
        if (payload.type === 'chat' || payload.type === 'emoji') {
          const content = String(payload.content ?? '').trim().slice(0, 200);
          if (!content) return;

          const round = await currentRoundForRoom(id);
          if (isChatMuted(round?.phase)) {
            socket.send(
              JSON.stringify({
                type: 'chat_error',
                message: '抢红包阶段禁止发言，请专注领取',
              }),
            );
            return;
          }

          if (payload.type === 'chat') {
            const result = await handleRoomChatCommand({
              roomId: id,
              userId: user.id,
              content,
            });
            if (result.kind === 'muted') {
              socket.send(JSON.stringify({ type: 'chat_error', message: result.message }));
              return;
            }
            if (result.kind === 'error') {
              socket.send(JSON.stringify({ type: 'chat_error', message: result.message }));
              return;
            }
            if (result.kind === 'ok') {
              appendChat(id, {
                type: 'TEXT',
                content: result.echo,
                from: senderProfile,
              });
              if (result.action === 'bid') {
                const liveRound = await currentRoundForRoom(id);
                if (liveRound) {
                  await announceBidPlaced({
                    roundId: liveRound.id,
                    roomId: id,
                    userId: user.id,
                    amountCents: BigInt(toCents(result.echo)),
                  }).catch(() => undefined);
                }
              }
              broadcastToRoom(id, {
                type: 'activity',
                kind: result.action,
                user: {
                  uid: senderProfile.uid,
                  nickname: senderProfile.nickname,
                  avatarUrl: senderProfile.avatarUrl,
                },
              });
              return;
            }
          }

          appendChat(id, {
            type: payload.type === 'emoji' ? 'EMOJI' : 'TEXT',
            content,
            from: senderProfile,
          });
        }
        if (Date.now() - lastPresenceTouch > 60_000) {
          lastPresenceTouch = Date.now();
          await touchRoomPresence(id, user.id).catch(() => undefined);
        }
      })().catch(() => undefined);
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
