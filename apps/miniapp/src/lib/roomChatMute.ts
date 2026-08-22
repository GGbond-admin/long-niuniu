/** 开骰 / 抢包 / 结算：阶段本身就必须收起输入框。 */
export function fallbackChatStage(
  phase: string | undefined,
): 'DICE' | 'CLAIMING' | 'SETTLING' | null {
  if (phase === 'SENDING_PACKET') return 'DICE';
  if (phase === 'CLAIMING') return 'CLAIMING';
  if (phase === 'CLAIM_EXPIRED' || phase === 'SETTLING') return 'SETTLING';
  return null;
}

export function roomComposerMuted(input: {
  phase?: string | null;
  chatPolicyMuted?: boolean | null;
  continuationActive?: boolean;
}): boolean {
  const phaseLocked = fallbackChatStage(input.phase ?? undefined) !== null;
  return Boolean(
    input.continuationActive
    || phaseLocked
    || input.chatPolicyMuted === true,
  );
}

/** 旧判断：`muted: false` 会盖掉抢包阶段，顶栏禁言但底部仍是输入框。 */
export function roomComposerMutedLegacy(input: {
  phase?: string | null;
  chatPolicyMuted?: boolean | null;
  continuationActive?: boolean;
}): boolean {
  return Boolean(
    input.continuationActive
    || (
      input.chatPolicyMuted
      ?? fallbackChatStage(input.phase ?? undefined) !== null
    ),
  );
}
