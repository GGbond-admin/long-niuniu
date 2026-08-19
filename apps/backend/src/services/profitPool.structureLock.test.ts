import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);
const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(async () => {
    calls.push('lock');
    return [];
  }),
  gameConfig: {},
  agent: {
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    findUnique: vi.fn(async () => null),
    create: vi.fn(async ({ data }: any) => ({ id: 'agent-1', ...data })),
  },
  user: {
    findUnique: vi.fn(async () => ({
      id: 'user-1',
      uid: '10001',
      kind: 'HUMAN',
      agentBinding: null,
    })),
    findMany: vi.fn(async () => []),
  },
  agentPlayer: {
    createMany: vi.fn(async () => ({ count: 0 })),
  },
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {},
}));
vi.mock('../lib/transaction.js', () => ({
  serializable: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
}));
vi.mock('./gameConfig.js', () => ({
  PLATFORM_CONFIG_SCOPE: 'PLATFORM',
  getGameConfig: vi.fn(async (_scope: string, _key: string, defaults: unknown) => defaults),
  getGameConfigInTransaction: vi.fn(async () => {
    calls.push('read-config');
    return {
      expenseRatio: 0.025,
      bucketBase: 130,
      minReservePoints: 5,
      autoSettle: false,
      tierPresets: [{ label: '代理', points: 50 }],
    };
  }),
  setGameConfigInTransaction: vi.fn(async () => {
    calls.push('write-config');
  }),
}));

import { createAgent, setProfitPoolConfig } from './profitPool.js';

describe('利润池配置与代理树结构锁', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
  });

  it('配置校验与写入均在取得同一事务锁之后执行', async () => {
    await setProfitPoolConfig({ bucketBase: 120 }, 'admin-1');

    expect(calls).toEqual(['lock', 'read-config', 'write-config']);
  });

  it('新增代理同样先取得结构锁并读取事务内配置', async () => {
    await createAgent({
      uid: '10001',
      label: '代理一',
      sharePoints: 50,
      actorId: 'admin-1',
    });

    expect(calls.slice(0, 2)).toEqual(['lock', 'read-config']);
  });
});
