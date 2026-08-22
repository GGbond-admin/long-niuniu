import { RoundPhase } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  bankerContinuationError,
  BANKER_REPOST_CANCEL_REASON,
  nextRoundReadyAtMs,
  selectPreviousRoundForWaiting,
  shouldStartWaitingRound,
  type ContinuationDestinationRound,
  type ContinuationSourceRound,
} from './bankerContinuation.js';

const now = new Date('2026-08-07T07:00:10.000Z');

function finishedRound(
  patch: Partial<ContinuationSourceRound> = {},
): ContinuationSourceRound {
  return {
    roomId: 'room-1',
    seqNo: 1,
    phase: RoundPhase.FINISHED,
    bankerId: 'banker-a',
    continuationUsed: false,
    isContinued: false,
    continuationStartedAt: new Date('2026-08-07T07:00:00.000Z'),
    ...patch,
  };
}

function waitingRound(
  patch: Partial<ContinuationDestinationRound> = {},
): ContinuationDestinationRound {
  return {
    roomId: 'room-1',
    seqNo: 2,
    phase: RoundPhase.WAITING,
    ...patch,
  };
}

function check(
  previous: ContinuationSourceRound,
  next: ContinuationDestinationRound | null = waitingRound(),
) {
  return bankerContinuationError({
    previous,
    next,
    userId: 'banker-a',
    windowSeconds: 15,
    now,
  });
}

describe('庄家续庄资格', () => {
  it('竞标中标局结束后，可在窗口内续紧邻下一局', () => {
    expect(check(finishedRound())).toBeNull();
  });

  it('续庄局结束后不得连续坐第三局', () => {
    expect(
      check(
        finishedRound({
          seqNo: 2,
          isContinued: true,
          continuationUsed: true,
        }),
        waitingRound({ seqNo: 3 }),
      ),
    ).toBe('CONTINUATION_ALREADY_USED');
  });

  it('旧局 ID 不能越过中间局续到较新的等待局', () => {
    expect(check(finishedRound(), waitingRound({ seqNo: 3 }))).toBe(
      'NEXT_ROUND_UNAVAILABLE',
    );
  });

  it('只能由紧邻上一局的庄家确认', () => {
    expect(
      bankerContinuationError({
        previous: finishedRound(),
        next: waitingRound(),
        userId: 'player-b',
        windowSeconds: 15,
        now,
      }),
    ).toBe('NOT_ROUND_BANKER');
  });

  it('续庄窗口到点即关闭', () => {
    expect(
      check(
        finishedRound({
          continuationStartedAt: new Date('2026-08-07T06:59:55.000Z'),
        }),
      ),
    ).toBe('CONTINUATION_WINDOW_EXPIRED');
  });

  it('成绩单完成事件落库前不得续庄', () => {
    expect(
      check(finishedRound({ continuationStartedAt: null })),
    ).toBe('CONTINUATION_NOT_STARTED');
  });

  it('竞拍中标 → 续庄 → 强制重拍 → 原庄再中标后重新获得一次续庄资格', () => {
    const firstAuctionWin = finishedRound({
      seqNo: 1,
      bankerId: 'banker-a',
      continuationUsed: false,
      isContinued: false,
    });
    expect(check(firstAuctionWin, waitingRound({ seqNo: 2 }))).toBeNull();

    const continuedRound = finishedRound({
      seqNo: 2,
      bankerId: 'banker-a',
      continuationUsed: true,
      isContinued: true,
    });
    expect(check(continuedRound, waitingRound({ seqNo: 3 }))).toBe(
      'CONTINUATION_ALREADY_USED',
    );

    // 第 3 局经过公开竞标，原庄以最高有效价再次中标；新竞标周期的标记均重置。
    const formerBankerWinsRebid = finishedRound({
      seqNo: 3,
      bankerId: 'banker-a',
      continuationUsed: false,
      isContinued: false,
    });
    expect(check(formerBankerWinsRebid, waitingRound({ seqNo: 4 }))).toBeNull();
  });
});

describe('续庄结束后的下一局推进', () => {
  it('续庄窗口仍开放时，即使自动开局开启也必须等待庄家选择', () => {
    expect(
      shouldStartWaitingRound({
        autoStart: true,
        continuationError: null,
      }),
    ).toBe(false);
  });

  it('成绩单尚未发布完成时，即使自动开局开启也不得推进', () => {
    expect(
      shouldStartWaitingRound({
        autoStart: true,
        continuationError: 'CONTINUATION_NOT_STARTED',
      }),
    ).toBe(false);
  });

  it('续庄超时后，即使自动开局关闭也进入公开竞标', () => {
    expect(
      shouldStartWaitingRound({
        autoStart: false,
        continuationError: 'CONTINUATION_WINDOW_EXPIRED',
      }),
    ).toBe(true);
  });

  it('上一局已经使用续庄资格时，不再等待并直接进入公开竞标', () => {
    expect(
      shouldStartWaitingRound({
        autoStart: false,
        continuationError: 'CONTINUATION_ALREADY_USED',
      }),
    ).toBe(true);
  });

  it('没有续庄超时且自动开局关闭时继续等待运营开局', () => {
    expect(
      shouldStartWaitingRound({
        autoStart: false,
        continuationError: undefined,
      }),
    ).toBe(false);
  });
});

describe('取消局复用序号后的上一局', () => {
  const cancelled = {
    phase: RoundPhase.CANCELLED,
    cancelReason: 'NO_BETS',
    id: 'round-18-cancelled',
  };
  const finished = {
    phase: RoundPhase.FINISHED,
    cancelReason: null,
    id: 'round-17',
  };

  it('普通取消后回退到上一手有效完成局', () => {
    expect(
      selectPreviousRoundForWaiting({
        cancelledAttempt: cancelled,
        lastFinished: finished,
      }),
    ).toEqual(finished);
  });

  it('庄家重推取消仍认同号取消局，以便立刻开替代竞标', () => {
    expect(
      selectPreviousRoundForWaiting({
        cancelledAttempt: {
          ...cancelled,
          cancelReason: BANKER_REPOST_CANCEL_REASON,
        },
        lastFinished: finished,
      }),
    ).toEqual({
      ...cancelled,
      cancelReason: BANKER_REPOST_CANCEL_REASON,
    });
  });
});

describe('成绩单后开下一局延迟', () => {
  it('未公布成绩单时没有开局时刻', () => {
    expect(nextRoundReadyAtMs(null, 10)).toBeNull();
  });

  it('按公布时刻加上后台秒数', () => {
    const announcedAt = new Date('2026-08-07T07:00:00.000Z');
    expect(nextRoundReadyAtMs(announcedAt, 10)).toBe(announcedAt.getTime() + 10_000);
  });
});
