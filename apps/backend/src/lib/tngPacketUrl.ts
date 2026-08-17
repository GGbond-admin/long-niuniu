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

/** TNG App 唤起协议：手机端采集到的原生深链使用该 scheme。 */
export const TNG_DEEP_LINK_SCHEME = 'tngdwallet:';

export type TngDeepLinkCheck =
  | { ok: true; deepLink: string }
  | { ok: false; code: 'INVALID_DEEP_LINK' };

/**
 * 校验手机端回传的 tngdwallet:// 深链。
 * 深链没有可信域名可校验，因此只认「领取红包」这一条路径，并要求带票据参数 p，
 * 避免任意 scheme 内容被存进库后下发给玩家点击。
 */
export function checkTngDeepLink(raw: string): TngDeepLinkCheck {
  const deepLink = raw.trim();
  let url: URL;
  try {
    url = new URL(deepLink);
  } catch {
    return { ok: false, code: 'INVALID_DEEP_LINK' };
  }
  if (url.protocol !== TNG_DEEP_LINK_SCHEME) {
    return { ok: false, code: 'INVALID_DEEP_LINK' };
  }
  // tngdwallet://client/dl/transfer/moneyPacket/claim?p=<票据>&v=2
  if (!/moneypacket\/claim\/?$/i.test(url.pathname)) {
    return { ok: false, code: 'INVALID_DEEP_LINK' };
  }
  const ticket = url.searchParams.get('p');
  if (!ticket || !/^[A-Za-z0-9_-]{16,1024}$/.test(ticket)) {
    return { ok: false, code: 'INVALID_DEEP_LINK' };
  }
  return { ok: true, deepLink };
}

export function isTngDeepLink(raw: string): boolean {
  return raw.trim().toLowerCase().startsWith(`${TNG_DEEP_LINK_SCHEME}//`);
}

export type TngClaimLinkCheck =
  | { ok: true; claimUrl: string; kind: 'https' | 'deeplink'; hostname?: string }
  | {
      ok: false;
      code: 'INVALID_PACKET_URL' | 'INVALID_PACKET_HOST' | 'INVALID_DEEP_LINK';
      hostname?: string;
    };

/**
 * 抢包链接统一校验入口：既接受官方 https 分享链，也接受手机端采集到的 tngdwallet:// 深链。
 * 后台人工发包仍粘贴 https 链，手机端在拿不到分享链时可只回传深链。
 */
export function checkTngClaimLink(raw: string, allowedHosts: string[]): TngClaimLinkCheck {
  if (isTngDeepLink(raw)) {
    const deep = checkTngDeepLink(raw);
    return deep.ok
      ? { ok: true, claimUrl: deep.deepLink, kind: 'deeplink' }
      : { ok: false, code: deep.code };
  }
  const https = checkTngPacketUrl(raw, allowedHosts);
  return https.ok
    ? { ok: true, claimUrl: https.claimUrl, kind: 'https', hostname: https.hostname }
    : { ok: false, code: https.code, hostname: https.hostname };
}
