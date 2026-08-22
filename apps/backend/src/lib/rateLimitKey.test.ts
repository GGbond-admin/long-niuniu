import { describe, expect, it } from 'vitest';
import { isRateLimitExemptPath, rateLimitKey } from './rateLimitKey.js';

describe('isRateLimitExemptPath', () => {
  it('放行探活与公开头像', () => {
    expect(isRateLimitExemptPath('/healthz')).toBe(true);
    expect(isRateLimitExemptPath('/readyz')).toBe(true);
    expect(isRateLimitExemptPath('/api/public/avatars/a.webp')).toBe(true);
    expect(isRateLimitExemptPath('/api/public/avatars/a.webp?x=1')).toBe(true);
  });

  it('登录与牌局接口仍计入限额', () => {
    expect(isRateLimitExemptPath('/api/auth/login')).toBe(false);
    expect(isRateLimitExemptPath('/api/me')).toBe(false);
    expect(isRateLimitExemptPath('/api/game/room-state?roomId=1')).toBe(false);
  });
});

describe('rateLimitKey', () => {
  const ip = '203.0.113.10';

  it('有效玩家票按 user:id 计', () => {
    expect(
      rateLimitKey({
        authorization: 'Bearer good',
        ip,
        verify: () => ({ sub: 'u1', kind: 'user' }),
      }),
    ).toBe('user:u1');
  });

  it('有效后台票按 admin:id 计', () => {
    expect(
      rateLimitKey({
        authorization: 'Bearer good',
        ip,
        verify: () => ({ sub: 'a1', kind: 'admin' }),
      }),
    ).toBe('admin:a1');
  });

  it('无效票、缺票、伪造 kind 都按 IP 计，避免靠伪造 sub 绕过', () => {
    expect(rateLimitKey({ authorization: undefined, ip, verify: () => ({}) })).toBe(
      `ip:${ip}`,
    );
    expect(
      rateLimitKey({
        authorization: 'Bearer bad',
        ip,
        verify: () => {
          throw new Error('invalid');
        },
      }),
    ).toBe(`ip:${ip}`);
    expect(
      rateLimitKey({
        authorization: 'Bearer forged',
        ip,
        verify: () => ({ sub: 'u1', kind: 'forged' }),
      }),
    ).toBe(`ip:${ip}`);
  });

  it('同一出口 IP 下两个有效用户互不抢桶', () => {
    const verify = (token: string) =>
      token === 'alice' ? { sub: 'alice', kind: 'user' as const } : { sub: 'bob', kind: 'user' as const };
    expect(rateLimitKey({ authorization: 'Bearer alice', ip, verify })).toBe('user:alice');
    expect(rateLimitKey({ authorization: 'Bearer bob', ip, verify })).toBe('user:bob');
  });
});
