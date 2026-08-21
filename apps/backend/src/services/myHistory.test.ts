import { describe, expect, it } from 'vitest';
import {
  buildMyHistoryItem,
  summarizeMyHistory,
  type MyHistoryRound,
} from './myHistory.js';

const finishedAt = new Date('2026-08-21T10:00:00.000Z');

function roundWith(scoreboard: MyHistoryRound['scoreboard'], bankerId = 'banker-1'): MyHistoryRound {
  return {
    id: 'round-1',
    seqNo: 12,
    finishedAt,
    bankerId,
    scoreboard,
  };
}

describe('我的战绩：只提取本人结算结果', () => {
  const scoreboard = {
    bankerSummary: {
      userId: 'banker-1',
      uid: '1001',
      nickname: '阿庄',
      claimCents: '888',
      handType: 'DUIZI',
      points: 2,
      netCents: '-15000',
    },
    playerLines: [
      {
        userId: 'player-a',
        uid: '2001',
        nickname: '闲A',
        claimCents: '122',
        betCents: '1000',
        isAllIn: false,
        outcome: 'PLAYER_WIN',
        netCents: '11640',
        handType: 'DUIZI',
        points: 2,
        multiplier: 12,
        shortfallCents: '0',
      },
      {
        userId: 'player-b',
        uid: '2002',
        nickname: '闲B',
        claimCents: '342',
        betCents: '2000',
        isAllIn: true,
        outcome: 'BANKER_WIN',
        netCents: '-2000',
        handType: 'NORMAL',
        points: 9,
        multiplier: 1,
        shortfallCents: '0',
      },
    ],
  };

  it('闲家只看到自己的那一行，不含其他玩家', () => {
    const item = buildMyHistoryItem(roundWith(scoreboard), 'player-a');
    expect(item).toMatchObject({
      roundId: 'round-1',
      seqNo: 12,
      role: 'PLAYER',
      netCents: '11640',
      handLabel: '对子',
      betCents: '1000',
      claimCents: '122',
      isAllIn: false,
      multiplier: 12,
      bankerNickname: '阿庄',
      bankerUid: '1001',
    });
  });

  it('庄家看到庄家结算，而不是闲家行', () => {
    const item = buildMyHistoryItem(roundWith(scoreboard), 'banker-1');
    expect(item).toMatchObject({
      role: 'BANKER',
      netCents: '-15000',
      handLabel: '对子',
      claimCents: '888',
      betCents: null,
      bankerNickname: '阿庄',
    });
  });

  it('未出现在成绩单的用户（例如已撤注）不计入', () => {
    expect(buildMyHistoryItem(roundWith(scoreboard), 'player-c')).toBeNull();
  });

  it('没有成绩单的局次不计入', () => {
    expect(buildMyHistoryItem(roundWith(null), 'player-a')).toBeNull();
  });

  it('汇总只统计本人局次的输赢', () => {
    const items = ['player-a', 'player-b', 'banker-1']
      .map((userId) => buildMyHistoryItem(roundWith(scoreboard), userId))
      .filter((item): item is NonNullable<typeof item> => item !== null);
    expect(summarizeMyHistory(items)).toEqual({
      rounds: 3,
      wins: 1,
      losses: 2,
      ties: 0,
      bankerRounds: 1,
      netCents: '-5360',
    });
  });
});
