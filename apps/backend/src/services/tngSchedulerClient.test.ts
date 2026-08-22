import { describe, expect, it } from 'vitest';
import {
  generateSchedulerPacketId,
  PACKET_ID_RE,
  signCanonicalRequest,
  signRequest,
} from './tngSchedulerClient.js';

describe('TNG 调度器签名（CALLER_API_SPEC §3.4）', () => {
  const secret = 'test_only_0123456789abcdef0123456789abcdef';
  const timestamp = '1787132400000';
  const nonce = '550e8400-e29b-41d4-a716-446655440000';
  const path = '/api/v1/packets/create';
  const rawBody =
    '{"packetId":"pkt_8f3c2a4d7e914df6b8a0c1e2f3456789","totalAmountCents":10120,"packetCount":124}';

  it('A1 固定向量 contentHash 与 signature 逐字符一致', () => {
    const signed = signCanonicalRequest({ path, rawBody, secret, timestamp, nonce });
    expect(signed.contentHash).toBe('42e196fe24d77467bbcf9e9479eb886d8db8169ed4533561c35f756ba4cfe602');
    expect(signed.signature).toBe('72bff807fb0a2c89559914e4ff97cb761aac7410af83d0bff8b86298ed557fbc');
  });

  it('signRequest 对同一原文写出相同哈希头', () => {
    const signed = signRequest(
      path,
      JSON.parse(rawBody),
      { keyId: 'tng-prod-202608-U', secret },
      { timestamp, nonce, rawBody },
    );
    expect(signed.rawBody).toBe(rawBody);
    expect(signed.headers['X-TNG-Key-Id']).toBe('tng-prod-202608-U');
    expect(signed.headers['X-TNG-Timestamp']).toBe(timestamp);
    expect(signed.headers['X-TNG-Nonce']).toBe(nonce);
    expect(signed.headers['X-TNG-Content-SHA256']).toBe(
      '42e196fe24d77467bbcf9e9479eb886d8db8169ed4533561c35f756ba4cfe602',
    );
    expect(signed.headers['X-TNG-Signature']).toBe(
      '72bff807fb0a2c89559914e4ff97cb761aac7410af83d0bff8b86298ed557fbc',
    );
  });

  it('生成符合 pkt_ + 32 hex 的幂等键', () => {
    const id = generateSchedulerPacketId();
    expect(id).toMatch(PACKET_ID_RE);
    expect(generateSchedulerPacketId()).not.toBe(id);
  });
});
