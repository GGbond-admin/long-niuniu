import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FEE_CONFIG,
  bankerBidReserveCents,
  maxAffordableBankerBidCents,
} from './fees.js';

describe('上庄可出金额', () => {
  it('余额须覆盖庄钱 + 上庄费 + 服务费，因此最高可标低于账面余额', () => {
    const available = 1_500_000; // RM 15,000
    const maxBid = maxAffordableBankerBidCents(available, DEFAULT_FEE_CONFIG);
    expect(maxBid % 100).toBe(0);
    expect(maxBid).toBeLessThan(available);
    expect(bankerBidReserveCents(maxBid, DEFAULT_FEE_CONFIG)).toBeLessThanOrEqual(available);
    expect(bankerBidReserveCents(maxBid + 100, DEFAULT_FEE_CONFIG)).toBeGreaterThan(available);
  });

  it('不超过房间最高出价', () => {
    expect(
      maxAffordableBankerBidCents(1_500_000, DEFAULT_FEE_CONFIG, 10_000),
    ).toBe(10_000);
  });

  it('余额只够服务费时无法上庄', () => {
    expect(maxAffordableBankerBidCents(3_800, DEFAULT_FEE_CONFIG)).toBe(0);
  });
});
