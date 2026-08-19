import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({
  renewResults: [] as number[],
  set: vi.fn(async () => 'OK' as string | null),
  eval: vi.fn(async (script: string) => {
    if (script.includes('PEXPIRE')) return memory.renewResults.shift() ?? 1;
    return 1;
  }),
}));

vi.mock('../config.js', () => ({ env: { nodeEnv: 'production' } }));
vi.mock('../lib/redis.js', () => ({
  redis: () => ({
    set: memory.set,
    eval: memory.eval,
  }),
}));

import {
  ScoreboardSyncLockLostError,
  withScoreboardSyncLock,
} from './scoreboardSyncLock.js';

describe('成绩单共享锁 lease', () => {
  beforeEach(() => {
    memory.renewResults.length = 0;
    memory.set.mockClear();
    memory.eval.mockClear();
  });

  it('获取后可在副作用前校验并续租', async () => {
    const result = await withScoreboardSyncLock('round-lock-1', async (lease) => {
      await lease.assertHeld();
      return 'done';
    });

    expect(result).toBe('done');
    expect(memory.set).toHaveBeenCalledWith(
      'niuniu:round:round-lock-1:scoreboard-presentation',
      expect.any(String),
      'PX',
      60_000,
      'NX',
    );
    expect(
      memory.eval.mock.calls.filter(([script]) =>
        String(script).includes('PEXPIRE'),
      ),
    ).toHaveLength(3);
  });

  it('续租发现 token 已失效后立即阻止后续副作用', async () => {
    memory.renewResults.push(1, 0);
    let mutated = false;

    await expect(
      withScoreboardSyncLock('round-lock-lost', async (lease) => {
        await lease.assertHeld();
        mutated = true;
      }),
    ).rejects.toBeInstanceOf(ScoreboardSyncLockLostError);
    expect(mutated).toBe(false);
  });

  it('最后一个操作期间丢锁时不会把任务误报为成功', async () => {
    memory.renewResults.push(1, 0);

    await expect(
      withScoreboardSyncLock('round-lock-final', async () => 'written'),
    ).rejects.toBeInstanceOf(ScoreboardSyncLockLostError);
  });
});
