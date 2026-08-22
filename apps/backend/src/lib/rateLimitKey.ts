export type RateLimitClaims = { sub?: string; kind?: string };

export function isRateLimitExemptPath(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return path === '/healthz' || path === '/readyz' || path.startsWith('/api/public/');
}

/** 已登录按用户分桶，避免同一出口 IP / 反向代理把整桌玩家算成一个人。 */
export function rateLimitKey(opts: {
  authorization?: string;
  ip: string;
  verify: (token: string) => RateLimitClaims;
}): string {
  const header = opts.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    try {
      const claims = opts.verify(header.slice(7));
      if (claims.sub && (claims.kind === 'user' || claims.kind === 'admin')) {
        return `${claims.kind}:${claims.sub}`;
      }
    } catch {
      // 无效票按 IP 计
    }
  }
  return `ip:${opts.ip}`;
}
