import { PacketChannel, RoundPhase } from '@prisma/client';
import {
  bankerContinuationError,
  shouldStartWaitingRound,
} from '../engine/bankerContinuation.js';
import { redis, withRedisLock } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { env } from '../config.js';
import { advanceBidClosingCeremony } from './bidAuction.js';
import {
  applyAutoTailClaims,
  closeBetting,
  ensureWaitingRound,
  expirePacket,
  GameError,
  publishInternalPacket,
  publishPacket,
  refreshUnannouncedClaimDeadline,
  startRound,
} from './game.js';
import { finalizeInternalRound } from './internalPacket.js';
import { gameBus } from './gameBus.js';
import { getGameSettings, parseSettingsSnapshot } from './gameSettings.js';
import { expireGroupPackets } from './groupPacket.js';
import {
  appendSystemChatOnce,
  appendGamePacketMessage,
  ensureRoundAnnouncement,
  rebroadcastRoomState,
  systemChat,
} from './roomHub.js';
import { scheduleVirtualDiceForRound } from './virtualPlayerWorker.js';

// 正常阶段变化都有即时事件；这里只做丢事件恢复心跳。
// 大群若 5 秒一次会让所有在线客户端同时拉 state，形成数据库尖峰。
const ROUND_REBROADCAST_INTERVAL_MS = 30_000;
const lastRoundBroadcastAt = new Map<string, number>();

async function cacheRound(roundId: string) {
  const round = await prisma.round.findUnique({
    where: { id: roundId },
    include: { packet: true },
  });
  if (!round) return;
  await redis()
    .set(
      `niuniu:round:${roundId}`,
      JSON.stringify(round, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
      'EX',
      86_400,
    )
    .catch(() => undefined);
}

async function transition(
  roundId: string,
  roomId: string,
  from: RoundPhase,
  action: () => Promise<{ phase: RoundPhase }>,
) {
  try {
    const result = await action();
    await cacheRound(roundId);
    if (result.phase !== from) {
      gameBus.transition({ roundId, roomId, from, to: result.phase });
    }
  } catch (error) {
    if (
      error instanceof GameError &&
      ['INVALID_PHASE', 'ROUND_NOT_FOUND'].includes(error.code)
    ) {
      return;
    }
    throw error;
  }
}

export class RoundScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(intervalMs = 1_000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await withRedisLock('niuniu:scheduler:tick', 60_000, async () => {
        const now = new Date();
        const [
          dueBids,
          dueBets,
          dueClaims,
          pendingPackets,
          activeRounds,
        ] = await Promise.all([
          prisma.round.findMany({
            where: { phase: RoundPhase.BANKER_BID, bidEndsAt: { lte: now } },
            select: {
              id: true,
              roomId: true,
              events: {
                where: { type: `ROOM_ANNOUNCED_${RoundPhase.BANKER_BID}` },
                select: { id: true },
                take: 1,
              },
            },
            take: 100,
          }),
          prisma.round.findMany({
            where: { phase: RoundPhase.BETTING, betEndsAt: { lte: now } },
            select: {
              id: true,
              roomId: true,
              events: {
                where: { type: `ROOM_ANNOUNCED_${RoundPhase.BETTING}` },
                select: { id: true },
                take: 1,
              },
            },
            take: 100,
          }),
          prisma.round.findMany({
            where: {
              phase: RoundPhase.CLAIMING,
              claimEndsAt: { lte: now },
              packet: { status: 'SENT' },
            },
            select: {
              id: true,
              roomId: true,
              events: {
                where: { type: `ROOM_ANNOUNCED_${RoundPhase.CLAIMING}` },
                select: { id: true },
                take: 1,
              },
            },
            take: 100,
          }),
          prisma.round.findMany({
            where: { phase: RoundPhase.SENDING_PACKET },
            select: {
              id: true,
              roomId: true,
              configSnapshot: true,
              room: { select: { gameCode: true } },
              packet: { select: { id: true, channel: true } },
            },
            take: 50,
          }),
          prisma.round.findMany({
            where: {
              phase: {
                in: [
                  RoundPhase.BANKER_BID,
                  RoundPhase.BETTING,
                  RoundPhase.SENDING_PACKET,
                  RoundPhase.CLAIMING,
                  RoundPhase.CLAIM_EXPIRED,
                  RoundPhase.SETTLING,
                ],
              },
            },
            select: {
              id: true,
              roomId: true,
              phase: true,
              packet: { select: { id: true, channel: true } },
              events: {
                where: { type: { startsWith: 'ROOM_ANNOUNCED_' } },
                select: { type: true },
              },
            },
            take: 200,
          }),
        ]);

        // 出价窗口结束后：3/2/1 → 播报最终名单 → 再锁定最高价（不立刻 closeBidding）
        for (const round of dueBids) {
          if (round.events.length === 0) {
            void ensureRoundAnnouncement({
              roundId: round.id,
              roomId: round.roomId,
              to: RoundPhase.BANKER_BID,
            }).catch(() => undefined);
            continue;
          }
          try {
            await advanceBidClosingCeremony({
              roundId: round.id,
              roomId: round.roomId,
            });
          } catch {
            // 开始竞庄播报未完整落库前，不进入收官倒计时。
          }
        }
        for (const round of dueBets) {
          if (round.events.length === 0) {
            void ensureRoundAnnouncement({
              roundId: round.id,
              roomId: round.roomId,
              to: RoundPhase.BETTING,
            }).catch(() => undefined);
            continue;
          }
          try {
            await transition(round.id, round.roomId, RoundPhase.BETTING, () =>
              closeBetting(round.id),
            );
          } catch {
            // 开注播报未完整落库前不封盘，恢复小助手/Redis 后自动续推。
          }
        }

        // 补齐当前阶段缺失播报；发包阶段必须先恢复红包卡，随后才补「开始抢包」。
        for (const round of activeRounds) {
          const announceMarker = `ROOM_ANNOUNCED_${round.phase}`;
          const announced = round.events.some((event) => event.type === announceMarker);
          const lastBroadcast = lastRoundBroadcastAt.get(round.id) ?? 0;
          const shouldBroadcast =
            !announced || now.getTime() - lastBroadcast >= ROUND_REBROADCAST_INTERVAL_MS;
          if (announced && !shouldBroadcast) continue;
          if (!announced) {
            void (async () => {
              if (round.phase === RoundPhase.CLAIMING) {
                if (!round.packet?.id) return;
                await appendGamePacketMessage(round.roomId, {
                  packetId: round.packet.id,
                  roundId: round.id,
                });
                await refreshUnannouncedClaimDeadline(round.id);
              }
              await ensureRoundAnnouncement({
                roundId: round.id,
                roomId: round.roomId,
                to: round.phase,
              });
            })().catch(() => undefined);
            continue;
          }
          try {
            if (shouldBroadcast) {
              await rebroadcastRoomState({
                roundId: round.id,
                roomId: round.roomId,
                phase: round.phase,
                heartbeat: true,
              });
              lastRoundBroadcastAt.set(round.id, now.getTime());
            }
          } catch {
            // 小助手暂停或 Redis 暂不可用时留待下一轮恢复，不阻塞其它牌局。
          }
        }

        // CLAIM_EXPIRED 不再进入 dueClaims；若上一次自动认尾或结算遇到瞬时
        // 故障，必须在后续 tick 继续补偿，否则牌局和冻结资金会永久卡住。
        for (const round of activeRounds) {
          if (
            round.phase !== RoundPhase.CLAIM_EXPIRED
            || round.packet?.channel !== PacketChannel.INTERNAL
          ) {
            continue;
          }
          try {
            await applyAutoTailClaims(round.id);
            const finalized = await finalizeInternalRound(round.id);
            if (finalized) await cacheRound(round.id);
          } catch (error) {
            console.error('[scheduler] retry internal finalization failed', round.id, error);
          }
        }

        if (lastRoundBroadcastAt.size > 1_000) {
          const staleBefore = now.getTime() - 60_000;
          for (const [roundId, timestamp] of lastRoundBroadcastAt) {
            if (timestamp < staleBefore) lastRoundBroadcastAt.delete(roundId);
          }
        }

        for (const round of pendingPackets) {
          await scheduleVirtualDiceForRound(round.roomId, round.id);
        }

        // 内部红包：投骰完成后小助手自动发包，无需 TNG 链接与发包账号。
        for (const round of pendingPackets) {
          if (!round.packet?.id) continue;
          const settings = round.configSnapshot
            ? parseSettingsSnapshot(round.configSnapshot)
            : await getGameSettings(round.room.gameCode);
          if (settings.round.packetChannel !== 'INTERNAL') continue;
          try {
            const packet = await publishInternalPacket({
              roundId: round.id,
              actorId: 'SYSTEM',
            });
            await appendGamePacketMessage(round.roomId, {
              packetId: packet.id,
              roundId: round.id,
            });
            await refreshUnannouncedClaimDeadline(round.id);
            gameBus.transition({
              roundId: round.id,
              roomId: round.roomId,
              from: RoundPhase.SENDING_PACKET,
              to: RoundPhase.CLAIMING,
            });
            await cacheRound(round.id);
          } catch {
            // 骰子未投完（BANKER_DICE_NOT_READY）时等待下一轮
          }
        }

        if (env.tngAutoPacketUrlTemplate.includes('{{packetId}}')) {
          const account = await prisma.tngAccount.findFirst({
            where: { status: 'ACTIVE' },
            orderBy: { createdAt: 'asc' },
          });
          if (account) {
            for (const round of pendingPackets) {
              if (!round.packet?.id) continue;
              const settings = round.configSnapshot
                ? parseSettingsSnapshot(round.configSnapshot)
                : await getGameSettings(round.room.gameCode);
              if (settings.round.packetChannel === 'INTERNAL') continue;
              if (!settings.round.autoPublishPacketEnabled) continue;
              const claimUrl = env.tngAutoPacketUrlTemplate.replaceAll(
                '{{packetId}}',
                round.packet.id,
              );
              try {
                const packet = await publishPacket({
                  roundId: round.id,
                  claimUrl,
                  packerAccount: account.id,
                  actorId: 'SYSTEM',
                });
                await appendGamePacketMessage(round.roomId, {
                  packetId: packet.id,
                  roundId: round.id,
                });
                await refreshUnannouncedClaimDeadline(round.id);
                gameBus.transition({
                  roundId: round.id,
                  roomId: round.roomId,
                  from: RoundPhase.SENDING_PACKET,
                  to: RoundPhase.CLAIMING,
                });
                await cacheRound(round.id);
              } catch {
                // 链接域名未放行或账号限额时跳过，留给人工发包
              }
            }
          }
        }

        for (const round of dueClaims) {
          if (round.events.length === 0) {
            void (async () => {
              await refreshUnannouncedClaimDeadline(round.id);
              await ensureRoundAnnouncement({
                roundId: round.id,
                roomId: round.roomId,
                to: RoundPhase.CLAIMING,
              });
            })().catch(() => undefined);
            continue;
          }
          try {
            await expirePacket(round.id);
          } catch {
            continue;
          }
          const expiredRound = await prisma.round.findUnique({
            where: { id: round.id },
            select: { phase: true },
          });
          if (expiredRound?.phase !== RoundPhase.CLAIM_EXPIRED) continue;
          const tailed = await applyAutoTailClaims(round.id);
          await cacheRound(round.id);
          gameBus.transition({
            roundId: round.id,
            roomId: round.roomId,
            from: RoundPhase.CLAIMING,
            to: 'CLAIM_EXPIRED',
          });
          if (tailed.length) {
            systemChat(
              round.roomId,
              `🧧 自动认尾包已完成：为 ${tailed.length} 位未领取玩家补录尾包金额，等待复核结算。`,
            );
            const rows = await prisma.claim.findMany({
              where: { roundId: round.id, userId: { in: tailed } },
              select: { userId: true, amountCents: true },
            });
            for (const row of rows) {
              gameBus.claimRecorded({
                roundId: round.id,
                userId: row.userId,
                amountCents: String(row.amountCents),
              });
            }
          }
          // 内部红包：补录齐后立即自动结算并公布成绩单。
          await finalizeInternalRound(round.id).catch((error) => {
            console.error('[scheduler] finalize internal round failed', round.id, error);
          });
        }

        await expireGroupPackets().catch(() => undefined);

        const rooms = await prisma.room.findMany({
          where: { status: 'ACTIVE' },
          select: { id: true, gameCode: true },
        });
        const settingsByGame = new Map<string, Awaited<ReturnType<typeof getGameSettings>>>();
        for (const room of rooms) {
          const waiting = await ensureWaitingRound(room.id);
          let settings = settingsByGame.get(room.gameCode);
          if (!settings) {
            settings = await getGameSettings(room.gameCode);
            settingsByGame.set(room.gameCode, settings);
          }
          if (
            settings.round.assistantEnabled === false
            || waiting.phase !== RoundPhase.WAITING
          ) {
            continue;
          }

          const previous =
            waiting.seqNo > 1
              ? await prisma.round.findUnique({
                  where: {
                    roomId_seqNo: { roomId: room.id, seqNo: waiting.seqNo - 1 },
                  },
                  select: {
                    id: true,
                    roomId: true,
                    seqNo: true,
                    phase: true,
                    bankerId: true,
                    isContinued: true,
                    continuationUsed: true,
                    finishedAt: true,
                    configSnapshot: true,
                  },
                })
              : null;
          let continuationError: ReturnType<typeof bankerContinuationError> | undefined;
          if (previous?.bankerId && previous.configSnapshot) {
            const continuationSettings = parseSettingsSnapshot(previous.configSnapshot);
            continuationError = bankerContinuationError({
              previous,
              next: waiting,
              userId: previous.bankerId,
              windowSeconds: continuationSettings.round.continuationWindowSeconds,
              now,
            });
          }
          if (
            !shouldStartWaitingRound({
              autoStart: Boolean(settings.round.autoStart),
              continuationError,
            })
          ) {
            continue;
          }

          if (continuationError === 'CONTINUATION_WINDOW_EXPIRED' && previous) {
            await appendSystemChatOnce(
              room.id,
              `round:${previous.id}:continuation:expired`,
              '【续庄确认超时】\n庄家未在规定时间内确认，下一局转入公开竞标。',
            ).catch(() => undefined);
          }
          await transition(waiting.id, room.id, RoundPhase.WAITING, () =>
            startRound(waiting.id),
          ).catch((error) => {
            if (error instanceof GameError && error.code === 'NOT_ENOUGH_PLAYERS') return;
            throw error;
          });
        }
      });
    } catch (error) {
      console.error('[scheduler] tick failed', error);
    } finally {
      this.running = false;
    }
  }
}

export const roundScheduler = new RoundScheduler();
