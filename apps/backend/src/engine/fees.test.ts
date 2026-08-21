import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FEE_CONFIG,
  bankerBidFreezeCents,
  bankerBidReserveCents,
  maxAffordableBankerBidCents,
  packetReserveHeads,
  packetTotal,
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

  it('接近满额上庄时须为房间人数代包费留出可用余额，避免封盘取消', () => {
    const available = 67_994_020; // 庄总积分 679940.2
    const members = 50;
    const heads = packetReserveHeads(members);
    const oldMax = maxAffordableBankerBidCents(available, DEFAULT_FEE_CONFIG);
    const maxBid = maxAffordableBankerBidCents(
      available,
      DEFAULT_FEE_CONFIG,
      Number.MAX_SAFE_INTEGER,
      heads,
    );
    const leftover = available - bankerBidFreezeCents(maxBid, DEFAULT_FEE_CONFIG);
    expect(leftover).toBeGreaterThanOrEqual(packetTotal(heads, DEFAULT_FEE_CONFIG));
    expect(bankerBidReserveCents(maxBid, DEFAULT_FEE_CONFIG, heads)).toBeLessThanOrEqual(available);
    expect(maxBid).toBeLessThan(oldMax);
    // 旧逻辑允许标到接近满额；冻完上庄费+服务费后剩余可用不够 50 人代包费。
    expect(available - bankerBidFreezeCents(oldMax, DEFAULT_FEE_CONFIG)).toBeLessThan(
      packetTotal(heads, DEFAULT_FEE_CONFIG),
    );
  });
});
