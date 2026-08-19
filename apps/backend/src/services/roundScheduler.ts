import { PacketChannel, RoundPhase, RoomStartMode } from '@prisma/client';
import {
  bankerContinuationError,
  shouldStartWaitingRound,
} from '../engine/bankerContinuation.js';
import { redis, withRedisLock } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { env } from '../config.js';
import { advanceBidClosingCeremony } from './bidAuction.js';
import { cancelBankerDiceTimeout } from './chatCommands.js';
import {
  applyAutoTailClaims,
  bankerContinuationFunding,
  closeBetting,
  ensureWaitingRound,
  expirePacket,
  GameError,
  publishInternalPacket,
  publishPacket,
  refreshUnannouncedClaimDeadline,
  startRound,
} from './game.js';
import { rejectInsufficientContinuation } from './bankerContinuationFlow.js';
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
import {
  CONTINUATION_REJECTED_INSUFFICIENT,
  ROOM_ANNOUNCED_FINISHED,
} from './roomChatPolicy.js';
import {
  scheduleVirtualContinuationForRound,
  scheduleVirtualDiceForRound,
} from './virtualPlayerWorker.js';

// 正常阶段变化都有即时事件；这里只做丢事件恢复心跳。
// 大群若 5 秒一次会让所有在线客户端同时拉 state，形成数据库尖峰。
const ROUND_REBROADCAST_INTERVAL_MS = 30_000;
const LEGACY_BANKER_DICE_TIMEOUT_MS = 15_000;
const lastRoundBroadcastAt = new Map<string, number>();

function eventEndsAtMs(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as { endsAt?: unknown }).endsAt;
  if (typeof value !== 'string') return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

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
              events: {
                where: {
                  type: {
                    in: [
                      'BANKER_DICE',
                      'BANKER_REPOST_WINDOW',
                      'BANKER_DICE_DEADLINE',
                    ],
                  },
                },
                select: { type: true, payload: true },
              },
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

        const diceTimedOutRoundIds = new Set<string>();
        for (const round of pendingPackets) {
          if (round.events.some((event) => event.type === 'BANKER_DICE')) continue;
          const deadlineEvent = round.events.find(
            (event) => event.type === 'BANKER_DICE_DEADLINE',
          );
          const repostEvent = round.events.find(
            (event) => event.type === 'BANKER_REPOST_WINDOW',
          );
          const repostDeadline = eventEndsAtMs(repostEvent?.payload);
          const deadline =
            eventEndsAtMs(deadlineEvent?.payload)
            ?? (repostDeadline === null
              ? null
              : repostDeadline + LEGACY_BANKER_DICE_TIMEOUT_MS);
          if (deadline === null || deadline > now.getTime()) continue;
          try {
            const cancelled = await cancelBankerDiceTimeout({
              roundId: round.id,
              roomId: round.roomId,
              now,
            });
            if (cancelled) {
              diceTimedOutRoundIds.add(round.id);
              await cacheRound(round.id);
            }
          } catch (error) {
            console.error('[scheduler] banker dice timeout failed', round.id, error);
          }
        }

        for (const round of pendingPackets) {
          if (diceTimedOutRoundIds.has(round.id)) continue;
          await scheduleVirtualDiceForRound(round.roomId, round.id);
        }

        // 系统红包：投骰完成后由至尊牛牛小助手自动发包，无需 TNG 链接。
        for (const round of pendingPackets) {
          if (diceTimedOutRoundIds.has(round.id)) continue;
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
              if (diceTimedOutRoundIds.has(round.id)) continue;
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
          select: {
            id: true,
            gameCode: true,
            roundStartMode: true,
            chatMutedAt: true,
          },
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
            waiting.phase !== RoundPhase.WAITING
          ) {
            continue;
          }
          // 当前局的超时与收尾由上面的阶段调度照常完成；这里只阻止禁言期间开启下一局。
          if (room.chatMutedAt) continue;

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
                    cancelReason: true,
                    configSnapshot: true,
                    events: {
                      where: {
                        type: {
                          in: [
                            ROOM_ANNOUNCED_FINISHED,
                            CONTINUATION_REJECTED_INSUFFICIENT,
                          ],
                        },
                      },
                      select: { type: true, createdAt: true },
                    },
                  },
                })
              : null;
          const finishedAnnouncement = previous?.events.find(
            (event) => event.type === ROOM_ANNOUNCED_FINISHED,
          );
          const continuationRejected = previous?.events.some(
            (event) => event.type === CONTINUATION_REJECTED_INSUFFICIENT,
          );
          const finishedAnnouncementReady =
            previous?.phase === RoundPhase.FINISHED
            && !!finishedAnnouncement;
          if (
            previous?.phase === RoundPhase.FINISHED
            && !finishedAnnouncement
          ) {
            // 崩溃恢复：主动补齐成绩单；完成事件落库前不得启动续庄计时。
            try {
              await ensureRoundAnnouncement({
                roundId: previous.id,
                roomId: previous.roomId,
                to: RoundPhase.FINISHED,
              });
              await rebroadcastRoomState({
                roomId: room.id,
                roundId: waiting.id,
                phase: RoundPhase.WAITING,
              });
            } catch (error) {
              console.error(
                '[scheduler] finished announcement recovery failed',
                previous.id,
                error,
              );
            }
            continue;
          }
          if (
            settings.round.assistantEnabled === false
            && !finishedAnnouncementReady
          ) {
            continue;
          }
          const bankerRepostCancelled =
            previous?.phase === RoundPhase.CANCELLED
            && previous.cancelReason === '庄家重推';
          const roomStartMode =
            room.roundStartMode
            ?? (settings.round.autoStart ? RoomStartMode.AUTO : RoomStartMode.MANUAL);
          if (
            roomStartMode === RoomStartMode.STOPPED
            || (
              roomStartMode === RoomStartMode.MANUAL
              && !bankerRepostCancelled
            )
          ) {
            continue;
          }
          if (continuationRejected && previous) {
            await rejectInsufficientContinuation({
              previousRoundId: previous.id,
            }).catch((error) => {
              console.error(
                '[scheduler] rejected continuation recovery failed',
                previous.id,
                error,
              );
            });
            continue;
          }
          let continuationError: ReturnType<typeof bankerContinuationError> | undefined;
          if (previous?.bankerId && previous.configSnapshot) {
            const continuationSettings = parseSettingsSnapshot(previous.configSnapshot);
            continuationError = bankerContinuationError({
              previous: {
                ...previous,
                continuationStartedAt: finishedAnnouncement?.createdAt ?? null,
              },
              next: waiting,
              userId: previous.bankerId,
              windowSeconds: continuationSettings.round.continuationWindowSeconds,
              now,
            });
          }
          if (continuationError === null && previous) {
            let funding: Awaited<ReturnType<typeof bankerContinuationFunding>>;
            try {
              funding = await bankerContinuationFunding(previous.id);
            } catch (error) {
              console.error('[scheduler] continuation funding check failed', previous.id, error);
              continue;
            }
            if (!funding.sufficient && !funding.autoFundableVirtual) {
              await rejectInsufficientContinuation({
                previousRoundId: previous.id,
                requiredCents: funding.requiredCents,
                availableCents: funding.availableCents,
              }).catch((error) => {
                console.error(
                  '[scheduler] insufficient continuation fallback failed',
                  previous.id,
                  error,
                );
              });
              continue;
            }
            await scheduleVirtualContinuationForRound(room.id, previous.id).catch(
              (error) => {
                console.error(
                  '[scheduler] virtual continuation scheduling failed',
                  previous.id,
                  error,
                );
              },
            );
          }
          if (
            !bankerRepostCancelled
            && !shouldStartWaitingRound({
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
              { force: true },
            ).catch(() => undefined);
          }
          await transition(waiting.id, room.id, RoundPhase.WAITING, () =>
            startRound(
              waiting.id,
              false,
              undefined,
              bankerRepostCancelled ? 'REPLACEMENT' : 'AUTO',
            ),
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
