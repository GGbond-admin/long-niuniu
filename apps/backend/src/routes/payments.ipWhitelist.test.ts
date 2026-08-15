import { describe, expect, it } from 'vitest';
import { ipAllowed } from './payments.js';

describe('VPay 回调 IP 白名单', () => {
  it('未配置时放行（便于联调，上线前必须填写）', () => {
    expect(ipAllowed('203.0.113.7', [])).toBe(true);
  });

  it('精确匹配', () => {
    expect(ipAllowed('203.0.113.7', ['203.0.113.7'])).toBe(true);
    expect(ipAllowed('203.0.113.8', ['203.0.113.7'])).toBe(false);
  });

  it('支持网段前缀通配', () => {
    expect(ipAllowed('203.0.113.55', ['203.0.113.*'])).toBe(true);
    expect(ipAllowed('203.0.114.55', ['203.0.113.*'])).toBe(false);
  });

  it('兼容 IPv4-mapped IPv6 形式', () => {
    expect(ipAllowed('::ffff:203.0.113.7', ['203.0.113.7'])).toBe(true);
    expect(ipAllowed('203.0.113.7', ['::ffff:203.0.113.7'])).toBe(true);
  });

  it('多条白名单命中其一即可', () => {
    expect(ipAllowed('198.51.100.2', ['203.0.113.7', '198.51.100.*'])).toBe(true);
    expect(ipAllowed('192.0.2.9', ['203.0.113.7', '198.51.100.*'])).toBe(false);
  });
});
