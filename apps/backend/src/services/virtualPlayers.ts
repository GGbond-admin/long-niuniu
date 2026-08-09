/**
 * 互动群虚拟玩家：真实 User + 钱包 + KYC，后台配置能力后可自动/手动参与牌局。
 */
import { AccountType, KycStatus, Prisma, UserKind, UserStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { isPresetAvatarUrl, pickRandomPresetAvatar } from '../data/presetAvatars.js';
import { pickVirtualNickname } from '../data/virtualPlayerNames.js';
import { blindIndex, encryptSecret, kycSearchHashes } from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';
import { serializable } from '../lib/transaction.js';
import { GameError, joinRoom, leaveRoom, type VirtualCapability } from './game.js';
import { resolveAvatarUrl } from './supportAutoReply.js';
import { generateUid } from './user.js';
import { transfer } from './wallet.js';

export const VIRTUAL_ROOM_CAP = 20;

const capabilityColumn: Record<VirtualCapability, keyof Prisma.VirtualPlayerSelect> = {
  join: 'canJoin',
  chat: 'canChat',
  bid: 'canBid',
  bet: 'canBet',
  allIn: 'canAllIn',
  banker: 'canBanker',
  continue: 'canContinue',
  dice: 'canThrowDice',
  groupPacket: 'canGroupPacket',
  claimSim: 'canClaimSim',
};

export type VirtualPlayerInput = {
  nickname?: string;
  /** 为空或 true 时从真实姓名池随机（房间内去重） */
  autoNickname?: boolean;
  avatarUrl?: string | null;
  roomId: string;
  enabled?: boolean;
  canJoin?: boolean;
  canChat?: boolean;
  canBid?: boolean;
  canBet?: boolean;
  canAllIn?: boolean;
  canBanker?: boolean;
  canContinue?: boolean;
  canThrowDice?: boolean;
  canGroupPacket?: boolean;
  canClaimSim?: boolean;
  bidWeight?: number;
  betRatioMin?: number;
  betRatioMax?: number;
  chatPhrases?: string[];
  targetBalanceCents?: bigint | number | string;
  initialFundCents?: bigint | number | string;
  joinRoom?: boolean;
  createdBy?: string;
};

function asCents(value: bigint | number | string | undefined, fallback: bigint): bigint {
  if (value === undefined || value === null || value === '') return fallback;
  return BigInt(value);
}

function clampRatio(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

async function roomIdentityUsage(roomId: string, excludeUserId?: string) {
  const rows = await prisma.virtualPlayer.findMany({
    where: {
      roomId,
      ...(excludeUserId ? { userId: { not: excludeUserId } } : {}),
    },
    select: {
      user: { select: { nickname: true, avatarUrl: true } },
    },
  });
  return {
    nicknames: rows.map((row) => row.user.nickname).filter((name): name is string => !!name),
    avatars: rows
      .map((row) => row.user.avatarUrl)
      .filter((url): url is string => typeof url === 'string' && url.length > 0),
  };
}

function normalizeAvatarUrl(avatarUrl: string | null | undefined): string | null {
  if (avatarUrl === null) return null;
  if (avatarUrl === undefined || avatarUrl === '') return null;
  if (!isPresetAvatarUrl(avatarUrl)) throw new GameError('INVALID_AVATAR');
  return avatarUrl;
}

function withDisplayAvatar<T extends { user: { avatarUrl: string | null } }>(item: T) {
  return {
    ...item,
    user: {
      ...item.user,
      avatarDisplayUrl: resolveAvatarUrl(item.user.avatarUrl),
    },
  };
}

export async function assertVirtualCapability(
  userId: string,
  capability: VirtualCapability,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      kind: true,
      status: true,
      virtualPlayer: true,
    },
  });
  if (!user || user.status !== UserStatus.ACTIVE) throw new GameError('USER_NOT_ACTIVE');
  if (user.kind !== UserKind.VIRTUAL) return;
  const profile = user.virtualPlayer;
  if (!profile || !profile.enabled) throw new GameError('VIRTUAL_DISABLED');
  const key = capabilityColumn[capability];
  if (key && profile[key as keyof typeof profile] === false) {
    throw new GameError('VIRTUAL_CAPABILITY_DENIED', { capability });
  }
  // 竞标需要同时可做庄
  if (capability === 'bid' && !profile.canBanker) {
    throw new GameError('VIRTUAL_CAPABILITY_DENIED', { capability: 'banker' });
  }
}

export async function listVirtualPlayers(roomId?: string) {
  const items = await prisma.virtualPlayer.findMany({
    where: roomId ? { roomId } : undefined,
    include: {
      user: {
        select: {
          id: true,
          uid: true,
          nickname: true,
          avatarUrl: true,
          status: true,
          kind: true,
          wallet: {
            select: {
              availableCents: true,
              freezeBankerCents: true,
              freezeBetCents: true,
            },
          },
          roomMemberships: {
            where: roomId ? { roomId } : undefined,
            select: { roomId: true, status: true, lastSeenAt: true },
          },
        },
      },
      room: { select: { id: true, title: true, gameCode: true, status: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  return items.map((item) =>
    withDisplayAvatar({
      ...item,
      targetBalanceCents: String(item.targetBalanceCents),
      user: {
        ...item.user,
        wallet: item.user.wallet
          ? {
              availableCents: String(item.user.wallet.availableCents),
              freezeBankerCents: String(item.user.wallet.freezeBankerCents),
              freezeBetCents: String(item.user.wallet.freezeBetCents),
            }
          : null,
      },
    }),
  );
}

export async function createVirtualPlayer(input: VirtualPlayerInput) {
  const room = await prisma.room.findUnique({ where: { id: input.roomId } });
  if (!room) throw new GameError('ROOM_NOT_FOUND');

  const existingCount = await prisma.virtualPlayer.count({ where: { roomId: room.id } });
  if (existingCount >= VIRTUAL_ROOM_CAP) {
    throw new GameError('VIRTUAL_ROOM_CAP', { cap: VIRTUAL_ROOM_CAP });
  }

  const usage = await roomIdentityUsage(room.id);
  const requestedName = input.nickname?.trim() ?? '';
  const nickname =
    !requestedName || input.autoNickname
      ? pickVirtualNickname(usage.nicknames)
      : requestedName;
  if (nickname.length < 2 || nickname.length > 32) {
    throw new GameError('INVALID_NICKNAME');
  }

  let avatarUrl = normalizeAvatarUrl(input.avatarUrl);
  if (!avatarUrl) {
    avatarUrl = pickRandomPresetAvatar(usage.avatars);
  }

  const targetBalanceCents = asCents(input.targetBalanceCents, 500_000n);
  const initialFundCents = asCents(input.initialFundCents, targetBalanceCents);
  const bidWeight = clampRatio(input.bidWeight, 0.7);
  const betRatioMin = clampRatio(input.betRatioMin, 0.05);
  const betRatioMax = Math.max(betRatioMin, clampRatio(input.betRatioMax, 0.2));
  const phrases = Array.isArray(input.chatPhrases)
    ? input.chatPhrases.map((p) => String(p).trim()).filter(Boolean).slice(0, 20)
    : ['lets go', 'nice', 'come on', 'ok', 'good luck', 'one more', 'steady', 'haha'];

  const uid = await generateUid();
  const realName = nickname.slice(0, 40);
  const duitnowId = `VP${uid}`;
  const bankAccount = `90${uid.slice(-10)}`;
  const hashes = kycSearchHashes({ duitnowId, bankAccount });

  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        tgId: null,
        uid,
        nickname,
        avatarUrl,
        kind: UserKind.VIRTUAL,
        status: UserStatus.ACTIVE,
        wallet: { create: {} },
        kyc: {
          create: {
            realName: encryptSecret(realName),
            realNameHash: blindIndex(realName),
            duitnowId: encryptSecret(duitnowId),
            duitnowHash: hashes.duitnowHash,
            bankName: 'VIRTUAL',
            bankAccount: encryptSecret(bankAccount),
            bankAccountHash: hashes.bankAccountHash,
            bankAccountLast4Hash: hashes.bankAccountLast4Hash,
            accountHolder: encryptSecret(realName),
            status: KycStatus.APPROVED,
            reviewedBy: 'SYSTEM',
            reviewedAt: new Date(),
          },
        },
      },
    });
    const profile = await tx.virtualPlayer.create({
      data: {
        userId: user.id,
        roomId: room.id,
        enabled: input.enabled ?? true,
        canJoin: input.canJoin ?? true,
        canChat: input.canChat ?? true,
        canBid: input.canBid ?? true,
        canBet: input.canBet ?? true,
        canAllIn: input.canAllIn ?? false,
        canBanker: input.canBanker ?? true,
        canContinue: input.canContinue ?? false,
        canThrowDice: input.canThrowDice ?? true,
        canGroupPacket: input.canGroupPacket ?? false,
        canClaimSim: input.canClaimSim ?? true,
        bidWeight,
        betRatioMin,
        betRatioMax,
        chatPhrases: phrases,
        targetBalanceCents,
        createdBy: input.createdBy,
      },
    });
    return { user, profile };
  });

  if (initialFundCents > 0n) {
    await fundVirtualPlayer(created.user.id, initialFundCents, input.createdBy, '虚拟玩家初始资金');
  }
  if (input.joinRoom !== false && (input.canJoin ?? true)) {
    await joinRoom(room.id, created.user.id);
  }
  return getVirtualPlayer(created.profile.id);
}

export async function getVirtualPlayer(id: string) {
  const items = await listVirtualPlayers();
  const found = items.find((item) => item.id === id);
  if (!found) throw new GameError('VIRTUAL_NOT_FOUND');
  return found;
}

export async function updateVirtualPlayer(
  id: string,
  patch: Partial<VirtualPlayerInput> & { nickname?: string; avatarUrl?: string | null },
) {
  const existing = await prisma.virtualPlayer.findUnique({
    where: { id },
    include: { user: true },
  });
  if (!existing) throw new GameError('VIRTUAL_NOT_FOUND');

  const data: Prisma.VirtualPlayerUpdateInput = {};
  if (patch.enabled !== undefined) data.enabled = patch.enabled;
  if (patch.canJoin !== undefined) data.canJoin = patch.canJoin;
  if (patch.canChat !== undefined) data.canChat = patch.canChat;
  if (patch.canBid !== undefined) data.canBid = patch.canBid;
  if (patch.canBet !== undefined) data.canBet = patch.canBet;
  if (patch.canAllIn !== undefined) data.canAllIn = patch.canAllIn;
  if (patch.canBanker !== undefined) data.canBanker = patch.canBanker;
  if (patch.canContinue !== undefined) data.canContinue = patch.canContinue;
  if (patch.canThrowDice !== undefined) data.canThrowDice = patch.canThrowDice;
  if (patch.canGroupPacket !== undefined) data.canGroupPacket = patch.canGroupPacket;
  if (patch.canClaimSim !== undefined) data.canClaimSim = patch.canClaimSim;
  if (patch.bidWeight !== undefined) data.bidWeight = clampRatio(patch.bidWeight, existing.bidWeight);
  if (patch.betRatioMin !== undefined) {
    data.betRatioMin = clampRatio(patch.betRatioMin, existing.betRatioMin);
  }
  if (patch.betRatioMax !== undefined) {
    data.betRatioMax = clampRatio(patch.betRatioMax, existing.betRatioMax);
  }
  if (patch.chatPhrases !== undefined) {
    data.chatPhrases = patch.chatPhrases.map((p) => String(p).trim()).filter(Boolean).slice(0, 20);
  }
  if (patch.targetBalanceCents !== undefined) {
    data.targetBalanceCents = asCents(patch.targetBalanceCents, existing.targetBalanceCents);
  }
  const nextRoomId = patch.roomId && patch.roomId !== existing.roomId ? patch.roomId : null;
  if (nextRoomId) {
    const room = await prisma.room.findUnique({ where: { id: nextRoomId } });
    if (!room) throw new GameError('ROOM_NOT_FOUND');
    const existingCount = await prisma.virtualPlayer.count({ where: { roomId: room.id } });
    if (existingCount >= VIRTUAL_ROOM_CAP) {
      throw new GameError('VIRTUAL_ROOM_CAP', { cap: VIRTUAL_ROOM_CAP });
    }
    data.room = { connect: { id: room.id } };
  }

  const previousMembership = await prisma.roomMember.findUnique({
    where: {
      roomId_userId: { roomId: existing.roomId, userId: existing.userId },
    },
    select: { status: true },
  });
  const wasInRoom = previousMembership?.status === 'ACTIVE';

  const nextAvatar =
    patch.avatarUrl !== undefined ? normalizeAvatarUrl(patch.avatarUrl) : undefined;

  await prisma.$transaction(async (tx) => {
    await tx.virtualPlayer.update({ where: { id }, data });
    if (patch.nickname !== undefined || nextAvatar !== undefined) {
      await tx.user.update({
        where: { id: existing.userId },
        data: {
          ...(patch.nickname !== undefined
            ? { nickname: patch.nickname.trim().slice(0, 32) }
            : {}),
          ...(nextAvatar !== undefined ? { avatarUrl: nextAvatar } : {}),
        },
      });
    }
  });

  if (nextRoomId) {
    if (wasInRoom) {
      try {
        await leaveRoom(existing.roomId, existing.userId);
      } catch {
        // 旧群已不在则忽略，继续绑定新群
      }
    }
    const canJoin = patch.canJoin ?? existing.canJoin;
    if (wasInRoom && canJoin) {
      await joinRoom(nextRoomId, existing.userId);
    }
  }

  return getVirtualPlayer(id);
}

/** 为单个虚拟玩家重新抽取真实名 + 系统头像 */
export async function randomizeVirtualIdentity(
  id: string,
  options: { rename?: boolean; reavatar?: boolean } = {},
) {
  const rename = options.rename !== false;
  const reavatar = options.reavatar !== false;
  const existing = await prisma.virtualPlayer.findUnique({
    where: { id },
    include: { user: { select: { id: true, nickname: true, avatarUrl: true } } },
  });
  if (!existing) throw new GameError('VIRTUAL_NOT_FOUND');

  const usage = await roomIdentityUsage(existing.roomId, existing.userId);
  const nickname = rename
    ? pickVirtualNickname(usage.nicknames)
    : (existing.user.nickname ?? pickVirtualNickname(usage.nicknames));
  const avatarUrl = reavatar
    ? pickRandomPresetAvatar(usage.avatars)
    : (existing.user.avatarUrl && isPresetAvatarUrl(existing.user.avatarUrl)
      ? existing.user.avatarUrl
      : pickRandomPresetAvatar(usage.avatars));

  await prisma.user.update({
    where: { id: existing.userId },
    data: { nickname, avatarUrl },
  });
  return getVirtualPlayer(id);
}

/** 批量为虚拟玩家匹配真实名与系统头像（同群尽量不重复头像） */
export async function dressUpVirtualPlayers(roomId?: string) {
  const profiles = await prisma.virtualPlayer.findMany({
    where: roomId ? { roomId } : undefined,
    include: { user: { select: { id: true, nickname: true, avatarUrl: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const usedNamesByRoom = new Map<string, Set<string>>();
  const usedAvatarsByRoom = new Map<string, Set<string>>();
  const updated: string[] = [];

  for (const profile of profiles) {
    const names = usedNamesByRoom.get(profile.roomId) ?? new Set<string>();
    const avatars = usedAvatarsByRoom.get(profile.roomId) ?? new Set<string>();
    usedNamesByRoom.set(profile.roomId, names);
    usedAvatarsByRoom.set(profile.roomId, avatars);

    const nickname = pickVirtualNickname(names);
    const avatarUrl = pickRandomPresetAvatar(avatars);
    names.add(nickname);
    avatars.add(avatarUrl);

    await prisma.user.update({
      where: { id: profile.userId },
      data: { nickname, avatarUrl },
    });
    updated.push(profile.id);
  }

  return {
    count: updated.length,
    items: await listVirtualPlayers(roomId),
  };
}

export async function fundVirtualPlayer(
  userId: string,
  amountCents: bigint,
  operatorId?: string,
  reason = '虚拟玩家补款',
) {
  if (amountCents <= 0n) throw new GameError('INVALID_AMOUNT');
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.kind !== UserKind.VIRTUAL) throw new GameError('VIRTUAL_NOT_FOUND');
  const adjustmentId = randomUUID();
  await serializable(async (tx) => {
    await transfer(tx, {
      amountCents,
      from: { accountType: AccountType.ADJUST_CLEARING },
      to: { userId, accountType: AccountType.USER_AVAILABLE },
      refType: 'adjust',
      refId: adjustmentId,
      idempotencyKey: `virtual-fund:${adjustmentId}`,
      operatorId,
      memo: reason,
    });
  });
  return prisma.wallet.findUniqueOrThrow({ where: { userId } });
}

/** 余额低于目标时补到目标。 */
export async function topUpVirtualIfNeeded(userId: string, operatorId = 'SYSTEM') {
  const profile = await prisma.virtualPlayer.findUnique({
    where: { userId },
    include: { user: { include: { wallet: true } } },
  });
  if (!profile?.enabled || !profile.user.wallet) return null;
  const available = profile.user.wallet.availableCents;
  if (available >= profile.targetBalanceCents) return null;
  const need = profile.targetBalanceCents - available;
  return fundVirtualPlayer(userId, need, operatorId, '虚拟玩家自动补款');
}

export async function joinVirtualPlayer(id: string) {
  const profile = await prisma.virtualPlayer.findUnique({ where: { id } });
  if (!profile) throw new GameError('VIRTUAL_NOT_FOUND');
  if (!profile.enabled || !profile.canJoin) throw new GameError('VIRTUAL_CAPABILITY_DENIED');
  await joinRoom(profile.roomId, profile.userId);
  return getVirtualPlayer(id);
}

export async function leaveVirtualPlayer(id: string) {
  const profile = await prisma.virtualPlayer.findUnique({ where: { id } });
  if (!profile) throw new GameError('VIRTUAL_NOT_FOUND');
  await leaveRoom(profile.roomId, profile.userId);
  return getVirtualPlayer(id);
}

export async function listEnabledVirtualsForRoom(roomId: string) {
  return prisma.virtualPlayer.findMany({
    where: { roomId, enabled: true },
    include: {
      user: {
        select: {
          id: true,
          uid: true,
          nickname: true,
          avatarUrl: true,
          status: true,
          wallet: true,
          roomMemberships: { where: { roomId, status: 'ACTIVE' }, take: 1 },
        },
      },
    },
  });
}
