const STORAGE_PREFIX = 'wallet-request:';
const memory = new Map<string, string>();

function scopedKey(key: string, ownerId: string): string {
  return `${STORAGE_PREFIX}${ownerId}:${key}`;
}

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    const nibble = char === 'x' ? value : (value & 0x3) | 0x8;
    return nibble.toString(16);
  });
}

export function pendingRequestId(key: string, ownerId: string): string {
  const storageKey = scopedKey(key, ownerId);
  const cached = memory.get(storageKey);
  const legacyKey = `${STORAGE_PREFIX}${key}`;
  if (cached) {
    try {
      sessionStorage.removeItem(legacyKey);
    } catch {
      // ignore
    }
    return cached;
  }

  try {
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      sessionStorage.removeItem(legacyKey);
      memory.set(storageKey, stored);
      return stored;
    }
    // 兼容升级前仅保存在 sessionStorage 的待确认请求，并立即迁移到持久存储。
    const legacy = sessionStorage.getItem(legacyKey);
    if (legacy) {
      localStorage.setItem(storageKey, legacy);
      sessionStorage.removeItem(legacyKey);
      memory.set(storageKey, legacy);
      return legacy;
    }
  } catch {
    // 极少数禁用持久存储的 WebView 仍使用进程内兜底。
  }

  const requestId = createRequestId();
  memory.set(storageKey, requestId);
  try {
    localStorage.setItem(storageKey, requestId);
  } catch {
    // Keep the request ID in memory.
  }
  return requestId;
}

export function completeRequest(key: string, requestId: string, ownerId: string): void {
  const storageKey = scopedKey(key, ownerId);
  if (memory.get(storageKey) === requestId) memory.delete(storageKey);
  try {
    if (localStorage.getItem(storageKey) === requestId) {
      localStorage.removeItem(storageKey);
    }
    const legacyKey = `${STORAGE_PREFIX}${key}`;
    if (sessionStorage.getItem(legacyKey) === requestId) sessionStorage.removeItem(legacyKey);
  } catch {
    // Ignore storage access errors.
  }
}
