export interface Session {
  uid: string;
  nickname: string;
  avatarUrl?: string;
  onboarding: { inviterBound: boolean; deviceBound: boolean; kycStatus: string };
  security: { paymentPinSet: boolean; paymentPinLockedUntil: string | null };
  pendingInviterUid: string | null;
}

/** 跨 Fast Refresh / 组件重挂载保留会话，避免整页闪回「加载中…」 */
let cachedSession: Session | null = null;

export function getCachedSession(): Session | null {
  return cachedSession;
}

export function setCachedSession(session: Session | null) {
  cachedSession = session;
}
