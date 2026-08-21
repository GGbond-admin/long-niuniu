export type UserPickerMode = 'agent' | 'player';

export type UserOptionLike = {
  status: 'ACTIVE' | 'BANNED';
  agent: { label: string } | null;
  binding: { agentId: string; agentLabel: string } | null;
};

export function userOptionAvailability(
  user: UserOptionLike,
  mode: UserPickerMode,
  currentAgentId?: string,
): { allowed: boolean; reason: string } {
  if (user.status !== 'ACTIVE') return { allowed: false, reason: '账号已封禁' };
  if (user.agent) {
    return {
      allowed: false,
      reason: mode === 'agent' ? `已是代理：${user.agent.label}` : '该用户已经是代理',
    };
  }
  if (user.binding) {
    if (mode === 'agent') {
      return { allowed: true, reason: `将从「${user.binding.agentLabel}」解绑` };
    }
    return {
      allowed: false,
      reason:
        user.binding.agentId === currentAgentId
          ? '已归属当前代理'
          : `已归属：${user.binding.agentLabel}`,
    };
  }
  return { allowed: true, reason: mode === 'agent' ? '可设为第一层代理' : '可绑定' };
}
