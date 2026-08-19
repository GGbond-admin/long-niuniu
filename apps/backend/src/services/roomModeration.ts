import { prisma } from '../lib/prisma.js';

export const GLOBAL_ROOM_MUTE_MESSAGE = '互动群当前为全群禁言状态';

export type RoomMuteRecord = {
  chatMutedAt: Date | null;
  chatMuteReason: string | null;
  chatMutedByAdminId?: string | null;
};

export type RoomMuteState = {
  muted: boolean;
  mutedAt: string | null;
  reason: string | null;
};

export function roomMuteStateOf(room: RoomMuteRecord): RoomMuteState {
  return room.chatMutedAt
    ? {
        muted: true,
        mutedAt: room.chatMutedAt.toISOString(),
        reason: room.chatMuteReason,
      }
    : {
        muted: false,
        mutedAt: null,
        reason: null,
      };
}

export async function getRoomMuteState(roomId: string): Promise<RoomMuteState | null> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: {
      chatMutedAt: true,
      chatMuteReason: true,
    },
  });
  return room ? roomMuteStateOf(room) : null;
}

export async function setRoomMuteState(params: {
  roomId: string;
  muted: boolean;
  reason?: string;
  adminId: string;
}) {
  const before = await prisma.room.findUnique({
    where: { id: params.roomId },
    select: {
      id: true,
      chatMutedAt: true,
      chatMuteReason: true,
      chatMutedByAdminId: true,
    },
  });
  if (!before) return null;

  const reason = params.reason?.trim() || '运营全群禁言';
  if (
    params.muted
    && before.chatMutedAt
    && before.chatMuteReason === reason
    && before.chatMutedByAdminId === params.adminId
  ) {
    return { before, room: before, moderation: roomMuteStateOf(before) };
  }
  if (!params.muted && !before.chatMutedAt) {
    return { before, room: before, moderation: roomMuteStateOf(before) };
  }

  const room = await prisma.room.update({
    where: { id: params.roomId },
    data: params.muted
      ? {
          chatMutedAt: new Date(),
          chatMuteReason: reason,
          chatMutedByAdminId: params.adminId,
        }
      : {
          chatMutedAt: null,
          chatMuteReason: null,
          chatMutedByAdminId: null,
        },
    select: {
      id: true,
      chatMutedAt: true,
      chatMuteReason: true,
      chatMutedByAdminId: true,
    },
  });
  return { before, room, moderation: roomMuteStateOf(room) };
}
