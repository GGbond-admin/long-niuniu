import { describe, expect, it } from 'vitest';
import {
  assertIngestLeaseOwner,
  TngIngestError,
} from './tngIngest.js';

describe('TNG 采集设备租约', () => {
  it('拒绝已被重新派单后的旧设备回传链接', () => {
    try {
      assertIngestLeaseOwner('device-b', 'device-a');
      throw new Error('EXPECTED_REJECTION');
    } catch (error) {
      expect(error).toBeInstanceOf(TngIngestError);
      expect((error as TngIngestError).code).toBe('INGEST_LEASE_LOST');
      expect((error as TngIngestError).status).toBe(409);
    }
  });

  it('租约仍属于当前设备时允许回传', () => {
    expect(() => assertIngestLeaseOwner('device-a', 'device-a')).not.toThrow();
  });
});
