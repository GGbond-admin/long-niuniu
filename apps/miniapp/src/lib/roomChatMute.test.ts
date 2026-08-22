import { describe, expect, it } from 'vitest';
import {
  fallbackChatStage,
  roomComposerMuted,
  roomComposerMutedLegacy,
} from './roomChatMute';

describe('抢包阶段底部禁言', () => {
  it('图一对照：服务端给 muted:false 时，旧判断会放开输入框', () => {
    const screenshotOne = {
      phase: 'CLAIMING',
      chatPolicyMuted: false,
      continuationActive: false,
    };
    expect(fallbackChatStage('CLAIMING')).toBe('CLAIMING');
    expect(roomComposerMutedLegacy(screenshotOne)).toBe(false);
    expect(roomComposerMuted(screenshotOne)).toBe(true);
  });

  it('未参与抢包必须收起输入框，走图二禁言条', () => {
    expect(
      roomComposerMuted({
        phase: 'CLAIMING',
        chatPolicyMuted: true,
        continuationActive: false,
      }),
    ).toBe(true);
    expect(roomComposerMuted({ phase: 'CLAIMING' })).toBe(true);
    expect(roomComposerMuted({ phase: 'SENDING_PACKET' })).toBe(true);
    expect(roomComposerMuted({ phase: 'SETTLING' })).toBe(true);
  });

  it('下注阶段在策略解禁后可以发言', () => {
    expect(
      roomComposerMuted({
        phase: 'BETTING',
        chatPolicyMuted: false,
      }),
    ).toBe(false);
    expect(
      roomComposerMutedLegacy({
        phase: 'BETTING',
        chatPolicyMuted: false,
      }),
    ).toBe(false);
  });
});
