import { PacketChannel, RoundPhase } from '@prisma/client';
import { withRedisLock } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { gameBus } from './gameBus.js';
import { GameError, publishPacket, refreshUnannouncedClaimDeadline } from './game.js';
import { appendGamePacketMessage, ensureRoundAnnouncement } from './roomHub.js';
import { ingestClaims, TngIngestError } from './tngIngest.js';
import { getTngSchedulerConfig, isTngSchedulerReady } from './tngScheduler.js';
import {
  createSchedulerPacket,
  generateSchedulerPacketId,
  hasPublishableLink,
  isTerminalStatus,
  PACKET_ID_RE,
  querySchedulerPacket,
  type QueryResp,
  type TngSchedulerCredentials,
} from './tngSchedulerClient.js';

const TICK_MS = 1_500;
const CLAIM_GRACE_MS = 2 * 60 * 1000;
const ACTOR = 'TNG_SCHEDULER';

let timer: NodeJS.Timeout | null = null;
let ticking = false;

function toSafeInt(value: bigint): number | null {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
}

function formatError(code: string, requestId?: string): string {
  return requestId ? `${code} (${requestId})` : code;
}

async function firstActiveAccountId(): Promise<string | null> {
  const account = await prisma.tngAccount.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return account?.id ?? null;
}

async function publishReadyPacket(input: {
  roundId: string;
  roomId: string;
  packerAccount: string;
  shareUrl: string | null;
  deepLink: string | null;
}) {
  const claimUrl = input.shareUrl ?? input.deepLink;
  if (!claimUrl) return;
  const packet = await publishPacket({
    roundId: input.roundId,
    claimUrl,
    deepLink: input.deepLink ?? undefined,
    packerAccount: input.packerAccount,
    actorId: ACTOR,
  });
  await appendGamePacketMessage(input.roomId, {
    packetId: packet.id,
    roundId: input.roundId,
  });
  await refreshUnannouncedClaimDeadline(input.roundId);
  await ensureRoundAnnouncement({
    roundId: input.roundId,
    roomId: input.roomId,
    to: RoundPhase.CLAIMING,
  });
  gameBus.transition({
    roundId: input.roundId,
    roomId: input.roomId,
    from: RoundPhase.SENDING_PACKET,
    to: RoundPhase.CLAIMING,
  });
}

async function persistError(packetId: string, message: string) {
  await prisma.packet.update({
    where: { id: packetId },
    data: { schedulerLastError: message.slice(0, 500) },
  });
}

function canCreateLocally(totalCents: bigint, packetCount: number): string | null {
  const amount = toSafeInt(totalCents);
  if (amount === null) return 'AMOUNT_OVERFLOW';
  if (amount < 101) return 'AMOUNT_TOO_SMALL';
  if (packetCount < 2 || packetCount > 1000) return 'INVALID_PACKET_COUNT';
  if (amount < packetCount) return 'INVALID_DISTRIBUTION';
  return null;
}

async function dispatchCreate(
  credentials: TngSchedulerCredentials,
  packet: { id: string; totalCents: bigint; participantCount: number; schedulerPacketId: string | null },
) {
  const blocked = canCreateLocally(packet.totalCents, packet.participantCount);
  if (blocked) {
    await persistError(packet.id, blocked);
    return;
  }

  let schedulerPacketId = packet.schedulerPacketId;
  if (!schedulerPacketId) {
    schedulerPacketId = generateSchedulerPacketId();
    const locked = await prisma.packet.updateMany({
      where: { id: packet.id, schedulerPacketId: null, claimUrl: null },
      data: { schedulerPacketId, schedulerLastError: null },
    });
    if (locked.count !== 1) return;
  }
  if (!PACKET_ID_RE.test(schedulerPacketId)) {
    await persistError(packet.id, 'INVALID_SCHEDULER_PACKET_ID');
    return;
  }

  const created = await createSchedulerPacket(credentials, {
    packetId: schedulerPacketId,
    totalAmountCents: toSafeInt(packet.totalCents)!,
    packetCount: packet.participantCount,
  });
  if (!created.ok) {
    if (!created.error.retryable) {
      await persistError(packet.id, formatError(created.error.code, created.requestId));
    }
    return;
  }
  if (created.data.packetId && created.data.packetId !== schedulerPacketId) {
    await persistError(packet.id, 'PACKET_ID_MISMATCH');
  }
}

async function applyQuery(input: {
  packetId: string;
  roundId: string;
  roomId: string;
  phase: RoundPhase;
  claimUrl: string | null;
  afterSeq: number;
  data: QueryResp;
}) {
  if (input.data.failure && isTerminalStatus(input.data.status) && !hasPublishableLink(input.data)) {
    await prisma.packet.update({
      where: { id: input.packetId },
      data: {
        schedulerLastError: `${input.data.failure.code}: ${input.data.failure.message}`.slice(0, 500),
        schedulerClaimsFinal: true,
      },
    });
    return;
  }

  let published = false;
  if (
    !input.claimUrl &&
    input.phase === RoundPhase.SENDING_PACKET &&
    hasPublishableLink(input.data) &&
    (input.data.status === 'READY' ||
      input.data.status === 'CLAIMING' ||
      input.data.status === 'COMPLETED')
  ) {
    const packerAccount = await firstActiveAccountId();
    if (!packerAccount) {
      await persistError(input.packetId, 'TNG_ACCOUNT_UNAVAILABLE');
      return;
    }
    try {
      await publishReadyPacket({
        roundId: input.roundId,
        roomId: input.roomId,
        packerAccount,
        shareUrl: input.data.shareUrl,
        deepLink: input.data.deepLink,
      });
      published = true;
    } catch (error) {
      const code = error instanceof GameError ? error.code : 'PUBLISH_FAILED';
      await persistError(input.packetId, code);
      return;
    }
  }

  const canRecordClaims =
    Boolean(input.claimUrl) ||
    published ||
    input.phase === RoundPhase.CLAIMING ||
    input.phase === RoundPhase.CLAIM_EXPIRED;
  if (canRecordClaims && input.data.claims.length > 0) {
    try {
      await ingestClaims({
        deviceId: ACTOR,
        packetId: input.packetId,
        claims: input.data.claims.map((row) => ({
          tngName: row.tngName,
          amountCents: BigInt(row.amountCents),
          claimedAt: new Date(row.claimedAt),
        })),
      });
    } catch (error) {
      if (!(error instanceof TngIngestError && error.code === 'INVALID_PHASE')) {
        throw error;
      }
    }
  }

  await prisma.packet.update({
    where: { id: input.packetId },
    data: {
      schedulerAfterSeq: input.data.nextSequence,
      schedulerClaimsFinal: input.data.claimsFinal,
      schedulerLastError: input.data.failure
        ? `${input.data.failure.code}: ${input.data.failure.message}`.slice(0, 500)
        : null,
    },
  });
}

async function pollOne(
  credentials: TngSchedulerCredentials,
  packet: {
    id: string;
    roundId: string;
    claimUrl: string | null;
    totalCents: bigint;
    participantCount: number;
    schedulerPacketId: string;
    schedulerAfterSeq: number;
    round: { roomId: string; phase: RoundPhase };
  },
) {
  let afterSeq = packet.schedulerAfterSeq;
  for (let page = 0; page < 8; page += 1) {
    const queried = await querySchedulerPacket(credentials, {
      packetId: packet.schedulerPacketId,
      afterSequence: afterSeq,
      limit: 200,
    });
    if (!queried.ok) {
      if (queried.error.code === 'PACKET_NOT_FOUND') {
        await dispatchCreate(credentials, packet);
      }
      return;
    }
    await applyQuery({
      packetId: packet.id,
      roundId: packet.roundId,
      roomId: packet.round.roomId,
      phase: packet.round.phase,
      claimUrl: packet.claimUrl,
      afterSeq,
      data: queried.data,
    });
    afterSeq = queried.data.nextSequence;
    if (!queried.data.hasMore) return;
  }
}

async function tick() {
  const config = await getTngSchedulerConfig();
  if (!isTngSchedulerReady(config)) return;
  const credentials: TngSchedulerCredentials = {
    baseUrl: config.baseUrl,
    keyId: config.keyId,
    secret: config.secret,
  };

  const pending = await prisma.round.findMany({
    where: {
      phase: RoundPhase.SENDING_PACKET,
      packet: {
        channel: PacketChannel.TNG,
        claimUrl: null,
        schedulerPacketId: null,
        schedulerLastError: null,
      },
      events: { some: { type: 'BANKER_DICE_READY_FOR_PACKET' } },
    },
    select: {
      id: true,
      packet: {
        select: {
          id: true,
          totalCents: true,
          participantCount: true,
          schedulerPacketId: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });

  for (const round of pending) {
    if (!round.packet) continue;
    await withRedisLock(`tng-scheduler:create:${round.packet.id}`, 12_000, () =>
      dispatchCreate(credentials, round.packet!),
    );
  }

  const graceAfter = new Date(Date.now() - CLAIM_GRACE_MS);
  const watch = await prisma.packet.findMany({
    where: {
      channel: PacketChannel.TNG,
      schedulerPacketId: { not: null },
      schedulerClaimsFinal: false,
      OR: [
        { claimUrl: null },
        { round: { phase: { in: [RoundPhase.CLAIMING, RoundPhase.CLAIM_EXPIRED] } } },
        { expiresAt: { gte: graceAfter } },
      ],
    },
    select: {
      id: true,
      roundId: true,
      claimUrl: true,
      totalCents: true,
      participantCount: true,
      schedulerPacketId: true,
      schedulerAfterSeq: true,
      round: { select: { roomId: true, phase: true } },
    },
    take: 30,
  });

  for (const packet of watch) {
    if (!packet.schedulerPacketId) continue;
    await withRedisLock(`tng-scheduler:query:${packet.id}`, 12_000, () =>
      pollOne(credentials, {
        ...packet,
        schedulerPacketId: packet.schedulerPacketId!,
      }),
    );
  }
}

export function initTngSchedulerWorker() {
  if (timer) return;
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void tick()
      .catch((error) => {
        console.error('[tng-scheduler] tick failed', error);
      })
      .finally(() => {
        ticking = false;
      });
  }, TICK_MS);
  timer.unref?.();
}

export function stopTngSchedulerWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
