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
const gamePacketMessageInFlight = new Map<string, Promise<RoomChatMessage>>();
const roundAnnouncementInFlight = new Map<string, Promise<void>>();
const ROOM_BROADCAST_CHANNEL = 'niuniu:room:broadcast';
const roomHubInstanceNonce = randomUUID().replaceAll('-', '').slice(0, 10);
const roomHubInstanceId = `${process.pid}:${roomHubInstanceNonce}`;
let roomBroadcastSubscriber: Redis | null = null;
let counter = 0;
let wired = false;

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
      };
      if (event.origin === roomHubInstanceId) return;
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

async function persistChatStrict(roomId: string, message: RoomChatMessage): Promise<void> {
  try {
    const instance = redis();
    const key = chatRedisKey(roomId);
    await instance.rpush(key, JSON.stringify(message));
    await instance.ltrim(key, -CHAT_HISTORY_LIMIT, -1);
    await instance.expire(key, CHAT_REDIS_TTL_SECONDS);
  } catch (error) {
    // 开发环境允许内存降级；生产关键时序必须等 Redis 成功后才能写完成标记。
    if (env.nodeEnv === 'production') throw error;
  }
}

async function replacePersistedChatStrict(
  roomId: string,
  message: RoomChatMessage,
): Promise<void> {
  try {
    const instance = redis();
    const key = chatRedisKey(roomId);
    const rows = await instance.lrange(key, 0, -1);
    let replaced = false;
    const nextRows = rows.map((row) => {
      try {
        const parsed = JSON.parse(row) as RoomChatMessage;
        if (parsed.id !== message.id) return row;
        replaced = true;
        return JSON.stringify(message);
      } catch {
        return row;
      }
    });
    if (!replaced) nextRows.push(JSON.stringify(message));
    const pipeline = instance.multi();
    pipeline.del(key);
    if (nextRows.length) pipeline.rpush(key, ...nextRows);
    pipeline.ltrim(key, -CHAT_HISTORY_LIMIT, -1);
    pipeline.expire(key, CHAT_REDIS_TTL_SECONDS);
    await pipeline.exec();
  } catch (error) {
    if (env.nodeEnv === 'production') throw error;
  }
}

function persistChat(roomId: string, message: RoomChatMessage) {
  void persistChatStrict(roomId, message).catch(() => undefined);
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
  const history = chatHistoryByRoom.get(roomId) ?? [];
  history.push(full);
  if (history.length > CHAT_HISTORY_LIMIT) history.splice(0, history.length - CHAT_HISTORY_LIMIT);
  chatHistoryByRoom.set(roomId, history);
  persistChat(roomId, full);
  void broadcastToRoomCluster(roomId, { type: 'chat', message: full }).catch(() => undefined);
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
): Promise<RoomChatMessage> {
  const history = await loadChatHistory(roomId);
  const existing = history.find((item) => item.id === id);
  if (existing) {
    if (existing.type !== message.type || existing.content !== message.content) {
      const next: RoomChatMessage = { ...existing, ...message, id };
      await replacePersistedChatStrict(roomId, next);
      const current = chatHistoryByRoom.get(roomId) ?? [];
      const index = current.findIndex((item) => item.id === id);
      if (index >= 0) current[index] = next;
      else current.push(next);
      chatHistoryByRoom.set(roomId, current);
      await broadcastToRoomCluster(roomId, { type: 'chat_update', message: next });
      return next;
    }
    await broadcastToRoomCluster(roomId, { type: 'chat', message: existing });
    return existing;
  }

  const full: RoomChatMessage = {
    ...message,
    id,
    at: new Date().toISOString(),
  };
  await persistChatStrict(roomId, full);
  const current = chatHistoryByRoom.get(roomId) ?? [];
  if (!current.some((item) => item.id === id)) current.push(full);
  if (current.length > CHAT_HISTORY_LIMIT) {
    current.splice(0, current.length - CHAT_HISTORY_LIMIT);
  }
  chatHistoryByRoom.set(roomId, current);
  await broadcastToRoomCluster(roomId, { type: 'chat', message: full });
  return full;
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

          const messages = await buildRoundAnnounceMessages({
            roundId: params.roundId,
            to: params.to,
          });
          if (!(await isAssistantEnabledFresh(params.roomId))) {
            throw new Error('ASSISTANT_ANNOUNCEMENT_DISABLED');
          }
          for (let index = 0; index < messages.length; index += 1) {
            const message = messages[index]!;
            const messageId = `round:${params.roundId}:announce:${params.to}:${index}`;
            if (message.delayMs && message.delayMs > 0) {
              // 抢包等阶段的台词错峰发送，避免红包卡片立刻被顶出可视区
              await new Promise((resolve) => setTimeout(resolve, message.delayMs));
            }
            if (message.kind === 'banner') {
              await appendChatOnce(params.roomId, messageId, {
                type: 'BANNER',
                content: message.banner,
                from: null,
              });
            } else if (message.kind === 'countdown') {
              await appendChatOnce(params.roomId, messageId, {
                type: 'COUNTDOWN',
                content: JSON.stringify({
                  mode: message.mode,
                  endsAt: message.endsAt,
                  template: message.template,
                } satisfies CountdownPayload),
                from: null,
              });
            } else if (message.content.trim()) {
              await appendChatOnce(params.roomId, messageId, {
                type: 'SYSTEM',
                content: message.content,
                from: null,
              });
            }
          }
          await prisma.roundEvent.create({
            data: {
              roundId: params.roundId,
              type,
              payload: { at: new Date().toISOString() },
            },
          });
          return true;
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
    }
  })();
  return next;
}

export function chatHistory(roomId: string): RoomChatMessage[] {
  return chatHistoryByRoom.get(roomId) ?? [];
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
 * 优先合并 Redis + 内存：刚写入内存、Redis 异步落库未完成时，不能用旧 Redis 覆盖掉最新发言（例如刚发出的红包）。
 */
export async function loadChatHistory(roomId: string): Promise<RoomChatMessage[]> {
  const memory = chatHistory(roomId);
  try {
    const instance = redis();
    const rows = await instance.lrange(chatRedisKey(roomId), -CHAT_HISTORY_LIMIT, -1);
    if (rows.length > 0) {
      const fromRedis = rows
        .map((row) => {
          try {
            return JSON.parse(row) as RoomChatMessage;
          } catch {
            return null;
          }
        })
        .filter((item): item is RoomChatMessage => !!item?.id);
      if (fromRedis.length) {
        const byId = new Map<string, RoomChatMessage>();
        for (const msg of fromRedis) byId.set(msg.id, msg);
        for (const msg of memory) byId.set(msg.id, msg);
        const merged = [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
        const trimmed =
          merged.length > CHAT_HISTORY_LIMIT
            ? merged.slice(merged.length - CHAT_HISTORY_LIMIT)
            : merged;
        const hydrated = await hydrateChatProfiles(trimmed);
        chatHistoryByRoom.set(roomId, hydrated);
        return hydrated;
      }
    }
  } catch {
    // fall through
  }
  const hydrated = await hydrateChatProfiles(memory);
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
    const rows = await redis().lrange(chatRedisKey(roomId), -limit, -1);
    const byId = new Map<string, RoomChatMessage>();
    for (const row of rows) {
      try {
        const message = JSON.parse(row) as RoomChatMessage;
        if (message?.id) byId.set(message.id, message);
      } catch {
        // 单条损坏不影响其余聊天窗口。
      }
    }
    // 内存里可能有尚未异步落到 Redis 的最新消息，必须覆盖同 ID 的旧值。
    for (const message of memory) byId.set(message.id, message);
    const recent = [...byId.values()]
      .sort((left, right) => left.at.localeCompare(right.at))
      .slice(-limit);
    return hydrateChatProfiles(recent);
  } catch {
    return hydrateChatProfiles(memory);
  }
}

export function addClient(roomId: string, client: RoomClient) {
  let clients = clientsByRoom.get(roomId);
  if (!clients) {
    clients = new Set();
    clientsByRoom.set(roomId, clients);
  }
  clients.add(client);
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
