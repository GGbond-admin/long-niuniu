import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const userFindMany = vi.fn(async () => []);
  return {
    userFindMany,
    pushJob: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => ({
        id: 'push-room-1',
        status: 'PROCESSING',
        audience: { type: 'room', roomId: 'room-1' },
        payload: { body: '房间通知' },
        botId: null,
        template: null,
      })),
      update: vi.fn(async () => ({ id: 'push-room-1' })),
    },
  };
});

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    pushJob: mocks.pushJob,
    user: { findMany: mocks.userFindMany },
    pushLog: { findFirst: vi.fn(), create: vi.fn() },
  },
}));

vi.mock('../config.js', () => ({ env: { defaultBotToken: '' } }));
vi.mock('../lib/crypto.js', () => ({ decryptSecret: (value: string) => value }));

import { pushService } from './push.js';

describe('推送任务受众', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('指定房间时只查询该房间的 ACTIVE 成员', async () => {
    await pushService.executeJob('push-room-1');

    expect(mocks.userFindMany).toHaveBeenCalledWith({
      where: {
        status: 'ACTIVE',
        roomMemberships: {
          some: {
            roomId: 'room-1',
            status: 'ACTIVE',
          },
        },
      },
      select: { id: true },
    });
  });

  it('脏受众任务明确失败而不是记录为已发送', async () => {
    mocks.pushJob.findUnique.mockResolvedValueOnce({
      id: 'push-invalid-1',
      status: 'PROCESSING',
      audience: { type: 'unknown' },
      payload: { body: '不得发送' },
      botId: null,
      template: null,
    } as never);

    await expect(pushService.executeJob('push-invalid-1')).rejects.toThrow(
      'INVALID_PUSH_AUDIENCE',
    );
    expect(mocks.userFindMany).not.toHaveBeenCalled();
    expect(mocks.pushJob.update).toHaveBeenCalledWith({
      where: { id: 'push-invalid-1' },
      data: { status: 'FAILED' },
    });
  });
});
