import { describe, expect, it } from 'vitest';
import { lobbyLoadErrorMessage, shouldKeepCachedLobby, type LobbyData } from './lobbyCache';

describe('lobbyLoadErrorMessage', () => {
  it('限流与超时给出可行动提示，其它失败仍提示检查网络', () => {
    expect(lobbyLoadErrorMessage({ code: 'RATE_LIMITED' })).toBe('操作过于频繁，请稍后再试。');
    expect(lobbyLoadErrorMessage({ code: 'REQUEST_TIMEOUT' })).toBe(
      '网络较慢，房间信息超时，请重试。',
    );
    expect(lobbyLoadErrorMessage(new Error('boom'))).toBe(
      '房间信息加载失败，请检查网络后重试。',
    );
  });
});

describe('shouldKeepCachedLobby', () => {
  it('已有房间缓存时，瞬时失败不该把规则页打成错误卡', () => {
    const lobby = { announcements: [], games: [{ id: 'room-1' }] } as unknown as LobbyData;
    expect(shouldKeepCachedLobby(lobby)).toBe(true);
    expect(shouldKeepCachedLobby(null)).toBe(false);
    expect(shouldKeepCachedLobby({ announcements: [], games: [] })).toBe(false);
  });
});
