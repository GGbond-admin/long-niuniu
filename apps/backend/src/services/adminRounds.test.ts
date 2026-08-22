import { RoundPhase } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { adminRoundsWhere, isValidAdminRoundPhase } from './adminRounds.js';

describe('后台有效局筛选', () => {
  it('默认包含有效局，以及待核销的取消局红包', () => {
    expect(adminRoundsWhere({ roomId: 'room-1' })).toEqual({
      roomId: 'room-1',
      OR: [
        { phase: { not: RoundPhase.CANCELLED } },
        {
          phase: RoundPhase.CANCELLED,
          packet: {
            sentAt: { not: null },
            status: { not: 'RECONCILED' },
          },
        },
      ],
    });
  });

  it('指定已取消阶段时返回取消局', () => {
    expect(
      adminRoundsWhere({ roomId: 'room-1', phase: RoundPhase.CANCELLED }),
    ).toEqual({
      roomId: 'room-1',
      phase: RoundPhase.CANCELLED,
    });
  });

  it('指定进行中阶段时按该阶段查询', () => {
    expect(
      adminRoundsWhere({ roomId: 'room-1', phase: RoundPhase.BETTING }),
    ).toEqual({
      roomId: 'room-1',
      phase: RoundPhase.BETTING,
    });
  });

  it('取消局不是有效局', () => {
    expect(isValidAdminRoundPhase(RoundPhase.CANCELLED)).toBe(false);
    expect(isValidAdminRoundPhase(RoundPhase.FINISHED)).toBe(true);
  });
});
