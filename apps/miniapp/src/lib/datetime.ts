function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 红包领取时间：24 小时制，日/月/年 + 时:分:秒，例如 17/08/2026 21:48:32 */
export function formatClaimTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 明细/订单时间：24 小时制，年-月-日 时:分，例如 2026-08-17 21:48 */
export function formatDateTime(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}
