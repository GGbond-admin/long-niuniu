import type { GameAdminAssignmentSummary } from './api';

export interface Session {
  uid: string;
  nickname: string;
  avatarUrl?: string;
  onboarding: { inviterBound: boolean; deviceBound: boolean; kycStatus: string };
  security: { paymentPinSet: boolean; paymentPinLockedUntil: string | null };
  pendingInviterUid: string | null;
}

const SESSION_STORAGE_KEY = 'nn_session_v1';

function isSessionShape(value: unknown): value is Session {
  if (!value || typeof value !== 'object') return false;
  const session = value as Session;
  return (
    typeof session.uid === 'string'
    && typeof session.nickname === 'string'
    && !!session.onboarding
    && typeof session.onboarding.inviterBound === 'boolean'
    && typeof session.onboarding.deviceBound === 'boolean'
    && typeof session.onboarding.kycStatus === 'string'
    && !!session.security
    && typeof session.security.paymentPinSet === 'boolean'
  );
}

function readPersistedSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { v?: number; session?: unknown };
    if (parsed?.v !== 1 || !isSessionShape(parsed.session)) return null;
    return parsed.session;
  } catch {
    return null;
  }
}

function persistSession(session: Session | null) {
  try {
    if (!session) {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      return;
    }
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ v: 1, session }));
  } catch {
    // 隐私模式 / 配额不足时仍保留内存缓存
  }
}

/** 跨 Fast Refresh / 组件重挂载 / 再次打开 WebView 保留会话，避免每次都卡在「加载中…」 */
let cachedSession: Session | null = readPersistedSession();
let cachedGameAdminAssignments: GameAdminAssignmentSummary[] | null = null;

export function getCachedSession(): Session | null {
  return cachedSession;
}

export function setCachedSession(session: Session | null) {
  cachedSession = session;
  if (!session) cachedGameAdminAssignments = null;
  persistSession(session);
}

export function getCachedGameAdminAssignments() {
  return cachedGameAdminAssignments;
}

export function setCachedGameAdminAssignments(
  assignments: GameAdminAssignmentSummary[] | null,
) {
  cachedGameAdminAssignments = assignments;
}

const AGENT_REPORT_SEEN_PREFIX = 'nn_agent_report_seen:';

export function getSeenAgentReportPoolId(agentId: string): string | null {
  try {
    return localStorage.getItem(`${AGENT_REPORT_SEEN_PREFIX}${agentId}`);
  } catch {
    return null;
  }
}

export function markAgentReportSeen(agentId: string, poolId: string) {
  try {
    localStorage.setItem(`${AGENT_REPORT_SEEN_PREFIX}${agentId}`, poolId);
  } catch {
    // ignore
  }
}
