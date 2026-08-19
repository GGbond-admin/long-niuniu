import { RoundPhase } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  confirmedChatGameAction,
  isBankerRepostCommand,
  isRoomCommandCandidate,
} from './chatCommands.js';
import { phaseChatPolicy } from './roomChatPolicy.js';

describe('成员禁言期间的游戏指令边界', () => {
  it('普通文字、表情不是游戏指令，服务端可在命令处理前直接拦截', () => {
    expect(isRoomCommandCandidate('大家晚上好')).toBe(false);
    expect(isRoomCommandCandidate('😀')).toBe(false);
    expect(isRoomCommandCandidate('发个红包')).toBe(false);
  });

  it('下注、梭哈、撤回和重推仍进入既有命令处理器', () => {
    expect(isRoomCommandCandidate('100')).toBe(true);
    expect(isRoomCommandCandidate('sh200')).toBe(true);
    expect(isRoomCommandCandidate('0')).toBe(true);
    expect(isRoomCommandCandidate('/重推')).toBe(true);
    expect(isBankerRepostCommand('/重推')).toBe(true);
    expect(isBankerRepostCommand('ChongTui')).toBe(true);
  });

  it('只有服务端确认成功的竞庄或下注才产生游戏动作标识', () => {
    expect(confirmedChatGameAction({ kind: 'ok', action: 'bid', echo: '100' })).toBe('bid');
    expect(confirmedChatGameAction({ kind: 'ok', action: 'bet', echo: '100' })).toBe('bet');
    expect(confirmedChatGameAction({ kind: 'error', action: 'bet', message: '失败' })).toBeUndefined();
    expect(confirmedChatGameAction({ kind: 'ignored' })).toBeUndefined();
  });
});

describe('互动群发言禁言', () => {
  it('从开骰到结算都禁言，竞标与下注阶段由权威播报策略进一步判断', () => {
    expect(phaseChatPolicy(RoundPhase.SENDING_PACKET)).toMatchObject({
      muted: true,
      stage: 'DICE',
    });
    expect(phaseChatPolicy(RoundPhase.CLAIMING).muted).toBe(true);
    expect(phaseChatPolicy(RoundPhase.CLAIM_EXPIRED).muted).toBe(true);
    expect(phaseChatPolicy(RoundPhase.SETTLING).muted).toBe(true);
    expect(phaseChatPolicy(RoundPhase.BETTING).muted).toBe(false);
  });
});
