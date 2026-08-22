/** 有效局号：取消局不占号。下一局 = 当前最大已完成/进行中局号 + 1。 */
export function nextWaitingSeqNo(maxOccupiedSeqNo: number | null | undefined): number {
  const current = Number(maxOccupiedSeqNo ?? 0);
  if (!Number.isFinite(current) || current < 0) return 1;
  return Math.trunc(current) + 1;
}
