/** 官方 TNG Money Packet 分享域名（App 分享出来的 short link） */
export const DEFAULT_TNG_PACKET_HOSTS = ['links.tngdigital.com.my'];

/** 从粘贴文本中抽出 https 链接，并去掉尾部标点 */
export function extractTngClaimUrl(raw: string): string {
  const text = raw.trim();
  const match = text.match(/https:\/\/[^\s<>"']+/i);
  return (match?.[0] ?? text).replace(/[),.;，。；）\]\u3002\uFF0C]+$/g, '').trim();
}

export function isAllowedTngPacketHost(hostname: string, allowedHosts: string[]): boolean {
  const host = hostname.toLowerCase();
  if (allowedHosts.length === 0) return true;
  if (allowedHosts.includes(host)) return true;
  // 配置写成 tngdigital.com.my 时，也接受 links.tngdigital.com.my 等子域
  return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export type TngPacketUrlCheck =
  | { ok: true; claimUrl: string; hostname: string }
  | { ok: false; code: 'INVALID_PACKET_URL' | 'INVALID_PACKET_HOST'; hostname?: string };

export function checkTngPacketUrl(raw: string, allowedHosts: string[]): TngPacketUrlCheck {
  const claimUrl = extractTngClaimUrl(raw);
  let url: URL;
  try {
    url = new URL(claimUrl);
  } catch {
    return { ok: false, code: 'INVALID_PACKET_URL' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, code: 'INVALID_PACKET_URL' };
  }
  const hostname = url.hostname.toLowerCase();
  if (!isAllowedTngPacketHost(hostname, allowedHosts)) {
    return { ok: false, code: 'INVALID_PACKET_HOST', hostname };
  }
  // 官方 short link 路径形如 /moneypacket/<token>
  if (
    hostname.endsWith('tngdigital.com.my') &&
    !/^\/moneypacket\/[A-Za-z0-9_-]+\/?$/i.test(url.pathname)
  ) {
    return { ok: false, code: 'INVALID_PACKET_URL' };
  }
  return { ok: true, claimUrl, hostname };
}
