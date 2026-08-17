import { ClaimSource, PacketChannel, RoundPhase } from '@prisma/client';
import { env } from '../config.js';
import { blindIndex, encryptSecret, normalizeIdentity } from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';
import { gameBus } from './gameBus.js';
import {
  GameError,
  publishPacket,
  recordClaim,
  refreshUnannouncedClaimDeadline,
  resolveClaimUserByName,
} from './game.js';
import { appendGamePacketMessage, ensureRoundAnnouncement } from './roomHub.js';

/** 手机端采集回调专用错误；HTTP 状态由 server.ts 统一错误处理映射。 */
export class TngIngestError extends Error {
  constructor(
    public code: string,
    public status = 400,
    public details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'TngIngestError';
  }
}

/** 去掉易混淆字符（0/O/1/I），避免运营与手机端抄错短码。 */
const CORRELATION_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CORRELATION_LENGTH = 6;

function randomCorrelation(): string {
  let out = '';
  for (let i = 0; i < CORRELATION_LENGTH; i += 1) {
    out += CORRELATION_ALPHABET[Math.floor(Math.random() * CORRELATION_ALPHABET.length)];
  }
  return out;
}

function leaseUntil(from = new Date()): Date {
  const seconds = Number.isFinite(env.tngIngestLeaseSeconds) ? env.tngIngestLeaseSeconds : 90;
  return new Date(from.getTime() + Math.max(15, seconds) * 1000);
}

export interface TngPacketJob {
  packetId: string;
  correlation: string;
  totalCents: string;
  packetCount: number;
  accountLabel: string;
  accountName: string;
  leaseExpiresAt: string;
}

/**
 * 派单：把处于「等待发包」且尚未登记链接的 TNG 局交给采集设备。
 *
 * 只派已经完成投骰（存在 BANKER_DICE_READY_FOR_PACKET）的局，
 * 否则手机端建好包后 publishPacket 会因 BANKER_DICE_NOT_READY 拒收，白扣一笔钱。
 */
export async function listPendingJobs(params: {
  deviceId: string;
  limit?: number;
}): Promise<TngPacketJob[]> {
  const limit = Math.min(Math.max(params.limit ?? 1, 1), 5);
  const now = new Date();

  const account = await prisma.tngAccount.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
  });
  if (!account) return [];

  const candidates = await prisma.round.findMany({
    where: {
      phase: RoundPhase.SENDING_PACKET,
      packet: {
        channel: PacketChannel.TNG,
        claimUrl: null,
        OR: [
          { ingestLeaseUntil: null },
          { ingestLeaseUntil: { lt: now } },
          { ingestDeviceId: params.deviceId },
        ],
      },
      events: { some: { type: 'BANKER_DICE_READY_FOR_PACKET' } },
    },
    select: {
      id: true,
      packet: {
        select: {
          id: true,
          correlation: true,
          totalCents: true,
          participantCount: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    take: limit * 3,
  });

  const jobs: TngPacketJob[] = [];
  for (const round of candidates) {
    if (jobs.length >= limit) break;
    const packet = round.packet;
    if (!packet) continue;

    const expiresAt = leaseUntil(now);
    // 条件更新即为抢锁：并发下只有一台设备能把租约改到自己名下。
    const locked = await prisma.packet.updateMany({
      where: {
        id: packet.id,
        claimUrl: null,
        OR: [
          { ingestLeaseUntil: null },
          { ingestLeaseUntil: { lt: now } },
          { ingestDeviceId: params.deviceId },
        ],
      },
      data: {
        ingestDeviceId: params.deviceId,
        ingestLeaseUntil: expiresAt,
        // 预占发包账号，回传链接时沿用同一个账号，避免与后台人工发包串号
        packerAccount: account.id,
      },
    });
    if (locked.count !== 1) continue;

    const correlation = packet.correlation ?? (await assignCorrelation(packet.id));
    jobs.push({
      packetId: packet.id,
      correlation,
      totalCents: String(packet.totalCents),
      packetCount: packet.participantCount,
      accountLabel: account.label,
      accountName: account.accountName,
      leaseExpiresAt: expiresAt.toISOString(),
    });
  }
  return jobs;
}

async function assignCorrelation(packetId: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const correlation = randomCorrelation();
    try {
      const updated = await prisma.packet.update({
        where: { id: packetId },
        data: { correlation },
        select: { correlation: true },
      });
      return updated.correlation!;
    } catch {
      // 短码撞车：重新摇一个。已被其它请求赋值时直接读回。
      const existing = await prisma.packet.findUnique({
        where: { id: packetId },
        select: { correlation: true },
      });
      if (existing?.correlation) return existing.correlation;
    }
  }
  throw new TngIngestError('CORRELATION_ALLOCATION_FAILED', 500);
}

async function findPacketByRef(ref: { correlation?: string; packetId?: string }) {
  const packet = ref.correlation
    ? await prisma.packet.findUnique({
        where: { correlation: ref.correlation },
        include: { round: { select: { id: true, roomId: true, phase: true } } },
      })
    : ref.packetId
      ? await prisma.packet.findUnique({
          where: { id: ref.packetId },
          include: { round: { select: { id: true, roomId: true, phase: true } } },
        })
      : null;
  if (!packet) throw new TngIngestError('CORRELATION_NOT_FOUND', 404);
  return packet;
}

export interface IngestPacketLinkResult {
  packetId: string;
  roundId: string;
  phase: RoundPhase;
  duplicate: boolean;
}

/** 回传建包链接：校验金额一致后复用 publishPacket，并推房间卡片、进入抢包阶段。 */
export async function ingestPacketLink(params: {
  deviceId: string;
  correlation: string;
  shareUrl?: string;
  deepLink?: string;
  totalCents: bigint;
  packetCount: number;
}): Promise<IngestPacketLinkResult> {
  const claimUrl = params.shareUrl ?? params.deepLink;
  if (!claimUrl) throw new TngIngestError('PACKET_LINK_REQUIRED');

  const packet = await findPacketByRef({ correlation: params.correlation });

  // 幂等：同一条链接重复提交视为成功，网络超时可安全重试。
  if (packet.claimUrl) {
    const same = packet.claimUrl === claimUrl.trim() || packet.deepLink === params.deepLink?.trim();
    if (same) {
      return {
        packetId: packet.id,
        roundId: packet.roundId,
        phase: packet.round.phase,
        duplicate: true,
      };
    }
    throw new TngIngestError('PACKET_ALREADY_PUBLISHED', 409);
  }

  if (packet.totalCents !== params.totalCents || packet.participantCount !== params.packetCount) {
    throw new TngIngestError('PACKET_AMOUNT_MISMATCH', 400, {
      expectedTotalCents: String(packet.totalCents),
      expectedPacketCount: packet.participantCount,
    });
  }

  if (!packet.packerAccount) throw new TngIngestError('TNG_ACCOUNT_UNAVAILABLE', 409);

  const published = await publishPacket({
    roundId: packet.roundId,
    claimUrl,
    deepLink: params.deepLink,
    packerAccount: packet.packerAccount,
    actorId: 'TNG_INGEST',
  });

  // 与 roundScheduler 自动发包保持一致：先出红包卡，再刷新抢包截止与阶段播报。
  await appendGamePacketMessage(packet.round.roomId, {
    packetId: published.id,
    roundId: packet.roundId,
  });
  await refreshUnannouncedClaimDeadline(packet.roundId);
  await ensureRoundAnnouncement({
    roundId: packet.roundId,
    roomId: packet.round.roomId,
    to: RoundPhase.CLAIMING,
  });
  gameBus.transition({
    roundId: packet.roundId,
    roomId: packet.round.roomId,
    from: RoundPhase.SENDING_PACKET,
    to: RoundPhase.CLAIMING,
  });

  return {
    packetId: published.id,
    roundId: packet.roundId,
    phase: RoundPhase.CLAIMING,
    duplicate: false,
  };
}

export type IngestClaimStatus = 'recorded' | 'duplicate' | 'pending_review';

export interface IngestClaimRow {
  tngName: string;
  amountCents: bigint;
  claimedAt: Date;
}

export interface IngestClaimResult {
  tngName: string;
  status: IngestClaimStatus;
  userId?: string;
  reason?: string;
}

/** GameError → 待人工指认原因；未列出的错误码原样透出便于排查。 */
function pendingReasonForGameError(code: string): string {
  switch (code) {
    case 'TNG_NAME_MISMATCH':
      return 'NAME_NOT_MATCHED';
    case 'KYC_REQUIRED':
      return 'KYC_NOT_APPROVED';
    case 'NOT_ELIGIBLE_TO_CLAIM':
      return 'NOT_PARTICIPANT';
    case 'PACKET_TOTAL_EXCEEDED':
      return 'AMOUNT_EXCEEDS_TOTAL';
    case 'CLAIM_ALREADY_RECORDED':
      return 'AMOUNT_CONFLICT';
    default:
      return code;
  }
}

async function parkForReview(input: {
  packetId: string;
  roundId: string;
  deviceId: string;
  row: IngestClaimRow;
  reason: string;
}) {
  const nameHash = blindIndex(input.row.tngName);
  await prisma.tngClaimInbox.upsert({
    where: {
      packetId_tngNameHash_amountCents: {
        packetId: input.packetId,
        tngNameHash: nameHash,
        amountCents: input.row.amountCents,
      },
    },
    create: {
      packetId: input.packetId,
      roundId: input.roundId,
      tngName: encryptSecret(normalizeIdentity(input.row.tngName)),
      tngNameHash: nameHash,
      amountCents: input.row.amountCents,
      claimedAt: input.row.claimedAt,
      deviceId: input.deviceId,
      reason: input.reason,
    },
    update: {},
  });
}

/**
 * 回传领取明细：能唯一匹配到本局参与者就自动认额（source=PROVIDER），
 * 匹配不上或有歧义一律落 TngClaimInbox 交人工指认，绝不猜。
 */
export async function ingestClaims(params: {
  deviceId: string;
  correlation?: string;
  packetId?: string;
  claims: IngestClaimRow[];
}): Promise<{ results: IngestClaimResult[]; complete: boolean }> {
  const packet = await findPacketByRef({
    correlation: params.correlation,
    packetId: params.packetId,
  });
  const roundId = packet.roundId;
  const results: IngestClaimResult[] = [];
  let complete = false;

  for (const row of params.claims) {
    const resolution = await resolveClaimUserByName(roundId, row.tngName);
    if (!resolution.ok) {
      await parkForReview({
        packetId: packet.id,
        roundId,
        deviceId: params.deviceId,
        row,
        reason: resolution.reason,
      });
      results.push({ tngName: row.tngName, status: 'pending_review', reason: resolution.reason });
      continue;
    }

    // 先查已有认额，避免 recordClaim 对「同额重复」与「异额冲突」返回难以区分的结果。
    const existing = await prisma.claim.findUnique({
      where: { roundId_userId: { roundId, userId: resolution.userId } },
      select: { amountCents: true },
    });
    if (existing) {
      if (existing.amountCents === row.amountCents) {
        results.push({ tngName: row.tngName, status: 'duplicate', userId: resolution.userId });
      } else {
        await parkForReview({
          packetId: packet.id,
          roundId,
          deviceId: params.deviceId,
          row,
          reason: 'AMOUNT_CONFLICT',
        });
        results.push({
          tngName: row.tngName,
          status: 'pending_review',
          userId: resolution.userId,
          reason: 'AMOUNT_CONFLICT',
        });
      }
      continue;
    }

    try {
      const recorded = await recordClaim({
        roundId,
        userId: resolution.userId,
        amountCents: row.amountCents,
        tngName: row.tngName,
        source: ClaimSource.PROVIDER,
        enteredBy: 'TNG_INGEST',
      });
      complete = recorded.complete;
      gameBus.claimRecorded({
        roundId,
        userId: resolution.userId,
        amountCents: String(row.amountCents),
      });
      results.push({ tngName: row.tngName, status: 'recorded', userId: resolution.userId });
    } catch (error) {
      // 整局已结算/已进入不可认额阶段属于批次级失败，交由调用方返回 409，手机端放弃本批。
      if (error instanceof GameError && error.code === 'INVALID_PHASE') {
        throw new TngIngestError('INVALID_PHASE', 409);
      }
      const reason =
        error instanceof GameError ? pendingReasonForGameError(error.code) : 'UNKNOWN_ERROR';
      await parkForReview({
        packetId: packet.id,
        roundId,
        deviceId: params.deviceId,
        row,
        reason,
      });
      results.push({
        tngName: row.tngName,
        status: 'pending_review',
        userId: resolution.userId,
        reason,
      });
    }
  }

  return { results, complete };
}
