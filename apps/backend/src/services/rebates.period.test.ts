import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.hoisted(() => vi.fn(async () => []));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    turnoverDaily: { findMany },
    rebateSettlement: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock('../lib/transaction.js', () => ({
  serializable: vi.fn(),
}));
vi.mock('./gameConfig.js', () => ({
  getGameConfig: vi.fn(),
}));
vi.mock('./push.js', () => ({
  pushService: { sendCustom: vi.fn() },
}));
vi.mock('./wallet.js', () => ({
  transfer: vi.fn(),
}));

import { settleRebates } from './rebates.js';

describe('返水结算日期', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T01:00:00+08:00'));
    vi.clearAllMocks();
  });

  it('业务日未结束前禁止结算，避免后续流水永久漏发', async () => {
    await expect(settleRebates('2026-08-19')).rejects.toThrow(
      'REBATE_PERIOD_NOT_CLOSED',
    );
    expect(findMany).not.toHaveBeenCalled();
  });
});
