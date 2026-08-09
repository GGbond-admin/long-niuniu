import { beforeEach, describe, expect, it, vi } from 'vitest';

const { user } = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    findUniqueOrThrow: vi.fn(),
  },
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: { user },
}));

import { PRESET_AVATAR_URLS } from '../data/presetAvatars.js';
import { upsertUserFromTelegram } from './user.js';

describe('用户默认头像', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('新用户注册时分配系统随机头像，不依赖 Telegram 头像', async () => {
    user.findUnique
      .mockResolvedValueOnce(null) // tgId 不存在
      .mockResolvedValueOnce(null); // 生成的 uid 不冲突
    user.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data);

    const created = await upsertUserFromTelegram({
      id: 10001,
      first_name: '新玩家',
      photo_url: 'https://telegram.example/avatar.jpg',
    });

    expect(PRESET_AVATAR_URLS).toContain(created.avatarUrl);
    expect(created.avatarUrl).not.toBe('https://telegram.example/avatar.jpg');
  });

  it('旧用户头像为空时在登录时补齐系统头像', async () => {
    user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      tgId: 10001n,
      uid: '1234567890',
      nickname: '玩家',
      avatarUrl: null,
      device: null,
      kyc: null,
      wallet: {},
    });
    user.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data);

    const updated = await upsertUserFromTelegram({
      id: 10001,
      first_name: '玩家',
    });

    expect(PRESET_AVATAR_URLS).toContain(updated.avatarUrl);
  });
});
