/**
 * 网页游戏房实时中心：管理每个房间的 WebSocket 连接、房内聊天与事件广播。
 * 对局状态变化经 gameBus 推送到房间内所有在线客户端。
 * 聊天记录：内存 + Redis 双写，重启后可恢复；每房间保留最近若干条。
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { WebSocket } from 'ws';
import { env } from '../config.js';
import { redis, withRedisLock } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import {
  gameBus,
  type ClaimRecordedEvent,
  type RewardGrantedEvent,
  type RoundTransitionEvent,
} from './gameBus.js';
import {
  isAssistantEnabledFresh,
  isAssistantEnabledSync,
} from './gameSettings.js';
import { buildRoundAnnounceMessages } from './roomAnnounce.js';
import {
  ScoreboardSyncLockLostError,
  type ScoreboardSyncLease,
  withScoreboardSyncLock,
} from './scoreboardSyncLock.js';

export interface RoomClient {
  socket: WebSocket;
  userId: string;
  uid: string;
  nickname: string;
  avatarUrl?: string | null;
}

export interface RoomObserver {
  socket: WebSocket;
  adminId: string;
  username: string;
  role: string;
}

export interface RoomChatMessage {
  id: string;
  /**
   * BANNER: content 为横幅键名；DICE: content 为 "1,5,1"；
   * STICKER: content 为图片 URL；USER_PACKET: content 为群红包 ID；
   * USER_TIP: content 为 JSON { amountCents, target, label? }
   * GAME_PACKET: content 为 JSON { id, roundId, greeting }
   * COUNTDOWN: content 为 JSON { mode, endsAt?, template?, emoji? }
   */
  type:
    | 'TEXT'
    | 'EMOJI'
    | 'SYSTEM'
    | 'BANNER'
    | 'DICE'
    | 'STICKER'
    | 'USER_PACKET'
    | 'USER_TIP'
    | 'GAME_PACKET'
    | 'COUNTDOWN';
  content: string;
  from: { uid: string; nickname: string; avatarUrl?: string | null } | null;
  /** 玩家端发送时的短期关联 ID；用于确认回显，不参与消息幂等。 */
  requestId?: string;
  at: string;
}

export type CountdownPayload = {
  mode: 'bid' | 'bet' | 'claim' | 'lock';
  /** 与顶栏同一截止时间，前端每秒刷新剩余秒数 */
  endsAt?: string;
  /** 文案模板，可用 {{remaining}} */
  template?: string;
  /** lock 模式：当前展示的大号数字（3/2/1） */
  emoji?: string;
};

/** 多局 + 假人发言后仍保留足够历史；Redis 同步防进程重启清空 */
const CHAT_HISTORY_LIMIT = 2_000;
/** 玩家端只保留最近消息窗口，避免大群一次下发/渲染数千条记录 */
const CLIENT_CHAT_HISTORY_LIMIT = 100;
/** 管理观察端保留更长窗口，但同样禁止一次挂载完整 2,000 条。 */
const OBSERVER_CHAT_HISTORY_LIMIT = 300;
const CHAT_REDIS_TTL_SECONDS = 7 * 24 * 60 * 60;
/** 慢客户端积压超过 1 MiB 时主动断开，让其重连后只补最近窗口。 */
const MAX_SOCKET_BUFFER_BYTES = 1 * 1024 * 1024;

const clientsByRoom = new Map<string, Set<RoomClient>>();
const observersByRoom = new Map<string, Set<RoomObserver>>();
const chatHistoryByRoom = new Map<string, RoomChatMessage[]>();
type ChatTombstone = { deletedAt: number; generation: number };
const deletedChatMessageIdsByRoom = new Map<
  string,
  Map<string, ChatTombstone>
>();
const pendingChatMessageIdsByRoom = new Map<string, Map<string, number>>();
const gamePacketMessageInFlight = new Map<string, Promise<RoomChatMessage>>();
const roundAnnouncementInFlight = new Map<string, Promise<void>>();
const ROOM_BROADCAST_CHANNEL = 'niuniu:room:broadcast';
const roomHubInstanceNonce = randomUUID().replaceAll('-', '').slice(0, 10);
const roomHubInstanceId = `${process.pid}:${roomHubInstanceNonce}`;
let roomBroadcastSubscriber: Redis | null = null;
let counter = 0;
let chatTombstoneGeneration = 0;
let wired = false;

function pruneChatTombstones(roomId: string): Map<string, ChatTombstone> {
  const tombstones =
    deletedChatMessageIdsByRoom.get(roomId) ?? new Map<string, ChatTombstone>();
  const cutoff = Date.now() - CHAT_REDIS_TTL_SECONDS * 1_000;
  for (const [messageId, tombstone] of tombstones) {
    if (tombstone.deletedAt < cutoff) tombstones.delete(messageId);
  }
  if (tombstones.size) deletedChatMessageIdsByRoom.set(roomId, tombstones);
  else deletedChatMessageIdsByRoom.delete(roomId);
  return tombstones;
}

function markChatDeleted(roomId: string, messageId: string) {
  const tombstones = pruneChatTombstones(roomId);
  chatTombstoneGeneration += 1;
  tombstones.set(messageId, {
    deletedAt: Date.now(),
    generation: chatTombstoneGeneration,
  });
  deletedChatMessageIdsByRoom.set(roomId, tombstones);
}

function clearChatDeleted(roomId: string, messageId: string) {
  const tombstones = deletedChatMessageIdsByRoom.get(roomId);
  if (!tombstones) return;
  tombstones.delete(messageId);
  if (!tombstones.size) deletedChatMessageIdsByRoom.delete(roomId);
}

function shouldSuppressDeletedChat(
  roomId: string,
  message: Pick<RoomChatMessage, 'id' | 'at'>,
): boolean {
  const tombstone = pruneChatTombstones(roomId).get(message.id);
  if (!tombstone) return false;
  const messageAt = Date.parse(message.at);
  if (Number.isFinite(messageAt) && messageAt > tombstone.deletedAt) {
    // 同一稳定 ID 在缩段后又被合法扩段重建；较新的 Redis 行优先于旧本地 tombstone。
    clearChatDeleted(roomId, message.id);
    return false;
  }
  return true;
}

function pruneChatPending(roomId: string): Map<string, number> {
  const pending = pendingChatMessageIdsByRoom.get(roomId) ?? new Map<string, number>();
  const now = Date.now();
  for (const [messageId, expiresAt] of pending) {
    if (expiresAt <= now) pending.delete(messageId);
  }
  if (pending.size) pendingChatMessageIdsByRoom.set(roomId, pending);
  else pendingChatMessageIdsByRoom.delete(roomId);
  return pending;
}

function markChatPending(roomId: string, messageId: string, ttlMs = 30_000) {
  const pending = pruneChatPending(roomId);
  pending.set(messageId, Date.now() + ttlMs);
  pendingChatMessageIdsByRoom.set(roomId, pending);
}

function clearChatPending(roomId: string, messageId: string) {
  const pending = pendingChatMessageIdsByRoom.get(roomId);
  if (!pending) return;
  pending.delete(messageId);
  if (!pending.size) pendingChatMessageIdsByRoom.delete(roomId);
}

function isChatPending(roomId: string, messageId: string): boolean {
  return pruneChatPending(roomId).has(messageId);
}

function isChatWithinRetention(message: Pick<RoomChatMessage, 'at'>): boolean {
  const sentAt = Date.parse(message.at);
  return !Number.isFinite(sentAt)
    || sentAt >= Date.now() - CHAT_REDIS_TTL_SECONDS * 1_000;
}

function applyClusterChatMutation(roomId: string, payload: unknown) {
  if (!payload || typeof payload !== 'object') return;
  const event = payload as {
    type?: string;
    message?: RoomChatMessage;
    messageId?: string;
    pendingPersistence?: boolean;
  };
  if (
    (event.type === 'chat' || event.type === 'chat_update')
    && event.message?.id
  ) {
    if (shouldSuppressDeletedChat(roomId, event.message)) {
      return;
    }
    clearChatDeleted(roomId, event.message.id);
    if (event.type === 'chat' && event.pendingPersistence === true) {
      markChatPending(roomId, event.message.id, 5_000);
    }
    const history = chatHistoryByRoom.get(roomId) ?? [];
    const index = history.findIndex((message) => message.id === event.message!.id);
    if (index >= 0) history[index] = event.message;
    else history.push(event.message);
    if (history.length > CHAT_HISTORY_LIMIT) {
      history.splice(0, history.length - CHAT_HISTORY_LIMIT);
    }
    chatHistoryByRoom.set(roomId, history);
  } else if (event.type === 'chat_delete' && typeof event.messageId === 'string') {
    clearChatPending(roomId, event.messageId);
    markChatDeleted(roomId, event.messageId);
    const history = chatHistoryByRoom.get(roomId) ?? [];
    chatHistoryByRoom.set(
      roomId,
      history.filter((message) => message.id !== event.messageId),
    );
  }
}
let presenceHeartbeat: NodeJS.Timeout | null = null;

function chatRedisKey(roomId: string) {
  return `room:chat:${roomId}`;
}

function sendRaw(socket: WebSocket, data: string) {
  if (socket.readyState !== socket.OPEN) return;
  if (socket.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
    socket.close(1013, 'SLOW_CLIENT');
    return;
  }
  socket.send(data);
}

function send(client: { socket: WebSocket }, payload: unknown) {
  sendRaw(client.socket, JSON.stringify(payload));
}

export function broadcastToRoom(roomId: string, payload: unknown) {
  const clients = clientsByRoom.get(roomId);
  const observers = observersByRoom.get(roomId);
  if (!clients && !observers) return;
  const data = JSON.stringify(payload);
  for (const group of [clients, observers]) {
    if (!group) continue;
    for (const client of group) {
      sendRaw(client.socket, data);
    }
  }
}

function closeUserConnectionsLocal(userId: string, reason: string): void {
  for (const clients of clientsByRoom.values()) {
    for (const client of clients) {
      if (client.userId === userId && client.socket.readyState === client.socket.OPEN) {
        client.socket.close(4403, reason);
      }
    }
  }
}

/** 设备解绑或支付密码重置后，立即关闭本机及其它实例上的旧玩家连接。 */
export async function invalidateUserConnections(
  userId: string,
  reason = 'DEVICE_SESSION_EXPIRED',
): Promise<void> {
  closeUserConnectionsLocal(userId, reason);
  try {
    await redis().publish(
      ROOM_BROADCAST_CHANNEL,
      JSON.stringify({
        origin: roomHubInstanceId,
        control: 'close_user',
        userId,
        reason,
      }),
    );
  } catch {
    // authVersion 仍会在下一次消息或周期校验时 fail-closed。
  }
}

export async function broadcastToRoomCluster(
  roomId: string,
  payload: unknown,
): Promise<void> {
  broadcastToRoom(roomId, payload);
  try {
    await redis().publish(
      ROOM_BROADCAST_CHANNEL,
      JSON.stringify({ origin: roomHubInstanceId, roomId, payload }),
    );
  } catch (error) {
    if (env.nodeEnv === 'production') throw error;
  }
}

function roomClusterEnvelope(
  roomId: string,
  payload: unknown,
  fenced = false,
): string {
  return JSON.stringify({
    origin: roomHubInstanceId,
    roomId,
    payload,
    ...(fenced ? { fenced: true } : {}),
  });
}

async function publishFencedRoomMutation(
  lease: ScoreboardSyncLease,
  roomId: string,
  payload: unknown,
): Promise<void> {
  if (!lease.fence) {
    await broadcastToRoomCluster(roomId, payload);
    return;
  }
  const published = await redis().eval(
    `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('PUBLISH', ARGV[2], ARGV[3])
return 1
    `,
    1,
    lease.fence.key,
    lease.fence.token,
    ROOM_BROADCAST_CHANNEL,
    roomClusterEnvelope(roomId, payload, true),
  );
  if (Number(published) !== 1) throw new ScoreboardSyncLockLostError();
}

async function broadcastToAllRoomsCluster(payload: unknown): Promise<void> {
  broadcastToAllRooms(payload);
  try {
    await redis().publish(
      ROOM_BROADCAST_CHANNEL,
      JSON.stringify({
        origin: roomHubInstanceId,
        control: 'broadcast_all',
        payload,
      }),
    );
  } catch (error) {
    if (env.nodeEnv === 'production') throw error;
  }
}

/** 用户修改头像/昵称后，同步当前连接与各实例中的群聊界面。 */
export async function broadcastUserProfileChanged(user: {
  id: string;
  uid: string;
  nickname: string | null;
  avatarUrl: string | null;
}): Promise<void> {
  const nickname = user.nickname ?? user.uid;
  for (const [roomId, clients] of clientsByRoom) {
    for (const client of clients) {
      if (client.userId !== user.id) continue;
      client.nickname = nickname;
      client.avatarUrl = user.avatarUrl;
    }
    const history = chatHistoryByRoom.get(roomId);
    if (!history) continue;
    chatHistoryByRoom.set(
      roomId,
      history.map((message) =>
        message.from?.uid === user.uid
          ? {
              ...message,
              from: { uid: user.uid, nickname, avatarUrl: user.avatarUrl },
            }
          : message,
      ),
    );
  }

  const memberships = await prisma.roomMember.findMany({
    where: { userId: user.id, status: 'ACTIVE' },
    select: { roomId: true },
  });
  const roomIds: string[] = [
    ...new Set<string>(
      memberships.map((membership: { roomId: string }) => membership.roomId),
    ),
  ];
  await Promise.all(
    roomIds.map((roomId) =>
      broadcastToRoomCluster(roomId, {
        type: 'profile_update',
        user: { uid: user.uid, nickname, avatarUrl: user.avatarUrl },
      }),
    ),
  );
}

/** 纯同步心跳：只通知客户端拉取最新牌桌状态，不重复下发聊天历史。 */
export async function rebroadcastRoomState(params: {
  roomId: string;
  roundId: string;
  phase: string;
  /** 周期恢复心跳；客户端可随机错峰拉取状态，避免惊群。 */
  heartbeat?: boolean;
}): Promise<void> {
  await broadcastToRoomCluster(params.roomId, {
    type: 'round',
    roundId: params.roundId,
    from: params.phase,
    to: params.phase,
    heartbeat: params.heartbeat === true,
  });
}

async function startRoomBroadcastSubscriber(): Promise<void> {
  if (roomBroadcastSubscriber) return;
  const subscriber = redis().duplicate();
  roomBroadcastSubscriber = subscriber;
  subscriber.on('message', (channel, raw) => {
    if (channel !== ROOM_BROADCAST_CHANNEL) return;
    try {
      const event = JSON.parse(raw) as {
        origin?: string;
        roomId?: string;
        payload?: unknown;
        control?: string;
        userId?: string;
        reason?: string;
        fenced?: boolean;
      };
      if (event.origin === roomHubInstanceId && event.fenced !== true) return;
      if (event.control === 'close_user' && typeof event.userId === 'string') {
        closeUserConnectionsLocal(
          event.userId,
          typeof event.reason === 'string' ? event.reason : 'DEVICE_SESSION_EXPIRED',
        );
        return;
      }
      if (event.control === 'broadcast_all') {
        broadcastToAllRooms(event.payload);
        return;
      }
      if (typeof event.roomId !== 'string') return;
      applyClusterChatMutation(event.roomId, event.payload);
      broadcastToRoom(event.roomId, event.payload);
    } catch {
      // 忽略其它应用误发到同名频道的无效载荷。
    }
  });
  subscriber.on('error', () => undefined);
  try {
    if (subscriber.status === 'wait') await subscriber.connect();
    await subscriber.subscribe(ROOM_BROADCAST_CHANNEL);
  } catch {
    roomBroadcastSubscriber = null;
    subscriber.disconnect();
    const retry = setTimeout(() => {
      void startRoomBroadcastSubscriber();
    }, 1_000);
    retry.unref?.();
  }
}

export function broadcastToRoomObservers(roomId: string, payload: unknown) {
  const observers = observersByRoom.get(roomId);
  if (!observers) return;
  const data = JSON.stringify(payload);
  for (const observer of observers) {
    sendRaw(observer.socket, data);
  }
}

export function broadcastToAllRooms(payload: unknown) {
  const roomIds = new Set([...clientsByRoom.keys(), ...observersByRoom.keys()]);
  for (const roomId of roomIds) broadcastToRoom(roomId, payload);
}

export function onlineCount(roomId: string): number {
  return clientsByRoom.get(roomId)?.size ?? 0;
}

/**
 * 大屏在线口径使用数据库心跳，确保多实例下仍可汇总。
 * 每房间一次 updateMany，不按 socket 逐条写；断线后 90 秒自然离线。
 */
async function touchConnectedRoomMembers(): Promise<void> {
  const touchedAt = new Date();
  await Promise.all(
    [...clientsByRoom.entries()].map(([roomId, clients]) => {
      const userIds = [...new Set([...clients].map((client) => client.userId))];
      if (!userIds.length) return Promise.resolve();
      return prisma.roomMember.updateMany({
        where: { roomId, userId: { in: userIds }, status: 'ACTIVE' },
        data: { lastSeenAt: touchedAt },
      });
    }),
  );
}

async function persistChatStrict(
  roomId: string,
  message: RoomChatMessage,
  lease?: ScoreboardSyncLease,
): Promise<void> {
  try {
    const instance = redis();
    const key = chatRedisKey(roomId);
    if (lease?.fence) {
      const fenced = await instance.eval(
        `
if redis.call('GET', KEYS[2]) ~= ARGV[4] then
  return 0
end
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], -tonumber(ARGV[2]), -1)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
redis.call('PUBLISH', ARGV[5], ARGV[6])
return 1
        `,
        2,
        key,
        lease.fence.key,
        JSON.stringify(message),
        String(CHAT_HISTORY_LIMIT),
        String(CHAT_REDIS_TTL_SECONDS),
        lease.fence.token,
        ROOM_BROADCAST_CHANNEL,
        roomClusterEnvelope(
          roomId,
          { type: 'chat', message },
          true,
        ),
      );
      if (Number(fenced) !== 1) throw new ScoreboardSyncLockLostError();
    } else {
      await instance.rpush(key, JSON.stringify(message));
      await instance.ltrim(key, -CHAT_HISTORY_LIMIT, -1);
      await instance.expire(key, CHAT_REDIS_TTL_SECONDS);
    }
  } catch (error) {
    if (error instanceof ScoreboardSyncLockLostError) throw error;
    // 开发环境允许内存降级；生产关键时序必须等 Redis 成功后才能写完成标记。
    if (env.nodeEnv === 'production') throw error;
  }
}

async function replacePersistedChatStrict(
  roomId: string,
  message: RoomChatMessage,
  insertIfMissing = true,
  lease?: ScoreboardSyncLease,
): Promise<boolean> {
  try {
    const instance = redis();
    const key = chatRedisKey(roomId);
    const result = await instance.eval(
      `
if KEYS[2] and redis.call('GET', KEYS[2]) ~= ARGV[6] then
  return -1
end
local rows = redis.call('LRANGE', KEYS[1], 0, -1)
local replaced = false
for index, row in ipairs(rows) do
  local ok, parsed = pcall(cjson.decode, row)
  if ok and parsed.id == ARGV[1] then
    rows[index] = ARGV[2]
    replaced = true
  end
end
if not replaced and ARGV[5] == '1' then
  table.insert(rows, ARGV[2])
end
redis.call('DEL', KEYS[1])
if #rows > 0 then
  redis.call('RPUSH', KEYS[1], unpack(rows))
  redis.call('LTRIM', KEYS[1], -tonumber(ARGV[3]), -1)
end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
if KEYS[2] and (replaced or ARGV[5] == '1') then
  redis.call('PUBLISH', ARGV[7], ARGV[8])
end
return replaced and 1 or 0
      `,
      lease?.fence ? 2 : 1,
      key,
      ...(lease?.fence ? [lease.fence.key] : []),
      message.id,
      JSON.stringify(message),
      String(CHAT_HISTORY_LIMIT),
      String(CHAT_REDIS_TTL_SECONDS),
      insertIfMissing ? '1' : '0',
      lease?.fence?.token ?? '',
      lease?.fence ? ROOM_BROADCAST_CHANNEL : '',
      lease?.fence
        ? roomClusterEnvelope(
            roomId,
            { type: 'chat_update', message },
            true,
          )
        : '',
    );
    if (Number(result) === -1) throw new ScoreboardSyncLockLostError();
    return Number(result) === 1;
  } catch (error) {
    if (error instanceof ScoreboardSyncLockLostError) throw error;
    if (env.nodeEnv === 'production') throw error;
    return true;
  }
}

function persistChat(roomId: string, message: RoomChatMessage) {
  markChatPending(roomId, message.id);
  void persistChatStrict(roomId, message)
    .catch(() => undefined)
    .finally(() => clearChatPending(roomId, message.id));
}

export function appendChat(
  roomId: string,
  message: Omit<RoomChatMessage, 'id' | 'at'>,
): RoomChatMessage {
  const full: RoomChatMessage = {
    ...message,
    // 加入实例随机前缀，避免多进程在同一毫秒生成相同 ID 后被客户端错误去重。
    id: `m${Date.now().toString(36)}${roomHubInstanceNonce}${(counter++).toString(36)}`,
    at: new Date().toISOString(),
  };
  clearChatDeleted(roomId, full.id);
  const history = chatHistoryByRoom.get(roomId) ?? [];
  history.push(full);
  if (history.length > CHAT_HISTORY_LIMIT) history.splice(0, history.length - CHAT_HISTORY_LIMIT);
  chatHistoryByRoom.set(roomId, history);
  persistChat(roomId, full);
  void broadcastToRoomCluster(roomId, {
    type: 'chat',
    message: full,
    pendingPersistence: true,
  }).catch(() => undefined);
  return full;
}

/**
 * 使用确定性 ID 追加关键时序消息，并等待 Redis 持久化。
 * 重放时按 ID 合并并重新广播，客户端也按 ID 去重。
 */
export async function appendChatOnce(
  roomId: string,
  id: string,
  message: Omit<RoomChatMessage, 'id' | 'at'>,
  lease?: ScoreboardSyncLease,
): Promise<RoomChatMessage> {
  const history = await loadChatHistory(roomId);
  const existing = history.find((item) => item.id === id);
  if (existing) {
    if (existing.type !== message.type || existing.content !== message.content) {
      const next: RoomChatMessage = { ...existing, ...message, id };
      await replacePersistedChatStrict(roomId, next, true, lease);
      if (lease?.fence) return next;
      const current = chatHistoryByRoom.get(roomId) ?? [];
      const index = current.findIndex((item) => item.id === id);
      if (index >= 0) current[index] = next;
      else current.push(next);
      chatHistoryByRoom.set(roomId, current);
      await lease?.assertHeld();
      await broadcastToRoomCluster(roomId, { type: 'chat_update', message: next });
      return next;
    }
    if (lease?.fence) {
      await publishFencedRoomMutation(lease, roomId, {
        type: 'chat',
        message: existing,
      });
      return existing;
    }
    await lease?.assertHeld();
    await broadcastToRoomCluster(roomId, { type: 'chat', message: existing });
    return existing;
  }

  const full: RoomChatMessage = {
    ...message,
    id,
    at: new Date().toISOString(),
  };
  if (!lease?.fence) clearChatDeleted(roomId, id);
  await persistChatStrict(roomId, full, lease);
  if (lease?.fence) return full;
  const current = chatHistoryByRoom.get(roomId) ?? [];
  if (!current.some((item) => item.id === id)) current.push(full);
  if (current.length > CHAT_HISTORY_LIMIT) {
    current.splice(0, current.length - CHAT_HISTORY_LIMIT);
  }
  chatHistoryByRoom.set(roomId, current);
  await lease?.assertHeld();
  await broadcastToRoomCluster(roomId, { type: 'chat', message: full });
  return full;
}

/** 仅更新仍存在于聊天历史中的消息；历史已过期时返回 null，禁止静默追加旧成绩单。 */
async function invalidateMissingChat(
  roomId: string,
  messageId: string,
  lease?: ScoreboardSyncLease,
) {
  if (lease?.fence) {
    await publishFencedRoomMutation(lease, roomId, {
      type: 'chat_delete',
      messageId,
    });
    return;
  }
  clearChatPending(roomId, messageId);
  markChatDeleted(roomId, messageId);
  chatHistoryByRoom.set(
    roomId,
    (chatHistoryByRoom.get(roomId) ?? []).filter(
      (message) => message.id !== messageId,
    ),
  );
  await lease?.assertHeld();
  await broadcastToRoomCluster(roomId, { type: 'chat_delete', messageId });
}

export async function updateChatStrict(
  roomId: string,
  messageId: string,
  patch: Partial<Pick<RoomChatMessage, 'type' | 'content'>>,
  lease?: ScoreboardSyncLease,
): Promise<RoomChatMessage | null> {
  const history = await loadChatHistory(roomId);
  const existing = history.find((item) => item.id === messageId);
  if (!existing) {
    await invalidateMissingChat(roomId, messageId, lease);
    return null;
  }
  const next: RoomChatMessage = { ...existing, ...patch, id: messageId };
  const replaced = await replacePersistedChatStrict(roomId, next, false, lease);
  if (!replaced) {
    await invalidateMissingChat(roomId, messageId, lease);
    return null;
  }
  if (lease?.fence) return next;
  const current = chatHistoryByRoom.get(roomId) ?? [];
  const index = current.findIndex((item) => item.id === messageId);
  if (index >= 0) current[index] = next;
  else current.push(next);
  chatHistoryByRoom.set(roomId, current);
  await lease?.assertHeld();
  await broadcastToRoomCluster(roomId, { type: 'chat_update', message: next });
  return next;
}

export async function existingChatMessageIds(
  roomId: string,
  messageIds: readonly string[],
): Promise<string[]> {
  if (!messageIds.length) return [];
  const wanted = new Set(messageIds);
  const editableSince = Date.now() - CHAT_REDIS_TTL_SECONDS * 1_000;
  const history = await loadChatHistory(roomId);
  return history.flatMap((message) => {
    const sentAt = Date.parse(message.at);
    return wanted.has(message.id)
      && Number.isFinite(sentAt)
      && sentAt >= editableSince
      ? [message.id]
      : [];
  });
}

export async function existingChatMessagesByPrefix(
  roomId: string,
  prefix: string,
): Promise<RoomChatMessage[]> {
  const editableSince = Date.now() - CHAT_REDIS_TTL_SECONDS * 1_000;
  return (await loadChatHistory(roomId))
    .filter((message) => {
      const sentAt = Date.parse(message.at);
      return message.id.startsWith(prefix)
        && Number.isFinite(sentAt)
        && sentAt >= editableSince;
    })
    .sort((left, right) => {
      const leftIndex = Number(left.id.slice(prefix.length));
      const rightIndex = Number(right.id.slice(prefix.length));
      if (Number.isFinite(leftIndex) && Number.isFinite(rightIndex)) {
        return leftIndex - rightIndex;
      }
      return left.at.localeCompare(right.at);
    });
}

/** 删除成绩单缩减后多余的历史分段，并让所有在线客户端同步移除。 */
export async function deleteChatStrict(
  roomId: string,
  messageId: string,
  lease?: ScoreboardSyncLease,
): Promise<boolean> {
  const history = await loadChatHistory(roomId);
  if (!history.some((message) => message.id === messageId)) {
    await invalidateMissingChat(roomId, messageId, lease);
    return false;
  }
  const nextHistory = history.filter((message) => message.id !== messageId);
  let removed = true;
  try {
    const instance = redis();
    const key = chatRedisKey(roomId);
    const result = await instance.eval(
      `
if KEYS[2] and redis.call('GET', KEYS[2]) ~= ARGV[4] then
  return -1
end
local rows = redis.call('LRANGE', KEYS[1], 0, -1)
local kept = {}
local removed = false
for _, row in ipairs(rows) do
  local ok, parsed = pcall(cjson.decode, row)
  if ok and parsed.id == ARGV[1] then
    removed = true
  else
    table.insert(kept, row)
  end
end
redis.call('DEL', KEYS[1])
if #kept > 0 then
  redis.call('RPUSH', KEYS[1], unpack(kept))
  redis.call('LTRIM', KEYS[1], -tonumber(ARGV[2]), -1)
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
end
if KEYS[2] then
  redis.call('PUBLISH', ARGV[5], ARGV[6])
end
return removed and 1 or 0
      `,
      lease?.fence ? 2 : 1,
      key,
      ...(lease?.fence ? [lease.fence.key] : []),
      messageId,
      String(CHAT_HISTORY_LIMIT),
      String(CHAT_REDIS_TTL_SECONDS),
      lease?.fence?.token ?? '',
      lease?.fence ? ROOM_BROADCAST_CHANNEL : '',
      lease?.fence
        ? roomClusterEnvelope(
            roomId,
            { type: 'chat_delete', messageId },
            true,
          )
        : '',
    );
    if (Number(result) === -1) throw new ScoreboardSyncLockLostError();
    removed = Number(result) === 1;
  } catch (error) {
    if (error instanceof ScoreboardSyncLockLostError) throw error;
    if (env.nodeEnv === 'production') throw error;
  }
  if (lease?.fence) return removed;
  await lease?.assertHeld();
  chatHistoryByRoom.set(roomId, nextHistory);
  markChatDeleted(roomId, messageId);
  await broadcastToRoomCluster(roomId, { type: 'chat_delete', messageId });
  return removed;
}

export async function appendAssistantChatOnce(
  roomId: string,
  id: string,
  message: Omit<RoomChatMessage, 'id' | 'at' | 'from'>,
): Promise<RoomChatMessage | null> {
  if (!(await isAssistantEnabledFresh(roomId))) return null;
  return appendChatOnce(roomId, id, { ...message, from: null });
}

export async function appendSystemChatOnce(
  roomId: string,
  id: string,
  content: string,
): Promise<RoomChatMessage | null> {
  return appendAssistantChatOnce(roomId, id, { type: 'SYSTEM', content });
}

/**
 * 小助手系统发言。暂停小助手后默认静默；运营接管强制发言传 force: true。
 */
export function systemChat(
  roomId: string,
  content: string,
  options?: { force?: boolean },
): RoomChatMessage | null {
  if (!options?.force && !isAssistantEnabledSync(roomId)) return null;
  return appendChat(roomId, { type: 'SYSTEM', content, from: null });
}

export function systemBanner(
  roomId: string,
  key: string,
  options?: { force?: boolean },
): RoomChatMessage | null {
  if (!options?.force && !isAssistantEnabledSync(roomId)) return null;
  return appendChat(roomId, { type: 'BANNER', content: key, from: null });
}

/**
 * 对局红包必须作为聊天时间线中的真实事件存在，才能稳定排在「开始抢包」之前。
 * packetId 去重可避免管理员重复提交或调度重试产生两个红包卡。
 */
export function appendGamePacketMessage(
  roomId: string,
  payload: { packetId: string; roundId: string; greeting?: string },
): Promise<RoomChatMessage> {
  const key = `${roomId}:${payload.packetId}`;
  const pending = gamePacketMessageInFlight.get(key);
  if (pending) return pending;

  const task = (async () => {
    try {
      return appendChatOnce(roomId, `game-packet:${payload.packetId}`, {
        type: 'GAME_PACKET',
        content: JSON.stringify({
          id: payload.packetId,
          roundId: payload.roundId,
          greeting: payload.greeting ?? '恭喜发财，大吉大利',
        }),
        from: null,
      });
    } finally {
      gamePacketMessageInFlight.delete(key);
    }
  })();
  gamePacketMessageInFlight.set(key, task);
  return task;
}

function announcementEventType(to: string): string {
  return `ROOM_ANNOUNCED_${to}`;
}

function announcementEventId(roundId: string, to: string): string {
  return `room-announced:${roundId}:${to}`;
}

function isUniqueConstraintError(error: unknown): boolean {
  return !!error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'P2002';
}

/**
 * 阶段话术采用「每局每阶段至多一次」标记；崩溃恢复或并发 transition 可安全重放。
 * 只有全部消息确实写入聊天时间线后才记完成，暂停小助手时不会误放行后续阶段。
 */
export function ensureRoundAnnouncement(params: {
  roundId: string;
  roomId: string;
  to: string;
}): Promise<void> {
  const key = `${params.roundId}:${params.to}`;
  const pending = roundAnnouncementInFlight.get(key);
  if (pending) return pending;

  const task = (async () => {
    try {
      const type = announcementEventType(params.to);
      const eventId = announcementEventId(params.roundId, params.to);
      // TTL 需覆盖抢包阶段 3×2 秒的错峰延迟，避免播报中途锁过期
      const completed = await withRedisLock(
        `niuniu:round:${params.roundId}:announce:${params.to}`,
        20_000,
        async () => {
          const existing = await prisma.roundEvent.findFirst({
            where: { roundId: params.roundId, type },
            select: { id: true },
          });
          if (existing) return true;

          const publish = async (
            lease?: ScoreboardSyncLease,
            attempt = 0,
          ): Promise<boolean> => {
            await lease?.assertHeld();
            const scoreboardRevision =
              params.to === 'FINISHED'
                ? await prisma.roundScoreboard.findUnique({
                    where: { roundId: params.roundId },
                    select: {
                      presentationRevision: true,
                      publishedChatMessageIds: true,
                    },
                  })
                : null;
            const previousScoreboardMessageIds =
              scoreboardRevision
              && Array.isArray(scoreboardRevision.publishedChatMessageIds)
                ? scoreboardRevision.publishedChatMessageIds.filter(
                    (value): value is string => typeof value === 'string',
                  )
                : [];
            const messages = await buildRoundAnnounceMessages({
              roundId: params.roundId,
              to: params.to,
            });
            if (!(await isAssistantEnabledFresh(params.roomId))) {
              throw new Error('ASSISTANT_ANNOUNCEMENT_DISABLED');
            }
            const scoreboardMessageIds: string[] = [];
            for (let index = 0; index < messages.length; index += 1) {
              await lease?.assertHeld();
              const message = messages[index]!;
              const messageId = message.messageKey
                ? `round:${params.roundId}:${message.messageKey}`
                : `round:${params.roundId}:announce:${params.to}:${index}`;
              if (typeof message.scoreboardChunkIndex === 'number') {
                scoreboardMessageIds[message.scoreboardChunkIndex] = messageId;
              }
              if (message.delayMs && message.delayMs > 0) {
                // 抢包等阶段的台词错峰发送，避免红包卡片立刻被顶出可视区
                await new Promise((resolve) => setTimeout(resolve, message.delayMs));
              }
              if (message.kind === 'banner') {
                await appendChatOnce(params.roomId, messageId, {
                  type: 'BANNER',
                  content: message.banner,
                  from: null,
                }, lease);
              } else if (message.kind === 'countdown') {
                await appendChatOnce(params.roomId, messageId, {
                  type: 'COUNTDOWN',
                  content: JSON.stringify({
                    mode: message.mode,
                    endsAt: message.endsAt,
                    template: message.template,
                  } satisfies CountdownPayload),
                  from: null,
                }, lease);
              } else if (message.content.trim()) {
                await appendChatOnce(params.roomId, messageId, {
                  type: 'SYSTEM',
                  content: message.content,
                  from: null,
                }, lease);
              }
            }
            for (const staleId of previousScoreboardMessageIds.slice(
              scoreboardMessageIds.length,
            )) {
              await lease?.assertHeld();
              await deleteChatStrict(params.roomId, staleId, lease);
            }
            if (scoreboardMessageIds.length && scoreboardRevision) {
              await lease?.assertHeld();
              let updatedCount: number;
              try {
                updatedCount = await prisma.$transaction(async (tx) => {
                  const updated = await tx.roundScoreboard.updateMany({
                    where: {
                      roundId: params.roundId,
                      presentationRevision: scoreboardRevision.presentationRevision,
                    },
                    data: {
                      publishedChatMessageIds: scoreboardMessageIds,
                      presentationSyncStatus: 'SYNCED',
                      presentationSyncError: null,
                      presentationSyncedAt: new Date(),
                    },
                  });
                  if (updated.count === 1) {
                    await tx.roundEvent.create({
                      data: {
                        id: eventId,
                        roundId: params.roundId,
                        type,
                        payload: { at: new Date().toISOString() },
                      },
                    });
                  }
                  return updated.count;
                });
              } catch (error) {
                if (isUniqueConstraintError(error)) {
                  const completedByPeer = await prisma.roundEvent.findFirst({
                    where: { roundId: params.roundId, type },
                    select: { id: true },
                  });
                  if (completedByPeer) return true;
                }
                throw error;
              }
              if (updatedCount !== 1) {
                // 展示修订可在持锁期间先写入数据库。保留刚发布消息的真实映射，
                // 让随后获得锁的修订同步可以安全增删分段；本次不得落完成事件。
                await lease?.assertHeld();
                await prisma.roundScoreboard.updateMany({
                  where: {
                    roundId: params.roundId,
                    presentationRevision: {
                      not: scoreboardRevision.presentationRevision,
                    },
                    presentationSyncStatus: {
                      in: ['PENDING', 'FAILED'],
                    },
                  },
                  data: {
                    publishedChatMessageIds: scoreboardMessageIds,
                  },
                });
                if (attempt >= 3) {
                  throw new Error('SCOREBOARD_REVISION_CHANGED_DURING_ANNOUNCEMENT');
                }
                // 仍持有共享 lease，立即按最新修订重建并原位覆盖，不能留下旧版消息。
                return publish(lease, attempt + 1);
              }
              return true;
            }
            if (scoreboardMessageIds.length) {
              await prisma.roundScoreboard.updateMany({
                where: { roundId: params.roundId },
                data: {
                  publishedChatMessageIds: scoreboardMessageIds,
                  presentationSyncStatus: 'SYNCED',
                  presentationSyncError: null,
                  presentationSyncedAt: new Date(),
                },
              });
            }
            await lease?.assertHeld();
            try {
              await prisma.roundEvent.create({
                data: {
                  id: eventId,
                  roundId: params.roundId,
                  type,
                  payload: { at: new Date().toISOString() },
                },
              });
            } catch (error) {
              if (!isUniqueConstraintError(error)) throw error;
              const completedByPeer = await prisma.roundEvent.findFirst({
                where: { roundId: params.roundId, type },
                select: { id: true },
              });
              if (!completedByPeer) throw error;
            }
            return true;
          };
          return params.to === 'FINISHED'
            ? withScoreboardSyncLock(params.roundId, async (lease) => {
                const completedInsideLock = await prisma.roundEvent.findFirst({
                  where: { roundId: params.roundId, type },
                  select: { id: true },
                });
                if (completedInsideLock) return true;
                return publish(lease);
              })
            : publish();
        },
      );
      if (completed) return;

      // 另一实例正在播报时等待其完成标记，避免重复追加同一阶段话术。
      // 抢包阶段台词带 2 秒错峰延迟，等待窗口需覆盖整段播报时长。
      for (let attempt = 0; attempt < 24; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const existing = await prisma.roundEvent.findFirst({
          where: { roundId: params.roundId, type },
          select: { id: true },
        });
        if (existing) return;
      }
      throw new Error('ROUND_ANNOUNCEMENT_IN_PROGRESS');
    } finally {
      roundAnnouncementInFlight.delete(key);
    }
  })();
  roundAnnouncementInFlight.set(key, task);
  return task;
}

/** 阶段倒计时气泡：与顶栏共用 endsAt，前端每秒刷新剩余秒数 */
export function systemCountdown(
  roomId: string,
  payload: CountdownPayload,
  options?: { force?: boolean },
): RoomChatMessage | null {
  if (!options?.force && !isAssistantEnabledSync(roomId)) return null;
  return appendChat(roomId, {
    type: 'COUNTDOWN',
    content: JSON.stringify(payload),
    from: null,
  });
}

/** 原地更新聊天消息（实时倒计时等场景可复用） */
export function updateChat(
  roomId: string,
  messageId: string,
  patch: Partial<Pick<RoomChatMessage, 'type' | 'content'>>,
): RoomChatMessage | null {
  const history = chatHistoryByRoom.get(roomId);
  if (!history) return null;
  const index = history.findIndex((item) => item.id === messageId);
  if (index < 0) return null;
  const next = { ...history[index]!, ...patch };
  history[index] = next;
  markChatPending(roomId, messageId);
  void broadcastToRoomCluster(roomId, { type: 'chat_update', message: next }).catch(
    () => undefined,
  );
  void (async () => {
    try {
      const instance = redis();
      const key = chatRedisKey(roomId);
      const rows = await instance.lrange(key, 0, -1);
      const nextRows = rows.map((row) => {
        try {
          const parsed = JSON.parse(row) as RoomChatMessage;
          return parsed.id === messageId ? JSON.stringify(next) : row;
        } catch {
          return row;
        }
      });
      if (nextRows.length) {
        const pipeline = instance.multi();
        pipeline.del(key);
        pipeline.rpush(key, ...nextRows);
        pipeline.expire(key, CHAT_REDIS_TTL_SECONDS);
        await pipeline.exec();
      }
    } catch {
      // ignore
    } finally {
      clearChatPending(roomId, messageId);
    }
  })();
  return next;
}

export function chatHistory(roomId: string): RoomChatMessage[] {
  const history = chatHistoryByRoom.get(roomId) ?? [];
  const filtered = history.filter((message) => {
    return !shouldSuppressDeletedChat(roomId, message)
      && isChatWithinRetention(message);
  });
  if (filtered.length !== history.length) chatHistoryByRoom.set(roomId, filtered);
  return filtered;
}

async function hydrateChatProfiles(messages: RoomChatMessage[]): Promise<RoomChatMessage[]> {
  const uids = [
    ...new Set(
      messages
        .map((message) => message.from?.uid)
        .filter((uid): uid is string => typeof uid === 'string' && uid.length > 0),
    ),
  ];
  if (!uids.length) return messages;

  try {
    const users = await prisma.user.findMany({
      where: { uid: { in: uids } },
      select: { uid: true, nickname: true, avatarUrl: true },
    });
    const profiles = new Map<
      string,
      { uid: string; nickname: string | null; avatarUrl: string | null }
    >(
      users.map(
        (user: { uid: string; nickname: string | null; avatarUrl: string | null }) => [
          user.uid,
          user,
        ],
      ),
    );
    return messages.map((message) => {
      if (!message.from) return message;
      const current = profiles.get(message.from.uid);
      if (!current) return message;
      return {
        ...message,
        from: {
          uid: current.uid,
          nickname: current.nickname ?? current.uid,
          avatarUrl: current.avatarUrl,
        },
      };
    });
  } catch {
    return messages;
  }
}

/**
 * Redis 是跨实例历史的权威来源；只补入明确标记为“正在落库”的短期内存消息。
 * 这样某实例漏收删除广播或重启后，也不会用陈旧内存复活 Redis 已不存在的分段。
 */
export async function loadChatHistory(roomId: string): Promise<RoomChatMessage[]> {
  const memory = chatHistory(roomId);
  try {
    const instance = redis();
    const key = chatRedisKey(roomId);
    const rows = await instance.lrange(key, -CHAT_HISTORY_LIMIT, -1);
    const byId = new Map<string, RoomChatMessage>();
    const tombstoneConflicts = new Map<string, number>();
    for (const row of rows) {
      try {
        const message = JSON.parse(row) as RoomChatMessage;
        if (!message?.id || !isChatWithinRetention(message)) continue;
        if (shouldSuppressDeletedChat(roomId, message)) {
          const generation = pruneChatTombstones(roomId).get(
            message.id,
          )?.generation;
          if (generation != null) tombstoneConflicts.set(message.id, generation);
          continue;
        }
        byId.set(message.id, message);
      } catch {
        // 单条损坏不影响其余聊天历史。
      }
    }
    if (tombstoneConflicts.size) {
      // 删除事件是在 Redis Lua 删除完成后发布的；二次读取仍存在即说明同 ID 已合法重建。
      const confirmedRows = await instance.lrange(key, -CHAT_HISTORY_LIMIT, -1);
      for (const row of confirmedRows) {
        try {
          const message = JSON.parse(row) as RoomChatMessage;
          if (
            message?.id
            && tombstoneConflicts.has(message.id)
            && isChatWithinRetention(message)
          ) {
            const expectedGeneration = tombstoneConflicts.get(message.id);
            const currentGeneration = pruneChatTombstones(roomId).get(
              message.id,
            )?.generation;
            if (currentGeneration !== expectedGeneration) continue;
            clearChatDeleted(roomId, message.id);
            byId.set(message.id, message);
          }
        } catch {
          // 单条损坏不影响冲突确认。
        }
      }
    }
    for (const message of memory) {
      if (
        isChatPending(roomId, message.id)
        && !shouldSuppressDeletedChat(roomId, message)
        && isChatWithinRetention(message)
      ) {
        byId.set(message.id, message);
      }
    }
    const merged = [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
    const trimmed =
      merged.length > CHAT_HISTORY_LIMIT
        ? merged.slice(merged.length - CHAT_HISTORY_LIMIT)
        : merged;
    const hydrated = (await hydrateChatProfiles(trimmed)).filter(
      (message) =>
        !shouldSuppressDeletedChat(roomId, message) && isChatWithinRetention(message),
    );
    chatHistoryByRoom.set(roomId, hydrated);
    return hydrated;
  } catch {
    // fall through
  }
  const hydrated = (await hydrateChatProfiles(chatHistory(roomId))).filter(
    (message) =>
      !shouldSuppressDeletedChat(roomId, message) && isChatWithinRetention(message),
  );
  chatHistoryByRoom.set(roomId, hydrated);
  return hydrated;
}

/** 连接只读取最近窗口，避免每次进群都解析并补全 2,000 条长期历史。 */
async function loadRecentChatHistory(
  roomId: string,
  limit: number,
): Promise<RoomChatMessage[]> {
  const memory = chatHistory(roomId).slice(-limit);
  try {
    const instance = redis();
    const key = chatRedisKey(roomId);
    const rows = await instance.lrange(key, -limit, -1);
    const byId = new Map<string, RoomChatMessage>();
    const tombstoneConflicts = new Map<string, number>();
    for (const row of rows) {
      try {
        const message = JSON.parse(row) as RoomChatMessage;
        if (!message?.id || !isChatWithinRetention(message)) continue;
        if (shouldSuppressDeletedChat(roomId, message)) {
          const generation = pruneChatTombstones(roomId).get(
            message.id,
          )?.generation;
          if (generation != null) tombstoneConflicts.set(message.id, generation);
          continue;
        }
        byId.set(message.id, message);
      } catch {
        // 单条损坏不影响其余聊天窗口。
      }
    }
    if (tombstoneConflicts.size) {
      const confirmedRows = await instance.lrange(key, -limit, -1);
      for (const row of confirmedRows) {
        try {
          const message = JSON.parse(row) as RoomChatMessage;
          if (
            message?.id
            && tombstoneConflicts.has(message.id)
            && isChatWithinRetention(message)
          ) {
            const expectedGeneration = tombstoneConflicts.get(message.id);
            const currentGeneration = pruneChatTombstones(roomId).get(
              message.id,
            )?.generation;
            if (currentGeneration !== expectedGeneration) continue;
            clearChatDeleted(roomId, message.id);
            byId.set(message.id, message);
          }
        } catch {
          // 单条损坏不影响冲突确认。
        }
      }
    }
    // 只允许正在落库的短期内存消息覆盖 Redis，普通内存缓存不得复活已删除内容。
    for (const message of memory) {
      if (
        isChatPending(roomId, message.id)
        && !shouldSuppressDeletedChat(roomId, message)
        && isChatWithinRetention(message)
      ) {
        byId.set(message.id, message);
      }
    }
    const recent = [...byId.values()]
      .sort((left, right) => left.at.localeCompare(right.at))
      .slice(-limit);
    return (await hydrateChatProfiles(recent)).filter(
      (message) =>
        !shouldSuppressDeletedChat(roomId, message) && isChatWithinRetention(message),
    );
  } catch {
    return (await hydrateChatProfiles(chatHistory(roomId).slice(-limit))).filter(
      (message) =>
        !shouldSuppressDeletedChat(roomId, message) && isChatWithinRetention(message),
    );
  }
}

export function addClient(roomId: string, client: RoomClient) {
  let clients = clientsByRoom.get(roomId);
  if (!clients) {
    clients = new Set();
    clientsByRoom.set(roomId, clients);
  }
  clients.add(client);
  void Promise.resolve()
    .then(() =>
      prisma.roomMember.updateMany({
        where: { roomId, userId: client.userId, status: 'ACTIVE' },
        data: { lastSeenAt: new Date() },
      }),
    )
    .catch(() => undefined);
  void loadRecentChatHistory(roomId, CLIENT_CHAT_HISTORY_LIMIT).then((messages) => {
    if (client.socket.readyState === client.socket.OPEN) {
      send(client, { type: 'chat_history', messages });
    }
  });
  broadcastToRoom(roomId, { type: 'presence', online: clients.size });
}

export function removeClient(roomId: string, client: RoomClient) {
  const clients = clientsByRoom.get(roomId);
  if (!clients) return;
  clients.delete(client);
  const online = clients.size;
  if (online === 0) clientsByRoom.delete(roomId);
  // 最后一人离开也要推 0，避免观察端停留在旧在线数。
  broadcastToRoom(roomId, { type: 'presence', online });
}

/** 后台观察连接：接收同一消息流，但不加入玩家成员、也不计入在线人数。 */
export function addObserver(roomId: string, observer: RoomObserver) {
  let observers = observersByRoom.get(roomId);
  if (!observers) {
    observers = new Set();
    observersByRoom.set(roomId, observers);
  }
  observers.add(observer);
  void loadRecentChatHistory(roomId, OBSERVER_CHAT_HISTORY_LIMIT).then((messages) => {
    if (observer.socket.readyState === observer.socket.OPEN) {
      send(observer, { type: 'chat_history', messages });
    }
  });
  send(observer, { type: 'presence', online: onlineCount(roomId) });
}

export function removeObserver(roomId: string, observer: RoomObserver) {
  const observers = observersByRoom.get(roomId);
  if (!observers) return;
  observers.delete(observer);
  if (observers.size === 0) observersByRoom.delete(roomId);
}

/** 接线 gameBus → 房间广播（进程内只注册一次） */
export function initRoomHub() {
  if (wired) return;
  wired = true;
  void startRoomBroadcastSubscriber();
  presenceHeartbeat = setInterval(() => {
    for (const roomId of pendingChatMessageIdsByRoom.keys()) {
      pruneChatPending(roomId);
    }
    void touchConnectedRoomMembers().catch(() => undefined);
  }, 30_000);
  presenceHeartbeat.unref();

  gameBus.on('round:transition', (transition: RoundTransitionEvent) => {
    void ensureRoundAnnouncement({
      roundId: transition.roundId,
      roomId: transition.roomId,
      to: transition.to,
    })
      .catch(() => {
        systemChat(transition.roomId, `阶段变更：${transition.to}`);
      })
      .finally(async () => {
        await broadcastToRoomCluster(transition.roomId, {
          type: 'round',
          roundId: transition.roundId,
          from: transition.from,
          to: transition.to,
        });
      });
  });

  gameBus.on('claim:recorded', (payload: ClaimRecordedEvent) => {
    void (async () => {
      const round = await prisma.round.findUnique({
        where: { id: payload.roundId },
        select: { roomId: true, bankerId: true },
      });
      if (!round) return;
      const isBanker = round.bankerId === payload.userId;
      await broadcastToRoomCluster(round.roomId, {
        type: 'claim',
        roundId: payload.roundId,
        isBanker,
      });
    })().catch(() => undefined);
  });

  gameBus.on('reward:granted', (payload: RewardGrantedEvent) => {
    void (async () => {
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
        select: { uid: true, nickname: true, avatarUrl: true },
      });
      if (!user) return;
      await broadcastToAllRoomsCluster({
        type: 'reward',
        title: payload.title,
        amountCents: payload.amountCents,
        user: {
          uid: user.uid,
          nickname: user.nickname,
          avatarUrl: user.avatarUrl,
        },
      });
    })().catch(() => undefined);
  });
}
