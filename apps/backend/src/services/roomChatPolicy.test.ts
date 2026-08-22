import { RoomStartMode, RoundPhase } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  CONTINUATION_REJECTED_INSUFFICIENT,
  deriveRoomChatPolicy,
  resolveRoomChatPolicy,
  ROOM_ANNOUNCED_FINISHED,
  type ChatPolicyRoundSnapshot,
} from './roomChatPolicy.js';

const now = new Date('2026-08-19T10:00:20.000Z');
const auto = { roundStartMode: RoomStartMode.AUTO };
const stopped = { roundStartMode: RoomStartMode.STOPPED };

function round(
  phase: RoundPhase,
  patch: Partial<ChatPolicyRoundSnapshot> = {},
): ChatPolicyRoundSnapshot {
  return {
    id: 'round-2',
    seqNo: 2,
    phase,
    bankerId: 'banker-1',
    isContinued: false,
    continuationUsed: false,
    continuationWindowSeconds: 30,
    events: [],
    ...patch,
  };
}

describe('房间权威聊天策略', () => {
  it('初始 WAITING 可聊天', () => {
    expect(
      deriveRoomChatPolicy([
        round(RoundPhase.WAITING, { id: 'round-1', seqNo: 1 }),
      ], now),
    ).toEqual({ muted: false, stage: null });
  });

  it.each([
    [RoundPhase.SENDING_PACKET, 'DICE'],
    [RoundPhase.CLAIMING, 'CLAIMING'],
    [RoundPhase.CLAIM_EXPIRED, 'SETTLING'],
    [RoundPhase.SETTLING, 'SETTLING'],
  ] as const)('%s 阶段全员禁言并返回 %s', (phase, stage) => {
    expect(deriveRoomChatPolicy([round(phase)], now)).toEqual({
      muted: true,
      stage,
    });
  });

  it.each([RoundPhase.BANKER_BID, RoundPhase.BETTING])(
    '%s 在阶段话术完成前禁言，完成后解禁',
    (phase) => {
      expect(deriveRoomChatPolicy([round(phase)], now)).toEqual({
        muted: true,
        stage: 'STARTING',
      });
      expect(
        deriveRoomChatPolicy([
          round(phase, {
            events: [
              {
                type: `ROOM_ANNOUNCED_${phase}`,
                createdAt: new Date('2026-08-19T10:00:00.000Z'),
              },
            ],
          }),
        ], now),
      ).toEqual({ muted: false, stage: null });
    },
  );

  it('结算后的 WAITING 在成绩单完成前仍按 SETTLING 禁言', () => {
    expect(
      deriveRoomChatPolicy([
        round(RoundPhase.WAITING),
        round(RoundPhase.FINISHED, { id: 'round-1', seqNo: 1 }),
      ], now),
    ).toEqual({ muted: true, stage: 'SETTLING' });
  });

  it('以 ROOM_ANNOUNCED_FINISHED 时间开启续庄窗口', () => {
    const previous = round(RoundPhase.FINISHED, {
      id: 'round-1',
      seqNo: 1,
      events: [
        {
          type: ROOM_ANNOUNCED_FINISHED,
          createdAt: new Date('2026-08-19T10:00:10.000Z'),
        },
      ],
    });
    expect(
      deriveRoomChatPolicy([round(RoundPhase.WAITING), previous], now, auto),
    ).toEqual({ muted: true, stage: 'CONTINUATION' });
  });

  it('续庄资格用完或窗口超时后进入 NEXT_ROUND', () => {
    const announcement = {
      type: ROOM_ANNOUNCED_FINISHED,
      createdAt: new Date('2026-08-19T09:59:00.000Z'),
    };
    expect(
      deriveRoomChatPolicy([
        round(RoundPhase.WAITING),
        round(RoundPhase.FINISHED, {
          id: 'round-1',
          seqNo: 1,
          events: [announcement],
        }),
      ], now, auto),
    ).toEqual({ muted: true, stage: 'NEXT_ROUND' });
    expect(
      deriveRoomChatPolicy([
        round(RoundPhase.WAITING),
        round(RoundPhase.FINISHED, {
          id: 'round-1',
          seqNo: 1,
          continuationUsed: true,
          events: [{ ...announcement, createdAt: now }],
        }),
      ], now, auto),
    ).toEqual({ muted: true, stage: 'NEXT_ROUND' });
    expect(
      deriveRoomChatPolicy([
        round(RoundPhase.WAITING),
        round(RoundPhase.FINISHED, {
          id: 'round-1',
          seqNo: 1,
          events: [
            { ...announcement, createdAt: now },
            {
              type: CONTINUATION_REJECTED_INSUFFICIENT,
              createdAt: now,
            },
          ],
        }),
      ], now, auto),
    ).toEqual({ muted: true, stage: 'NEXT_ROUND' });
  });

  it('真人庄余额不足时直接进入 NEXT_ROUND，虚拟庄自动补款仍保留窗口', () => {
    const previous = round(RoundPhase.FINISHED, {
      id: 'round-1',
      seqNo: 1,
      continuationFundingSufficient: false,
      events: [
        {
          type: ROOM_ANNOUNCED_FINISHED,
          createdAt: now,
        },
      ],
    });
    expect(
      deriveRoomChatPolicy([round(RoundPhase.WAITING), previous], now, auto),
    ).toEqual({ muted: true, stage: 'NEXT_ROUND' });
    expect(
      deriveRoomChatPolicy([
        round(RoundPhase.WAITING),
        { ...previous, autoFundableVirtual: true },
      ], now, auto),
    ).toEqual({ muted: true, stage: 'CONTINUATION' });
  });

  it('开骰后取消的局在替代局话术完成前继续禁言', () => {
    expect(
      deriveRoomChatPolicy([
        round(RoundPhase.WAITING),
        round(RoundPhase.CANCELLED, {
          id: 'round-1',
          seqNo: 1,
          cancelReason: '庄家投骰超时',
          events: [
            {
              type: 'BANKER_REPOST_WINDOW',
              createdAt: new Date('2026-08-19T10:00:00.000Z'),
            },
          ],
        }),
      ], now, auto),
    ).toEqual({ muted: true, stage: 'NEXT_ROUND' });
  });

  it('同一局号取消后重开时，按该号的取消局而不是上一有效局决定禁言', () => {
    expect(
      deriveRoomChatPolicy([
        round(RoundPhase.WAITING, { id: 'round-2b', seqNo: 2 }),
        round(RoundPhase.CANCELLED, {
          id: 'round-2a',
          seqNo: 2,
          cancelReason: '庄家投骰超时',
          events: [
            {
              type: 'BANKER_REPOST_WINDOW',
              createdAt: new Date('2026-08-19T10:00:00.000Z'),
            },
          ],
        }),
        round(RoundPhase.FINISHED, {
          id: 'round-1',
          seqNo: 1,
          events: [
            {
              type: ROOM_ANNOUNCED_FINISHED,
              createdAt: new Date('2026-08-19T09:59:00.000Z'),
            },
          ],
        }),
      ], now, auto),
    ).toEqual({ muted: true, stage: 'NEXT_ROUND' });
  });

  it('游戏已结束或手动单局时，投骰超时取消后不锁在准备下一局', () => {
    const cancelled = round(RoundPhase.CANCELLED, {
      id: 'round-1',
      seqNo: 1,
      cancelReason: '庄家投骰超时',
      events: [
        {
          type: 'BANKER_REPOST_WINDOW',
          createdAt: new Date('2026-08-19T10:00:00.000Z'),
        },
      ],
    });
    expect(
      deriveRoomChatPolicy([round(RoundPhase.WAITING), cancelled], now, stopped),
    ).toEqual({ muted: false, stage: null });
    expect(
      deriveRoomChatPolicy(
        [round(RoundPhase.WAITING), cancelled],
        now,
        { roundStartMode: RoomStartMode.MANUAL },
      ),
    ).toEqual({ muted: false, stage: null });
  });

  it('手动单局下庄家重推仍锁定准备下一局，直到替代局开出', () => {
    expect(
      deriveRoomChatPolicy(
        [
          round(RoundPhase.WAITING),
          round(RoundPhase.CANCELLED, {
            id: 'round-1',
            seqNo: 1,
            cancelReason: '庄家重推',
          }),
        ],
        now,
        { roundStartMode: RoomStartMode.MANUAL },
      ),
    ).toEqual({ muted: true, stage: 'NEXT_ROUND' });
  });

  it('游戏已结束后成绩单发布完毕即解禁，不再显示准备下一局', () => {
    expect(
      deriveRoomChatPolicy(
        [
          round(RoundPhase.WAITING),
          round(RoundPhase.FINISHED, {
            id: 'round-1',
            seqNo: 1,
            events: [
              {
                type: ROOM_ANNOUNCED_FINISHED,
                createdAt: new Date('2026-08-19T10:00:00.000Z'),
              },
            ],
          }),
        ],
        now,
        stopped,
      ),
    ).toEqual({ muted: false, stage: null });
  });

  it('更高局号的历史取消局会把进行中抢包挤出最近 4 条', () => {
    const recentWindow = [
      round(RoundPhase.CANCELLED, { id: 'c-12', seqNo: 12, cancelReason: '人数不足' }),
      round(RoundPhase.CANCELLED, { id: 'c-11', seqNo: 11, cancelReason: '人数不足' }),
      round(RoundPhase.CANCELLED, { id: 'c-10', seqNo: 10, cancelReason: '人数不足' }),
      round(RoundPhase.CANCELLED, { id: 'c-9', seqNo: 9, cancelReason: '人数不足' }),
    ];
    const claiming = round(RoundPhase.CLAIMING, { id: 'live-6', seqNo: 6 });
    expect(deriveRoomChatPolicy(recentWindow, now)).toEqual({
      muted: false,
      stage: null,
    });
    expect(deriveRoomChatPolicy([claiming, ...recentWindow], now)).toEqual({
      muted: true,
      stage: 'CLAIMING',
    });
    expect(
      resolveRoomChatPolicy(deriveRoomChatPolicy(recentWindow, now), claiming.phase),
    ).toEqual({ muted: true, stage: 'CLAIMING' });
  });

  it('最近窗口只有 WAITING/取消局时，进行中抢包仍必须禁言', () => {
    const staleWindow = deriveRoomChatPolicy(
      [
        round(RoundPhase.WAITING, { id: 'round-10', seqNo: 10 }),
        round(RoundPhase.CANCELLED, {
          id: 'round-9c',
          seqNo: 9,
          cancelReason: '人数不足',
        }),
        round(RoundPhase.CANCELLED, {
          id: 'round-9b',
          seqNo: 9,
          cancelReason: '人数不足',
        }),
        round(RoundPhase.CANCELLED, {
          id: 'round-9a',
          seqNo: 9,
          cancelReason: '人数不足',
        }),
      ],
      now,
    );
    expect(staleWindow).toEqual({ muted: false, stage: null });
    expect(resolveRoomChatPolicy(staleWindow, RoundPhase.CLAIMING)).toEqual({
      muted: true,
      stage: 'CLAIMING',
    });
    expect(resolveRoomChatPolicy(staleWindow, RoundPhase.SENDING_PACKET)).toEqual({
      muted: true,
      stage: 'DICE',
    });
    expect(resolveRoomChatPolicy(staleWindow, RoundPhase.SETTLING)).toEqual({
      muted: true,
      stage: 'SETTLING',
    });
  });

  it('没有进行中硬禁言阶段时，保留续庄/准备下一局策略', () => {
    const continuation = {
      muted: true,
      stage: 'CONTINUATION' as const,
    };
    expect(resolveRoomChatPolicy(continuation, RoundPhase.WAITING)).toEqual(
      continuation,
    );
    expect(resolveRoomChatPolicy({ muted: false, stage: null }, RoundPhase.BETTING))
      .toEqual({ muted: false, stage: null });
  });
});
