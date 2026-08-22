export type LobbyData = {
  announcements: unknown[];
  games: Array<{
    gameCode: string;
    id: string;
    title: string;
    interactionGroupTitle: string;
    inviteLink: string | null;
    kycRequired: boolean;
    online: number;
    round: {
      id: string;
      seqNo: number;
      phase: string;
      bidEndsAt?: string;
      betEndsAt?: string;
      claimEndsAt?: string;
    } | null;
  }>;
};

const LOBBY_CACHE_KEY = 'nn_lobby_v1';

export function readLobbyCache(): LobbyData | null {
  try {
    const raw = sessionStorage.getItem(LOBBY_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LobbyData;
    if (!parsed || !Array.isArray(parsed.games)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeLobbyCache(data: LobbyData) {
  try {
    sessionStorage.setItem(LOBBY_CACHE_KEY, JSON.stringify(data));
  } catch {
    // 隐私模式 / 配额不足时仍用内存态
  }
}

export function lobbyLoadErrorMessage(reason: unknown): string {
  const code = (reason as { code?: string } | null)?.code;
  if (code === 'RATE_LIMITED') return '操作过于频繁，请稍后再试。';
  if (code === 'REQUEST_TIMEOUT') return '网络较慢，房间信息超时，请重试。';
  return '房间信息加载失败，请检查网络后重试。';
}

export function shouldKeepCachedLobby(cached: LobbyData | null): cached is LobbyData {
  return cached != null && cached.games.length > 0;
}
