import { RoundPhase } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  bankerContinuationError,
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
    finishedAt: new Date('2026-08-07T07:00:00.000Z'),
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
          finishedAt: new Date('2026-08-07T06:59:55.000Z'),
        }),
      ),
    ).toBe('CONTINUATION_WINDOW_EXPIRED');
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
