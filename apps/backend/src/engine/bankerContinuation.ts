import { RoundPhase } from '@prisma/client';

export type BankerContinuationErrorCode =
  | 'INVALID_PHASE'
  | 'NOT_ROUND_BANKER'
  | 'CONTINUATION_ALREADY_USED'
  | 'CONTINUATION_WINDOW_EXPIRED'
  | 'NEXT_ROUND_UNAVAILABLE';

export interface ContinuationSourceRound {
  roomId: string;
  seqNo: number;
  phase: RoundPhase;
  bankerId: string | null;
  continuationUsed: boolean;
  isContinued: boolean;
  finishedAt: Date | null;
}

export interface ContinuationDestinationRound {
  roomId: string;
  seqNo: number;
  phase: RoundPhase;
}

export function continuationDeadline(
  finishedAt: Date | null,
  windowSeconds: number,
): number | null {
  if (!finishedAt) return null;
  return finishedAt.getTime() + windowSeconds * 1_000;
}

/**
 * 同一轮竞标只允许连续坐庄两局：
 * 竞标中标局可以续一次；续庄局不能再续。下一次公开竞标中标后会开启新资格。
 */
export function bankerContinuationError(params: {
  previous: ContinuationSourceRound;
  next: ContinuationDestinationRound | null;
  userId: string;
  windowSeconds: number;
  now?: Date;
}): BankerContinuationErrorCode | null {
  const { previous, next, userId, windowSeconds } = params;
  const now = params.now ?? new Date();

  if (previous.phase !== RoundPhase.FINISHED) return 'INVALID_PHASE';
  if (previous.bankerId !== userId) return 'NOT_ROUND_BANKER';
  if (previous.continuationUsed || previous.isContinued) {
    return 'CONTINUATION_ALREADY_USED';
  }

  const deadline = continuationDeadline(previous.finishedAt, windowSeconds);
  if (deadline === null || deadline <= now.getTime()) {
    return 'CONTINUATION_WINDOW_EXPIRED';
  }

  if (
    !next
    || next.phase !== RoundPhase.WAITING
    || next.roomId !== previous.roomId
    || next.seqNo !== previous.seqNo + 1
  ) {
    return 'NEXT_ROUND_UNAVAILABLE';
  }

  return null;
}
