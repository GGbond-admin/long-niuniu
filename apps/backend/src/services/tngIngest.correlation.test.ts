import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({
  correlation: null as string | null,
}));

const packet = vi.hoisted(() => ({
  updateMany: vi.fn(async ({ data }: { data: { correlation: string } }) => {
    if (memory.correlation !== null) return { count: 0 };
    memory.correlation = data.correlation;
    return { count: 1 };
  }),
  findUnique: vi.fn(async () => ({ correlation: memory.correlation })),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: { packet },
}));

import { assignCorrelation } from './tngIngest.js';

describe('TNG 关联短码并发分配', () => {
  beforeEach(() => {
    memory.correlation = null;
    vi.clearAllMocks();
  });

  it('同一红包并发分配时所有调用都返回数据库最终短码', async () => {
    const [first, second] = await Promise.all([
      assignCorrelation('packet-1'),
      assignCorrelation('packet-1'),
    ]);

    expect(first).toBe(second);
    expect(first).toBe(memory.correlation);
    expect(packet.updateMany).toHaveBeenCalledTimes(2);
  });
});
