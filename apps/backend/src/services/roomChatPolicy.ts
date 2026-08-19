import { RoundPhase, UserKind } from '@prisma/client';
import { bankerSeatFee } from '../engine/fees.js';
import { prisma } from '../lib/prisma.js';
import { parseSettingsSnapshot } from './gameSettings.js';

export const ROOM_ANNOUNCED_FINISHED = `ROOM_ANNOUNCED_${RoundPhase.FINISHED}`;
export const CONTINUATION_REJECTED_INSUFFICIENT =
  'CONTINUATION_REJECTED_INSUFFICIENT';

export type RoomChatPolicyStage =
  | 'DICE'
  | 'CLAIMING'
  | 'SETTLING'
  | 'CONTINUATION'
  | 'NEXT_ROUND'
  | 'STARTING'
  | null;

export type RoomChatPolicy = {
  muted: boolean;
  stage: RoomChatPolicyStage;
};

export type ChatPolicyRoundSnapshot = {
  id: string;
  seqNo: number;
  phase: RoundPhase;
  bankerId: string | null;
  isContinued: boolean;
  continuationUsed: boolean;
  cancelReason?: string | null;
  continuationWindowSeconds?: number | null;
  continuationFundingSufficient?: boolean | null;
  autoFundableVirtual?: boolean;
  events: Array<{ type: string; createdAt: Date }>;
};

const OPEN_POLICY: RoomChatPolicy = { muted: false, stage: null };

function muted(stage: Exclude<RoomChatPolicyStage, null>): RoomChatPolicy {
  return { muted: true, stage };
}

function hasAnnouncement(round: ChatPolicyRoundSnapshot, phase: RoundPhase): boolean {
  return round.events.some((event) => event.type === `ROOM_ANNOUNCED_${phase}`);
}

function cancelledAfterDiceStarted(round: ChatPolicyRoundSnapshot): boolean {
  return (
    round.cancelReason === '庄家重推'
    || round.events.some(
      (event) =>
        event.type === `ROOM_ANNOUNCED_${RoundPhase.SENDING_PACKET}`
        || event.type === 'BANKER_REPOST_WINDOW',
    )
  );
}

function finishedRoundPolicy(
  round: ChatPolicyRoundSnapshot,
  now: Date,
): RoomChatPolicy {
  const announced = round.events.find((event) => event.type === ROOM_ANNOUNCED_FINISHED);
  if (!announced) return muted('SETTLING');
  const continuationRejected = round.events.some(
    (event) => event.type === CONTINUATION_REJECTED_INSUFFICIENT,
  );
  if (
    continuationRejected
    || !round.bankerId
    || round.continuationUsed
    || round.isContinued
    || !round.continuationWindowSeconds
    || (
      round.continuationFundingSufficient === false
      && !round.autoFundableVirtual
    )
  ) {
    return muted('NEXT_ROUND');
  }
  const deadline =
    announced.createdAt.getTime() + round.continuationWindowSeconds * 1_000;
  return deadline > now.getTime()
    ? muted('CONTINUATION')
    : muted('NEXT_ROUND');
}

/**
 * 互动群唯一权威阶段策略。输入按 seqNo 倒序排列，通常是当前局和紧邻上一局。
 */
export function deriveRoomChatPolicy(
  recentRounds: ChatPolicyRoundSnapshot[],
  now = new Date(),
): RoomChatPolicy {
  const active = recentRounds.find(
    (round) =>
      round.phase !== RoundPhase.WAITING
      && round.phase !== RoundPhase.FINISHED
      && round.phase !== RoundPhase.CANCELLED,
  );
  const current =
    active
    ?? recentRounds.find((round) => round.phase === RoundPhase.WAITING)
    ?? recentRounds[0];
  if (!current) return OPEN_POLICY;

  if (current.phase === RoundPhase.SENDING_PACKET) return muted('DICE');
  if (current.phase === RoundPhase.CLAIMING) return muted('CLAIMING');
  if (
    current.phase === RoundPhase.CLAIM_EXPIRED
    || current.phase === RoundPhase.SETTLING
  ) {
    return muted('SETTLING');
  }
  if (
    current.phase === RoundPhase.BANKER_BID
    || current.phase === RoundPhase.BETTING
  ) {
    return hasAnnouncement(current, current.phase)
      ? OPEN_POLICY
      : muted('STARTING');
  }
  if (current.phase === RoundPhase.FINISHED) {
    return finishedRoundPolicy(current, now);
  }
  if (current.phase === RoundPhase.CANCELLED) {
    return cancelledAfterDiceStarted(current)
      ? muted('NEXT_ROUND')
      : OPEN_POLICY;
  }
  if (current.phase === RoundPhase.WAITING) {
    const previous = recentRounds.find(
      (round) => round.seqNo === current.seqNo - 1,
    );
    if (previous?.phase === RoundPhase.FINISHED) {
      return finishedRoundPolicy(previous, now);
    }
    if (
      previous?.phase === RoundPhase.CANCELLED
      && cancelledAfterDiceStarted(previous)
    ) {
      return muted('NEXT_ROUND');
    }
  }
  return OPEN_POLICY;
}

/** 仅供已经持有阶段、但不需要区分播报完成状态的内部命令防线。 */
export function phaseChatPolicy(phase: string | null | undefined): RoomChatPolicy {
  if (phase === RoundPhase.SENDING_PACKET) return muted('DICE');
  if (phase === RoundPhase.CLAIMING) return muted('CLAIMING');
  if (phase === RoundPhase.CLAIM_EXPIRED || phase === RoundPhase.SETTLING) {
    return muted('SETTLING');
  }
  return OPEN_POLICY;
}

export function roomChatPolicyMessage(policy: RoomChatPolicy): string {
  switch (policy.stage) {
    case 'DICE':
      return '开骰发包阶段禁止普通发言，请等待下一局开始';
    case 'CLAIMING':
      return '抢红包阶段禁止发言，请专注领取';
    case 'SETTLING':
      return '本局结算及成绩单发布期间禁止发言，请稍候';
    case 'CONTINUATION':
      return '续庄确认期间全员禁言，请由庄家使用续庄按钮确认';
    case 'NEXT_ROUND':
      return '下一局正在准备中，阶段话术发布后即可发言';
    case 'STARTING':
      return '新阶段话术正在发布，发布完成后即可发言';
    default:
      return '当前阶段禁止发言';
  }
}

function continuationWindowSeconds(configSnapshot: unknown): number | null {
  if (!configSnapshot) return null;
  try {
    return parseSettingsSnapshot(configSnapshot).round.continuationWindowSeconds;
  } catch {
    return null;
  }
}

export async function getRoomChatPolicy(
  roomId: string,
  now = new Date(),
): Promise<RoomChatPolicy> {
  const rounds = await prisma.round.findMany({
    where: { roomId },
    orderBy: { seqNo: 'desc' },
    take: 2,
    select: {
      id: true,
      seqNo: true,
      phase: true,
      bankerId: true,
      potCents: true,
      isContinued: true,
      continuationUsed: true,
      cancelReason: true,
      configSnapshot: true,
      events: {
        where: {
          type: {
            in: [
              ROOM_ANNOUNCED_FINISHED,
              CONTINUATION_REJECTED_INSUFFICIENT,
              `ROOM_ANNOUNCED_${RoundPhase.BANKER_BID}`,
              `ROOM_ANNOUNCED_${RoundPhase.BETTING}`,
              `ROOM_ANNOUNCED_${RoundPhase.SENDING_PACKET}`,
              'BANKER_REPOST_WINDOW',
            ],
          },
        },
        select: { type: true, createdAt: true },
      },
    },
  });
  const continuationRound = rounds.find(
    (round) =>
      round.phase === RoundPhase.FINISHED
      && !!round.bankerId
      && !round.isContinued
      && !round.continuationUsed
      && round.events.some((event) => event.type === ROOM_ANNOUNCED_FINISHED),
  );
  let continuationFunding:
    | { roundId: string; sufficient: boolean; autoFundableVirtual: boolean }
    | undefined;
  if (continuationRound?.bankerId && continuationRound.configSnapshot) {
    try {
      const settings = parseSettingsSnapshot(continuationRound.configSnapshot);
      const requiredCents =
        continuationRound.potCents
        + BigInt(
          bankerSeatFee(Number(continuationRound.potCents), settings.fees)
          + settings.fees.serviceFeeCents,
        );
      const banker = await prisma.user.findUnique({
        where: { id: continuationRound.bankerId },
        select: {
          kind: true,
          wallet: { select: { availableCents: true } },
          virtualPlayer: { select: { enabled: true, canContinue: true } },
        },
      });
      if (banker?.wallet) {
        continuationFunding = {
          roundId: continuationRound.id,
          sufficient: banker.wallet.availableCents >= requiredCents,
          autoFundableVirtual:
            banker.kind === UserKind.VIRTUAL
            && banker.virtualPlayer?.enabled === true
            && banker.virtualPlayer.canContinue,
        };
      }
    } catch {
      // 配置异常时交由续庄事务/调度器报错；策略保持禁言，不提前解禁。
    }
  }
  return deriveRoomChatPolicy(
    rounds.map((round) => ({
      ...round,
      continuationWindowSeconds: continuationWindowSeconds(round.configSnapshot),
      continuationFundingSufficient:
        continuationFunding?.roundId === round.id
          ? continuationFunding.sufficient
          : null,
      autoFundableVirtual:
        continuationFunding?.roundId === round.id
          ? continuationFunding.autoFundableVirtual
          : false,
    })),
    now,
  );
}
