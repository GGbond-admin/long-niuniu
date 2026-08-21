import {
  GameAdminAssignmentStatus,
  type GameAdminAssignment,
  type Prisma,
} from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { serializable } from '../lib/transaction.js';
import { getGameBudgetOverview } from './gameBudget.js';
import {
  broadcastRoomMemberModeration,
  systemChat,
} from './roomHub.js';

type Tx = Prisma.TransactionClient;

export const GAME_ADMIN_PERMISSIONS = [
  'SEND_BUDGET_PACKET',
  'MUTE_MEMBERS',
] as const;
export type GameAdminPermission = (typeof GAME_ADMIN_PERMISSIONS)[number];

const PERMISSION_SET = new Set<string>(GAME_ADMIN_PERMISSIONS);

export class GameAdminError extends Error {
  constructor(
    public code: string,
    public details?: Record<string, unknown>,
  ) {
    super(code);
  }
}

export function normalizeGameAdminPermissions(
  permissions: readonly string[],
): GameAdminPermission[] {
  const unique = [...new Set(permissions)];
  if (!unique.length) throw new GameAdminError('GAME_ADMIN_PERMISSION_REQUIRED');
  if (unique.some((permission) => !PERMISSION_SET.has(permission))) {
    throw new GameAdminError('INVALID_GAME_ADMIN_PERMISSION');
  }
  return unique as GameAdminPermission[];
}

async function assignmentIn(
  db: Tx | typeof prisma,
  input: {
    userId: string;
    gameCode: string;
    permission?: GameAdminPermission;
  },
) {
  const assignment = await db.gameAdminAssignment.findUnique({
    where: {
      gameCode_userId: {
        gameCode: input.gameCode,
        userId: input.userId,
      },
    },
    include: {
      user: {
        select: {
          id: true,
          uid: true,
          nickname: true,
          avatarUrl: true,
          status: true,
          kind: true,
        },
      },
      room: {
        select: {
          id: true,
          gameCode: true,
          title: true,
          status: true,
        },
      },
    },
  });
  if (
    !assignment
    || assignment.status !== GameAdminAssignmentStatus.ACTIVE
    || assignment.user.status !== 'ACTIVE'
    || assignment.user.kind !== 'HUMAN'
  ) {
    throw new GameAdminError('GAME_ADMIN_ACCESS_DENIED');
  }
  if (input.permission && !assignment.permissions.includes(input.permission)) {
    throw new GameAdminError('GAME_ADMIN_PERMISSION_DENIED', {
      permission: input.permission,
    });
  }
  return assignment;
}

export function requireGameAdminAssignment(input: {
  userId: string;
  gameCode: string;
  permission?: GameAdminPermission;
}) {
  return assignmentIn(prisma, input);
}

export function requireGameAdminAssignmentInTx(
  tx: Tx,
  input: {
    userId: string;
    gameCode: string;
    permission?: GameAdminPermission;
  },
) {
  return assignmentIn(tx, input);
}

async function assertAssignableUser(
  tx: Tx,
  userId: string,
  permissions: readonly GameAdminPermission[],
) {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      uid: true,
      status: true,
      kind: true,
      tgId: true,
      kyc: { select: { status: true } },
      paymentPin: { select: { isSet: true } },
    },
  });
  if (
    !user
    || user.status !== 'ACTIVE'
    || user.kind !== 'HUMAN'
    || user.tgId === null
  ) {
    throw new GameAdminError('GAME_ADMIN_USER_INELIGIBLE');
  }
  if (
    permissions.includes('SEND_BUDGET_PACKET')
    && (user.kyc?.status !== 'APPROVED' || !user.paymentPin?.isSet)
  ) {
    throw new GameAdminError('GAME_ADMIN_PACKET_SECURITY_REQUIRED');
  }
  return user;
}

export async function createGameAdminAssignment(input: {
  gameCode: string;
  userId: string;
  permissions: string[];
  platformAdminId: string;
  ip?: string;
}) {
  const permissions = normalizeGameAdminPermissions(input.permissions);
  const outcome = await serializable(async (tx) => {
    const room = await tx.room.findUnique({
      where: { gameCode: input.gameCode },
      select: { id: true },
    });
    if (!room) throw new GameAdminError('GAME_NOT_FOUND');
    await assertAssignableUser(tx, input.userId, permissions);
    const existing = await tx.gameAdminAssignment.findUnique({
      where: {
        gameCode_userId: {
          gameCode: input.gameCode,
          userId: input.userId,
        },
      },
    });
    const assignment = existing
      ? await tx.gameAdminAssignment.update({
          where: { id: existing.id },
          data: {
            permissions,
            status: GameAdminAssignmentStatus.ACTIVE,
            updatedBy: input.platformAdminId,
          },
        })
      : await tx.gameAdminAssignment.create({
          data: {
            gameCode: input.gameCode,
            userId: input.userId,
            permissions,
            createdBy: input.platformAdminId,
            updatedBy: input.platformAdminId,
          },
        });
    await tx.roomMember.updateMany({
      where: { roomId: room.id, userId: input.userId },
      data: {
        chatMutedAt: null,
        chatMutedUntil: null,
        chatMuteReason: null,
        chatMutedByAssignmentId: null,
      },
    });
    await tx.auditLog.create({
      data: {
        adminId: input.platformAdminId,
        action: existing ? 'game_admin_reactivate' : 'game_admin_create',
        target: assignment.id,
        ...(existing
          ? {
              before: {
                status: existing.status,
                permissions: existing.permissions,
              },
            }
          : {}),
        after: {
          gameCode: input.gameCode,
          userId: input.userId,
          permissions,
          status: assignment.status,
        },
        ip: input.ip,
      },
    });
    return { assignment, roomId: room.id };
  });
  void broadcastRoomMemberModeration({
    roomId: outcome.roomId,
    userId: input.userId,
    moderation: {
      muted: false,
      mutedAt: null,
      mutedUntil: null,
      reason: null,
    },
  }).catch(() => undefined);
  return outcome.assignment;
}

export async function updateGameAdminAssignment(input: {
  gameCode: string;
  assignmentId: string;
  permissions?: string[];
  status?: GameAdminAssignmentStatus;
  platformAdminId: string;
  ip?: string;
}) {
  if (input.permissions === undefined && input.status === undefined) {
    throw new GameAdminError('GAME_ADMIN_UPDATE_REQUIRED');
  }
  const outcome = await serializable(async (tx) => {
    const existing = await tx.gameAdminAssignment.findUnique({
      where: { id: input.assignmentId },
    });
    if (!existing || existing.gameCode !== input.gameCode) {
      throw new GameAdminError('GAME_ADMIN_ASSIGNMENT_NOT_FOUND');
    }
    const permissions = input.permissions === undefined
      ? (existing.permissions as GameAdminPermission[])
      : normalizeGameAdminPermissions(input.permissions);
    if ((input.status ?? existing.status) === GameAdminAssignmentStatus.ACTIVE) {
      await assertAssignableUser(tx, existing.userId, permissions);
    }
    const assignment = await tx.gameAdminAssignment.update({
      where: { id: existing.id },
      data: {
        permissions,
        status: input.status,
        updatedBy: input.platformAdminId,
      },
    });
    const room = assignment.status === GameAdminAssignmentStatus.ACTIVE
      ? await tx.room.findUniqueOrThrow({
          where: { gameCode: assignment.gameCode },
          select: { id: true },
        })
      : null;
    if (room) {
      await tx.roomMember.updateMany({
        where: { roomId: room.id, userId: assignment.userId },
        data: {
          chatMutedAt: null,
          chatMutedUntil: null,
          chatMuteReason: null,
          chatMutedByAssignmentId: null,
        },
      });
    }
    await tx.auditLog.create({
      data: {
        adminId: input.platformAdminId,
        action:
          input.status === GameAdminAssignmentStatus.DISABLED
            ? 'game_admin_disable'
            : 'game_admin_update',
        target: assignment.id,
        before: {
          permissions: existing.permissions,
          status: existing.status,
        },
        after: {
          permissions: assignment.permissions,
          status: assignment.status,
        },
        ip: input.ip,
      },
    });
    return { assignment, roomId: room?.id ?? null };
  });
  if (outcome.roomId) {
    void broadcastRoomMemberModeration({
      roomId: outcome.roomId,
      userId: outcome.assignment.userId,
      moderation: {
        muted: false,
        mutedAt: null,
        mutedUntil: null,
        reason: null,
      },
    }).catch(() => undefined);
  }
  return outcome.assignment;
}

export async function listGameAdminCandidates(
  gameCode: string,
  query: string | undefined,
  limit = 12,
) {
  const room = await prisma.room.findUnique({
    where: { gameCode },
    select: { id: true },
  });
  if (!room) throw new GameAdminError('GAME_NOT_FOUND');
  const q = query?.trim();
  const users = await prisma.user.findMany({
    where: {
      status: 'ACTIVE',
      kind: 'HUMAN',
      tgId: { not: null },
      ...(q
        ? {
            OR: [
              { uid: { contains: q } },
              { nickname: { contains: q, mode: 'insensitive' } },
              {
                tgUsername: {
                  contains: q.replace(/^@/, ''),
                  mode: 'insensitive',
                },
              },
              { tgDisplayName: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      uid: true,
      nickname: true,
      tgUsername: true,
      tgDisplayName: true,
      avatarUrl: true,
      kyc: { select: { status: true } },
      paymentPin: { select: { isSet: true } },
      gameAdminAssignments: {
        where: { gameCode },
        select: {
          id: true,
          status: true,
          permissions: true,
        },
        take: 1,
      },
    },
    orderBy: { createdAt: 'desc' },
    take: Math.max(1, Math.min(limit, 30)),
  });
  return users.map((user) => ({
    ...user,
    kycStatus: user.kyc?.status ?? 'NONE',
    paymentPinSet: Boolean(user.paymentPin?.isSet),
    assignment: user.gameAdminAssignments[0] ?? null,
    kyc: undefined,
    paymentPin: undefined,
    gameAdminAssignments: undefined,
  }));
}

export async function getPlatformGameAdminOverview(gameCode: string) {
  const [room, assignments, budget, actions] = await Promise.all([
    prisma.room.findUnique({
      where: { gameCode },
      select: {
        id: true,
        gameCode: true,
        title: true,
        status: true,
        supportHost: {
          select: {
            id: true,
            uid: true,
            nickname: true,
            tgUsername: true,
            tgDisplayName: true,
            avatarUrl: true,
            status: true,
          },
        },
      },
    }),
    prisma.gameAdminAssignment.findMany({
      where: { gameCode },
      include: {
        user: {
          select: {
            id: true,
            uid: true,
            nickname: true,
            tgUsername: true,
            tgDisplayName: true,
            avatarUrl: true,
            status: true,
            kyc: { select: { status: true } },
            paymentPin: { select: { isSet: true } },
          },
        },
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
    }),
    getGameBudgetOverview(gameCode),
    prisma.gameAdminActionLog.findMany({
      where: { gameCode },
      include: {
        assignment: {
          select: {
            id: true,
            user: { select: { uid: true, nickname: true } },
          },
        },
        targetUser: { select: { uid: true, nickname: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),
  ]);
  if (!room) throw new GameAdminError('GAME_NOT_FOUND');
  const { supportHost, ...roomFields } = room;
  const ledger = budget.account.id
    ? await prisma.gameBudgetLedgerEntry.findMany({
        where: { budgetAccountId: budget.account.id },
        orderBy: { createdAt: 'desc' },
        take: 40,
      })
    : [];
  return {
    room: roomFields,
    supportHost,
    assignments,
    budget: budget.account,
    ledger,
    actions,
  };
}

export async function listMyGameAdminAssignments(userId: string) {
  const assignments = await prisma.gameAdminAssignment.findMany({
    where: {
      userId,
      status: GameAdminAssignmentStatus.ACTIVE,
      user: { status: 'ACTIVE', kind: 'HUMAN' },
    },
    include: {
      room: {
        select: {
          id: true,
          gameCode: true,
          title: true,
          status: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
  const budgets = await prisma.gameBudgetAccount.findMany({
    where: { gameCode: { in: assignments.map((item) => item.gameCode) } },
    select: { gameCode: true, balanceCents: true, updatedAt: true },
  });
  const budgetByGame = new Map(budgets.map((budget) => [budget.gameCode, budget]));
  return assignments.map((assignment) => ({
    id: assignment.id,
    gameCode: assignment.gameCode,
    permissions: assignment.permissions,
    room: assignment.room,
    budget: budgetByGame.get(assignment.gameCode) ?? {
      gameCode: assignment.gameCode,
      balanceCents: 0n,
      updatedAt: null,
    },
  }));
}

export async function getGameAdminConsole(userId: string, gameCode: string) {
  const assignment = await requireGameAdminAssignment({ userId, gameCode });
  const [budget, recentActions] = await Promise.all([
    getGameBudgetOverview(gameCode),
    prisma.gameAdminActionLog.findMany({
      where: { assignmentId: assignment.id },
      include: {
        targetUser: { select: { uid: true, nickname: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
  ]);
  return {
    assignment: {
      id: assignment.id,
      gameCode: assignment.gameCode,
      permissions: assignment.permissions,
      status: assignment.status,
    },
    room: assignment.room,
    budget: budget.account,
    recentActions,
  };
}

function activeMuteOf(member: {
  chatMutedAt: Date | null;
  chatMutedUntil: Date | null;
  chatMuteReason: string | null;
}) {
  const active =
    member.chatMutedAt !== null
    && (member.chatMutedUntil === null || member.chatMutedUntil.getTime() > Date.now());
  return active
    ? {
        active: true,
        mutedAt: member.chatMutedAt,
        mutedUntil: member.chatMutedUntil,
        reason: member.chatMuteReason,
      }
    : {
        active: false,
        mutedAt: null,
        mutedUntil: null,
        reason: null,
      };
}

export async function listGameAdminMembers(input: {
  actorUserId: string;
  gameCode: string;
  q?: string;
  cursor?: string;
  limit?: number;
}) {
  const assignment = await requireGameAdminAssignment({
    userId: input.actorUserId,
    gameCode: input.gameCode,
  });
  const q = input.q?.trim();
  const limit = Math.max(1, Math.min(input.limit ?? 30, 80));
  const rows = await prisma.roomMember.findMany({
    where: {
      roomId: assignment.room.id,
      status: 'ACTIVE',
      ...(q
        ? {
            user: {
              OR: [
                { uid: { contains: q } },
                { nickname: { contains: q, mode: 'insensitive' } },
                {
                  tgUsername: {
                    contains: q.replace(/^@/, ''),
                    mode: 'insensitive',
                  },
                },
              ],
            },
          }
        : {}),
    },
    include: {
      user: {
        select: {
          id: true,
          uid: true,
          nickname: true,
          tgUsername: true,
          avatarUrl: true,
          gameAdminAssignments: {
            where: {
              gameCode: input.gameCode,
              status: GameAdminAssignmentStatus.ACTIVE,
            },
            select: { id: true },
            take: 1,
          },
        },
      },
    },
    orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    take: limit + 1,
  });
  const items = rows.slice(0, limit).map((member) => ({
    id: member.id,
    user: {
      id: member.user.id,
      uid: member.user.uid,
      nickname: member.user.nickname,
      tgUsername: member.user.tgUsername,
      avatarUrl: member.user.avatarUrl,
    },
    lastSeenAt: member.lastSeenAt,
    online: member.lastSeenAt.getTime() > Date.now() - 90_000,
    isGameAdmin: member.user.gameAdminAssignments.length > 0,
    mute: activeMuteOf(member),
  }));
  return {
    items,
    nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
  };
}

export async function listGameAdminActions(input: {
  actorUserId: string;
  gameCode: string;
  cursor?: string;
  limit?: number;
}) {
  const assignment = await requireGameAdminAssignment({
    userId: input.actorUserId,
    gameCode: input.gameCode,
  });
  const limit = Math.max(1, Math.min(input.limit ?? 30, 100));
  const rows = await prisma.gameAdminActionLog.findMany({
    where: { assignmentId: assignment.id },
    include: {
      targetUser: { select: { uid: true, nickname: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    take: limit + 1,
  });
  return {
    items: rows.slice(0, limit),
    nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
  };
}

function actionMetadata(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function muteGameAdminMember(input: {
  actorUserId: string;
  gameCode: string;
  targetUserId: string;
  durationMinutes: number | null;
  reason: string;
  requestId: string;
  ip?: string;
}) {
  if (
    input.durationMinutes !== null
    && (
      !Number.isInteger(input.durationMinutes)
      || input.durationMinutes < 1
      || input.durationMinutes > 43_200
    )
  ) {
    throw new GameAdminError('INVALID_MUTE_DURATION');
  }
  const outcome = await serializable(async (tx) => {
    const assignment = await requireGameAdminAssignmentInTx(tx, {
      userId: input.actorUserId,
      gameCode: input.gameCode,
      permission: 'MUTE_MEMBERS',
    });
    if (input.targetUserId === input.actorUserId) {
      throw new GameAdminError('CANNOT_MUTE_SELF');
    }
    const member = await tx.roomMember.findUnique({
      where: {
        roomId_userId: {
          roomId: assignment.room.id,
          userId: input.targetUserId,
        },
      },
      include: {
        user: {
          select: {
            id: true,
            uid: true,
            nickname: true,
            status: true,
            kind: true,
          },
        },
      },
    });
    if (
      !member
      || member.status !== 'ACTIVE'
      || member.user.status !== 'ACTIVE'
      || member.user.kind !== 'HUMAN'
    ) {
      throw new GameAdminError('ROOM_MEMBER_NOT_FOUND');
    }
    const protectedAdmin = await tx.gameAdminAssignment.findUnique({
      where: {
        gameCode_userId: {
          gameCode: input.gameCode,
          userId: input.targetUserId,
        },
      },
      select: { status: true },
    });
    if (protectedAdmin?.status === GameAdminAssignmentStatus.ACTIVE) {
      throw new GameAdminError('CANNOT_MUTE_GAME_ADMIN');
    }

    const idempotencyKey = `game-admin-mute:${assignment.id}:${input.requestId}`;
    const existing = await tx.gameAdminActionLog.findUnique({
      where: { idempotencyKey },
    });
    if (existing) {
      const metadata = actionMetadata(existing.metadata);
      if (
        existing.action !== 'MEMBER_MUTE'
        || existing.targetUserId !== input.targetUserId
        || metadata.reason !== input.reason
        || metadata.durationMinutes !== input.durationMinutes
      ) {
        throw new GameAdminError('IDEMPOTENCY_CONFLICT');
      }
      return {
        duplicate: true,
        assignment,
        target: member.user,
        moderation: {
          muted: true,
          mutedAt: String(metadata.mutedAt),
          mutedUntil:
            typeof metadata.mutedUntil === 'string'
              ? metadata.mutedUntil
              : null,
          reason: input.reason,
        },
      };
    }

    const mutedAt = new Date();
    const mutedUntil = input.durationMinutes === null
      ? null
      : new Date(mutedAt.getTime() + input.durationMinutes * 60_000);
    await tx.roomMember.update({
      where: { id: member.id },
      data: {
        chatMutedAt: mutedAt,
        chatMutedUntil: mutedUntil,
        chatMuteReason: input.reason,
        chatMutedByAssignmentId: assignment.id,
      },
    });
    await tx.gameAdminActionLog.create({
      data: {
        assignmentId: assignment.id,
        gameCode: input.gameCode,
        action: 'MEMBER_MUTE',
        targetUserId: input.targetUserId,
        idempotencyKey,
        metadata: {
          targetUid: member.user.uid,
          reason: input.reason,
          durationMinutes: input.durationMinutes,
          mutedAt: mutedAt.toISOString(),
          mutedUntil: mutedUntil?.toISOString() ?? null,
        },
        ip: input.ip,
      },
    });
    return {
      duplicate: false,
      assignment,
      target: member.user,
      moderation: {
        muted: true,
        mutedAt: mutedAt.toISOString(),
        mutedUntil: mutedUntil?.toISOString() ?? null,
        reason: input.reason,
      },
    };
  });

  if (!outcome.duplicate) {
    void broadcastRoomMemberModeration({
      roomId: outcome.assignment.room.id,
      userId: input.targetUserId,
      moderation: outcome.moderation,
    }).catch(() => undefined);
    const untilCopy = outcome.moderation.mutedUntil
      ? `至 ${new Date(outcome.moderation.mutedUntil).toLocaleString('zh-MY', {
          timeZone: 'Asia/Kuala_Lumpur',
          hour12: false,
        })}`
      : '（永久）';
    systemChat(
      outcome.assignment.room.id,
      `${outcome.target.nickname ?? `UID${outcome.target.uid}`} 已被管理员禁言${untilCopy}`,
      { force: true },
    );
  }
  return outcome;
}

export async function unmuteGameAdminMember(input: {
  actorUserId: string;
  gameCode: string;
  targetUserId: string;
  reason: string;
  requestId: string;
  ip?: string;
}) {
  const outcome = await serializable(async (tx) => {
    const assignment = await requireGameAdminAssignmentInTx(tx, {
      userId: input.actorUserId,
      gameCode: input.gameCode,
      permission: 'MUTE_MEMBERS',
    });
    const member = await tx.roomMember.findUnique({
      where: {
        roomId_userId: {
          roomId: assignment.room.id,
          userId: input.targetUserId,
        },
      },
      include: {
        user: {
          select: {
            id: true,
            uid: true,
            nickname: true,
            status: true,
            kind: true,
          },
        },
      },
    });
    if (
      !member
      || member.status !== 'ACTIVE'
      || member.user.status !== 'ACTIVE'
      || member.user.kind !== 'HUMAN'
    ) {
      throw new GameAdminError('ROOM_MEMBER_NOT_FOUND');
    }
    const idempotencyKey = `game-admin-unmute:${assignment.id}:${input.requestId}`;
    const existing = await tx.gameAdminActionLog.findUnique({
      where: { idempotencyKey },
    });
    if (existing) {
      const metadata = actionMetadata(existing.metadata);
      if (
        existing.action !== 'MEMBER_UNMUTE'
        || existing.targetUserId !== input.targetUserId
        || metadata.reason !== input.reason
      ) {
        throw new GameAdminError('IDEMPOTENCY_CONFLICT');
      }
      return { duplicate: true, assignment, target: member.user };
    }
    await tx.roomMember.update({
      where: { id: member.id },
      data: {
        chatMutedAt: null,
        chatMutedUntil: null,
        chatMuteReason: null,
        chatMutedByAssignmentId: null,
      },
    });
    await tx.gameAdminActionLog.create({
      data: {
        assignmentId: assignment.id,
        gameCode: input.gameCode,
        action: 'MEMBER_UNMUTE',
        targetUserId: input.targetUserId,
        idempotencyKey,
        metadata: {
          targetUid: member.user.uid,
          reason: input.reason,
        },
        ip: input.ip,
      },
    });
    return { duplicate: false, assignment, target: member.user };
  });

  if (!outcome.duplicate) {
    void broadcastRoomMemberModeration({
      roomId: outcome.assignment.room.id,
      userId: input.targetUserId,
      moderation: {
        muted: false,
        mutedAt: null,
        mutedUntil: null,
        reason: null,
      },
    }).catch(() => undefined);
    systemChat(
      outcome.assignment.room.id,
      `${outcome.target.nickname ?? `UID${outcome.target.uid}`} 已解除禁言`,
      { force: true },
    );
  }
  return outcome;
}

export function gameAdminPublicAssignment(
  assignment: Pick<GameAdminAssignment, 'id' | 'gameCode' | 'permissions' | 'status'>,
) {
  return {
    id: assignment.id,
    gameCode: assignment.gameCode,
    permissions: assignment.permissions,
    status: assignment.status,
  };
}
