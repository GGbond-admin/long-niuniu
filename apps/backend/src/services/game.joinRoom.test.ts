import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  room: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
  },
  roomMember: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({
  env: { sensitiveDataKey: 'test-key', tngPacketHosts: [] },
}));
vi.mock('../lib/prisma.js', () => ({ prisma: db }));
vi.mock('../lib/transaction.js', () => ({
  serializable: vi.fn(),
}));
vi.mock('./gameSettings.js', () => ({
  getGameSettings: vi.fn(),
  parseSettingsSnapshot: vi.fn(),
  setAssistantService: vi.fn(),
  settingsSnapshot: vi.fn(),
}));
vi.mock('./wallet.js', () => ({
  freezeBanker: vi.fn(),
  transfer: vi.fn(),
  unfreeze: vi.fn(),
}));

import { joinRoom } from './game.js';

const room = {
  id: 'room-1',
  gameCode: 'SUPREME_NIUNIU',
  status: 'ACTIVE',
};
const activeMember = {
  id: 'member-1',
  roomId: room.id,
  userId: 'user-1',
  status: 'ACTIVE',
};

describe('joinRoom 进房热路径', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.room.findFirst.mockResolvedValue(room);
    db.room.findUnique.mockResolvedValue(room);
    db.user.findUnique.mockResolvedValue({
      id: 'user-1',
      status: 'ACTIVE',
      kind: 'PLAYER',
      kyc: { status: 'APPROVED' },
      virtualPlayer: null,
    });
    db.roomMember.findUnique.mockResolvedValue(activeMember);
    db.roomMember.upsert.mockResolvedValue(activeMember);
  });

  it('复用 HTTP 身份与实名校验，活跃成员不重复写库', async () => {
    const result = await joinRoom(room.id, 'user-1', {
      validatedHuman: true,
      allowedGameCodes: ['SUPREME_NIUNIU'],
    });

    expect(result.member).toEqual(activeMember);
    expect(db.room.findFirst).toHaveBeenCalledWith({
      where: {
        id: room.id,
        gameCode: { in: ['SUPREME_NIUNIU'] },
      },
    });
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(db.roomMember.upsert).not.toHaveBeenCalled();
  });

  it('成员已离开时仍恢复为活跃状态', async () => {
    db.roomMember.findUnique.mockResolvedValue({ ...activeMember, status: 'LEFT' });

    await joinRoom(room.id, 'user-1', {
      validatedHuman: true,
      allowedGameCodes: ['SUPREME_NIUNIU'],
    });

    expect(db.roomMember.upsert).toHaveBeenCalledWith({
      where: { roomId_userId: { roomId: room.id, userId: 'user-1' } },
      create: { roomId: room.id, userId: 'user-1' },
      update: { status: 'ACTIVE', lastSeenAt: expect.any(Date) },
    });
  });

  it('内部调用未声明预校验时仍检查用户与实名', async () => {
    await joinRoom(room.id, 'user-1');

    expect(db.room.findUnique).toHaveBeenCalledWith({ where: { id: room.id } });
    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      include: { kyc: true, virtualPlayer: true },
    });
  });
});
