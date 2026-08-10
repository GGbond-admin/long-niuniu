import { describe, expect, it } from 'vitest';
import {
  checkTngPacketUrl,
  extractTngClaimUrl,
  isAllowedTngPacketHost,
} from './tngPacketUrl.js';

const SAMPLE =
  'https://links.tngdigital.com.my/moneypacket/k1X9IvR2igBgBQdxGWnJ';

describe('TNG Money Packet 链接校验', () => {
  it('从分享文案中抽出 https 链接', () => {
    expect(extractTngClaimUrl(`领红包：${SAMPLE} 谢谢`)).toBe(SAMPLE);
    expect(extractTngClaimUrl(`${SAMPLE}。`)).toBe(SAMPLE);
  });

  it('接受官方 links.tngdigital.com.my/moneypacket/…', () => {
    const result = checkTngPacketUrl(SAMPLE, ['links.tngdigital.com.my']);
    expect(result).toEqual({
      ok: true,
      claimUrl: SAMPLE,
      hostname: 'links.tngdigital.com.my',
    });
  });

  it('配置 apex 域名时接受子域 links.', () => {
    expect(isAllowedTngPacketHost('links.tngdigital.com.my', ['tngdigital.com.my'])).toBe(
      true,
    );
    const result = checkTngPacketUrl(SAMPLE, ['tngdigital.com.my']);
    expect(result.ok).toBe(true);
  });

  it('拒绝错误域名', () => {
    const result = checkTngPacketUrl(
      'https://evil.example.com/moneypacket/abc',
      ['links.tngdigital.com.my'],
    );
    expect(result).toMatchObject({ ok: false, code: 'INVALID_PACKET_HOST' });
  });

  it('拒绝非 moneypacket 路径的 tngdigital 链接', () => {
    const result = checkTngPacketUrl(
      'https://links.tngdigital.com.my/other/abc',
      ['links.tngdigital.com.my'],
    );
    expect(result).toMatchObject({ ok: false, code: 'INVALID_PACKET_URL' });
  });

  it('开发空白名单时不拦域名，但仍校验官方路径', () => {
    expect(checkTngPacketUrl(SAMPLE, []).ok).toBe(true);
    expect(
      checkTngPacketUrl('https://links.tngdigital.com.my/foo', []).ok,
    ).toBe(false);
  });
});
