import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({
  room: {
    id: 'room-1',
    chatMutedAt: null as Date | null,
    chatMuteReason: null as string | null,
    chatMutedByAdminId: null as string | null,
  },
  updates: 0,
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    room: {
      findUnique: vi.fn(async () => ({ ...memory.room })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        memory.updates += 1;
        Object.assign(memory.room, data);
        return { ...memory.room };
      }),
    },
  },
}));

import { roomMuteStateOf, setRoomMuteState } from './roomModeration.js';

describe('互动群全群禁言', () => {
  beforeEach(() => {
    memory.room.chatMutedAt = null;
    memory.room.chatMuteReason = null;
    memory.room.chatMutedByAdminId = null;
    memory.updates = 0;
  });

  it('禁言与解除均返回可实时广播的稳定状态', async () => {
    const muted = await setRoomMuteState({
      roomId: 'room-1',
      muted: true,
      reason: '运营维护',
      adminId: 'admin-1',
    });

    expect(muted?.moderation).toMatchObject({
      muted: true,
      reason: '运营维护',
    });
    expect(muted?.moderation.mutedAt).toEqual(expect.any(String));

    const unmuted = await setRoomMuteState({
      roomId: 'room-1',
      muted: false,
      adminId: 'admin-1',
    });
    expect(unmuted?.moderation).toEqual({
      muted: false,
      mutedAt: null,
      reason: null,
    });
  });

  it('重复相同禁言不会重写时间', async () => {
    const mutedAt = new Date('2026-08-19T12:00:00.000Z');
    memory.room.chatMutedAt = mutedAt;
    memory.room.chatMuteReason = '运营维护';
    memory.room.chatMutedByAdminId = 'admin-1';

    const result = await setRoomMuteState({
      roomId: 'room-1',
      muted: true,
      reason: '运营维护',
      adminId: 'admin-1',
    });

    expect(memory.updates).toBe(0);
    expect(result?.moderation).toEqual({
      muted: true,
      mutedAt: mutedAt.toISOString(),
      reason: '运营维护',
    });
  });

  it('状态序列化不泄漏后台管理员标识', () => {
    expect(roomMuteStateOf({
      chatMutedAt: new Date('2026-08-19T12:00:00.000Z'),
      chatMuteReason: '风控处理',
      chatMutedByAdminId: 'admin-secret',
    })).toEqual({
      muted: true,
      mutedAt: '2026-08-19T12:00:00.000Z',
      reason: '风控处理',
    });
  });
});
