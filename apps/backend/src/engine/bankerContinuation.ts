import { RoundPhase } from '@prisma/client';

export type BankerContinuationErrorCode =
  | 'INVALID_PHASE'
  | 'NOT_ROUND_BANKER'
  | 'CONTINUATION_NOT_STARTED'
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
  /** 成绩单与续庄询问话术全部发布后落库的事件时间。 */
  continuationStartedAt: Date | null;
}

export interface ContinuationDestinationRound {
  roomId: string;
  seqNo: number;
  phase: RoundPhase;
}

/**
 * 续庄选择优先于自动开局；选择窗口超时或续庄资格已经用尽时，
 * 必须转入公开竞标，避免「自动开局」关闭时把进行中的牌局链卡在等待页。
 */
export function shouldStartWaitingRound(params: {
  autoStart: boolean;
  continuationError: BankerContinuationErrorCode | null | undefined;
}): boolean {
  if (
    params.continuationError === null
    || params.continuationError === 'CONTINUATION_NOT_STARTED'
  ) {
    return false;
  }
  return (
    params.autoStart
    || params.continuationError === 'CONTINUATION_WINDOW_EXPIRED'
    || params.continuationError === 'CONTINUATION_ALREADY_USED'
  );
}

export function continuationDeadline(
  continuationStartedAt: Date | null,
  windowSeconds: number,
): number | null {
  if (!continuationStartedAt) return null;
  return continuationStartedAt.getTime() + windowSeconds * 1_000;
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
  if (!previous.continuationStartedAt) return 'CONTINUATION_NOT_STARTED';
  if (previous.continuationUsed || previous.isContinued) {
    return 'CONTINUATION_ALREADY_USED';
  }

  const deadline = continuationDeadline(previous.continuationStartedAt, windowSeconds);
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
