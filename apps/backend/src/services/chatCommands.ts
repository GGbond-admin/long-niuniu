/**
 * 网页互动群聊天指令：数字竞标/下注、sh 梭哈、0 撤回、发送「重推」整局。
 */
import { RoundPhase } from '@prisma/client';
import { fromCents, toCentsBigInt } from '../engine/betting.js';
import { prisma } from '../lib/prisma.js';
import { withRedisLock } from '../lib/redis.js';
import {
  cancelRound,
  currentRoundForRoom,
  ensureWaitingRound,
  GameError,
  placeBankerBid,
  placeBet,
  startRound,
  type PlaceBetResult,
  withdrawBet,
} from './game.js';
import { gameBus } from './gameBus.js';
import {
  getMessageTemplatesForRoom,
  renderMessage,
} from './gameSettings.js';
import {
  appendChatOnce,
  appendSystemChatOnce,
  ensureRoundAnnouncement,
} from './roomHub.js';
import {
  phaseChatPolicy,
  roomChatPolicyMessage,
} from './roomChatPolicy.js';
import { WalletError } from './wallet.js';
import { gameErrorMessage, walletErrorMessage, bankerBidAdjustedNotice } from './errorMessages.js';

export type ChatCommandAction =
  | 'repost'
  | 'all_in'
  | 'withdraw'
  | 'bid'
  | 'bet';

type BetAcceptanceDetails = {
  requestedAmountCents: string;
  liabilityBalanceCents: string;
  maxAffordableCents: string;
  roomMaxCents: string;
  maxAcceptedCents: string;
  maxMultiplier: number;
  /** 本笔预留倍数：普通=本局最高牌型倍数，梭哈=1（1:1 赔付） */
  liabilityMultiplier: number;
  reservedCents: string;
  adjusted: boolean;
  adjustedBy: string[];
};

export type ChatCommandResult =
  | { kind: 'ignored' }
  | { kind: 'muted'; message: string }
  | {
      kind: 'ok';
      action: ChatCommandAction;
      echo: string;
      amountCents?: string;
      acceptance?: BetAcceptanceDetails;
      /** 竞标防狙击：最后 5 秒新高价触发的新截止时间 */
      bidExtendedEndsAt?: Date;
      /** 出价被余额上限截断后的说明，成功落标仍发给本人 */
      notice?: string;
    }
  | {
      kind: 'error';
      message: string;
      action?: ChatCommandAction;
      amountCents?: string;
    };

export type PrivateBetConfirmation = {
  type: 'bet_confirmation';
  status: 'success' | 'failed';
  action: 'bet' | 'all_in';
  /** 最终实际接受金额 */
  amountCents: string;
  acceptance?: BetAcceptanceDetails;
  reason?: string;
};

/** 仅成功执行的游戏指令可写入聊天语义，普通数字文字不能由前端自行猜测。 */
export function confirmedChatGameAction(
  result: ChatCommandResult,
): Exclude<ChatCommandAction, 'repost'> | undefined {
  if (result.kind !== 'ok' || result.action === 'repost') return undefined;
  return result.action;
}

/** 只回给发起下注的 socket，不写群聊、不进入公共历史。 */
export function privateBetConfirmationFor(
  result: ChatCommandResult,
): PrivateBetConfirmation | null {
  if (
    (result.kind !== 'ok' && result.kind !== 'error') ||
    (result.action !== 'bet' && result.action !== 'all_in') ||
    !result.amountCents
  ) {
    return null;
  }
  return result.kind === 'ok'
    ? {
        type: 'bet_confirmation',
        status: 'success',
        action: result.action,
        amountCents: result.amountCents,
        ...(result.acceptance ? { acceptance: result.acceptance } : {}),
      }
    : {
        type: 'bet_confirmation',
        status: 'failed',
        action: result.action,
        amountCents: result.amountCents,
        reason: result.message,
      };
}

function parseCommandAmountCents(amount: string): bigint {
  try {
    return toCentsBigInt(amount);
  } catch (error) {
    throw new GameError(
      error instanceof Error && error.message === 'AMOUNT_TOO_LARGE'
        ? 'AMOUNT_TOO_LARGE'
        : 'INVALID_AMOUNT',
    );
  }
}

function successfulBetCommand(
  action: 'bet' | 'all_in',
  originalEcho: string,
  requestedCents: bigint,
  result: PlaceBetResult,
): Extract<ChatCommandResult, { kind: 'ok' }> {
  // 测试替身或滚动部署中的旧实现若暂未返回结构，保持原金额兼容。
  const acceptedCents = result?.acceptedCents ?? requestedCents;
  const adjusted = result?.adjusted ?? acceptedCents !== requestedCents;
  const echo = adjusted
    ? `${action === 'all_in' ? 'sh' : ''}${fromCents(acceptedCents)}`
    : originalEcho;
  const acceptance =
    result?.liabilityBalanceCents !== undefined
      ? {
          requestedAmountCents: String(requestedCents),
          liabilityBalanceCents: String(result.liabilityBalanceCents),
          maxAffordableCents: String(result.maxAffordableCents),
          roomMaxCents: String(result.roomMaxCents),
          maxAcceptedCents: String(result.maxAcceptedCents),
          maxMultiplier: result.maxMultiplier,
          liabilityMultiplier: result.liabilityMultiplier ?? result.maxMultiplier,
          reservedCents: String(result.reservedCents),
          adjusted,
          adjustedBy: result.adjustedBy,
        }
      : undefined;
  return {
    kind: 'ok',
    action,
    echo,
    amountCents: String(acceptedCents),
    ...(acceptance ? { acceptance } : {}),
  };
}

const diceCeremonyInFlight = new Map<string, Promise<DiceThrowResult>>();

/**
 * 与小程序 SequentialDice 节奏对齐（单颗：转动 720 + 落地 380 + 间隔 180 ≈ 1280ms）。
 * 后端必须等上一颗动画走完再推下一颗，最后一颗落地后再播报点数，否则助手会「抢跑」。
 */
const BANKER_DICE_BETWEEN_MS = 1_400;
const BANKER_DICE_BEFORE_ANNOUNCE_MS = 1_500;
const BANKER_DICE_CEREMONY_LOCK_MS = 20_000;
const BANKER_REPOST_WINDOW_EVENT = 'BANKER_REPOST_WINDOW';
const BANKER_DICE_DEADLINE_EVENT = 'BANKER_DICE_DEADLINE';
const LEGACY_BANKER_DICE_TIMEOUT_MS = 15_000;

export type DiceThrowResult =
  | { kind: 'error'; message: string }
  | {
      kind: 'ok';
      roundId: string;
      dice: [number, number, number];
      announce: string;
      waitForPacket: string;
      from: { uid: string; nickname: string; avatarUrl?: string | null };
    };

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function diceFromPayload(payload: unknown): [number, number, number] | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const values = (payload as { dice?: unknown }).dice;
  if (
    !Array.isArray(values) ||
    values.length !== 3 ||
    values.some((value) => !Number.isInteger(value) || Number(value) < 1 || Number(value) > 6)
  ) {
    return null;
  }
  return [Number(values[0]), Number(values[1]), Number(values[2])];
}

function repostEndsAtFromPayload(payload: unknown): Date | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as { endsAt?: unknown }).endsAt;
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function randomDice(): [number, number, number] {
  return [
    1 + Math.floor(Math.random() * 6),
    1 + Math.floor(Math.random() * 6),
    1 + Math.floor(Math.random() * 6),
  ];
}

async function latestBankerDiceEvent(roundId: string) {
  return prisma.roundEvent.findFirst({
    where: { roundId, type: 'BANKER_DICE' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, payload: true, createdAt: true },
  });
}

async function roundEventExists(roundId: string, type: string): Promise<boolean> {
  return !!(await prisma.roundEvent.findFirst({
    where: { roundId, type },
    select: { id: true },
  }));
}

async function recordRoundEvent(roundId: string, type: string, payload?: object): Promise<void> {
  if (await roundEventExists(roundId, type)) return;
  await prisma.roundEvent.create({
    data: {
      roundId,
      type,
      payload: payload ?? { at: new Date().toISOString() },
    },
  });
}

/**
 * 准备庄家骰子。若进程曾在播报中断，复用已落库点数恢复仪式，不重新随机。
 */
export async function throwBankerDice(params: {
  roomId: string;
  userId: string;
}): Promise<DiceThrowResult> {
  const round = await currentRoundForRoom(params.roomId);
  if (!round) return { kind: 'error', message: '当前没有进行中的牌局' };
  if (round.phase !== RoundPhase.SENDING_PACKET) {
    return { kind: 'error', message: '当前不是掷骰阶段，请等待系统播报投骰后再试' };
  }
  if (round.bankerId !== params.userId) {
    return { kind: 'error', message: '仅本局庄家可投骰子' };
  }
  if (await roundEventExists(round.id, 'BANKER_DICE_READY_FOR_PACKET')) {
    return { kind: 'error', message: '本局已投过骰子' };
  }
  const existing = await latestBankerDiceEvent(round.id);
  if (!existing) {
    const repostWindow = await prisma.roundEvent.findFirst({
      where: { roundId: round.id, type: BANKER_REPOST_WINDOW_EVENT },
      select: { payload: true },
    });
    const repostEndsAt = repostEndsAtFromPayload(repostWindow?.payload);
    if (repostEndsAt && Date.now() < repostEndsAt.getTime()) {
      const remaining = Math.max(
        1,
        Math.ceil((repostEndsAt.getTime() - Date.now()) / 1_000),
      );
      return {
        kind: 'error',
        message: `封盘确认中，还剩 ${remaining} 秒；如需取消退款并重开，请发送 重推`,
      };
    }
    const diceDeadline = await prisma.roundEvent.findFirst({
      where: { roundId: round.id, type: BANKER_DICE_DEADLINE_EVENT },
      select: { payload: true },
    });
    const diceEndsAt =
      repostEndsAtFromPayload(diceDeadline?.payload)
      ?? (repostEndsAt
        ? new Date(repostEndsAt.getTime() + LEGACY_BANKER_DICE_TIMEOUT_MS)
        : null);
    if (diceEndsAt && Date.now() >= diceEndsAt.getTime()) {
      return {
        kind: 'error',
        message: '庄家投骰时间已结束，本局正在自动取消',
      };
    }
  }
  let dice = diceFromPayload(existing?.payload);
  if (existing && !dice) return { kind: 'error', message: '本局投骰记录异常，请联系运营处理' };
  if (!dice) {
    dice = randomDice();
    await prisma.roundEvent.create({
      data: {
        roundId: round.id,
        type: 'BANKER_DICE',
        actorId: params.userId,
        payload: { dice },
      },
    });
  }
  const banker = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { uid: true, nickname: true, tgUsername: true, avatarUrl: true },
  });
  const templates = await getMessageTemplatesForRoom(params.roomId);
  const announce = stripHtml(
    renderMessage(templates.bankerDice, {
      seqNo: round.seqNo,
      banker: banker?.nickname?.trim()
        ? `@${banker.nickname.trim()}`
        : banker?.tgUsername
          ? `@${banker.tgUsername}`
          : `@UID${banker?.uid ?? ''}`,
      dice: dice.join('·'),
    }),
  );
  return {
    kind: 'ok',
    roundId: round.id,
    dice,
    announce,
    waitForPacket: stripHtml(templates.sealed),
    from: {
      uid: banker?.uid ?? params.userId,
      nickname: banker?.nickname ?? banker?.uid ?? params.userId,
      avatarUrl: banker?.avatarUrl,
    },
  };
}

/** 三颗骰子及其后续机器人话术均已入群后，才允许后台真正发包。 */
export async function markBankerDiceReadyForPacket(roundId: string): Promise<void> {
  await recordRoundEvent(roundId, 'BANKER_DICE_READY_FOR_PACKET');
}

/**
 * 串行执行完整投骰仪式。生产多实例使用 Redis 锁，本地另用 Promise 去重；
 * 每个完成节点写 RoundEvent，重启后可从未完成节点继续。
 */
export function runBankerDiceCeremony(params: {
  roomId: string;
  userId: string;
}): Promise<DiceThrowResult> {
  const localKey = `${params.roomId}:${params.userId}`;
  const pending = diceCeremonyInFlight.get(localKey);
  if (pending) return pending;

  const task = (async () => {
    try {
      const locked = await withRedisLock(
        `niuniu:room:${params.roomId}:banker-dice`,
        BANKER_DICE_CEREMONY_LOCK_MS,
        async (): Promise<DiceThrowResult> => {
          const round = await currentRoundForRoom(params.roomId);
          if (!round) return { kind: 'error', message: '当前没有进行中的牌局' };
          if (round.phase !== RoundPhase.SENDING_PACKET) {
            return { kind: 'error', message: '当前不是掷骰阶段，请等待系统播报投骰后再试' };
          }
          if (round.bankerId !== params.userId) {
            return { kind: 'error', message: '仅本局庄家可投骰子' };
          }

          try {
            await ensureRoundAnnouncement({
              roundId: round.id,
              roomId: params.roomId,
              to: RoundPhase.SENDING_PACKET,
            });
          } catch {
            return { kind: 'error', message: '系统封盘播报尚未完成，请稍后再试' };
          }

          const result = await throwBankerDice(params);
          if (result.kind === 'error') return result;

          if (!(await roundEventExists(result.roundId, 'BANKER_DICE_VISUALS_SENT'))) {
            for (let index = 0; index < result.dice.length; index += 1) {
              await appendChatOnce(
                params.roomId,
                `round:${result.roundId}:banker-dice:${index + 1}`,
                {
                type: 'DICE',
                content: String(result.dice[index]),
                from: result.from,
                },
              );
              if (index < result.dice.length - 1) {
                await new Promise((resolve) => setTimeout(resolve, BANKER_DICE_BETWEEN_MS));
              }
            }
            // 等最后一颗骰子动画落地，再让助手公布点数
            await new Promise((resolve) => setTimeout(resolve, BANKER_DICE_BEFORE_ANNOUNCE_MS));
            await recordRoundEvent(result.roundId, 'BANKER_DICE_VISUALS_SENT', {
              dice: result.dice,
            });
          }

          if (!(await roundEventExists(result.roundId, 'BANKER_DICE_ANNOUNCED'))) {
            const sent = result.announce.trim()
              ? await appendSystemChatOnce(
                  params.roomId,
                  `round:${result.roundId}:banker-dice:result`,
                  result.announce,
                )
              : null;
            if (!sent) {
              return { kind: 'error', message: '系统播报已暂停，恢复后才能完成开骰播报' };
            }
            await recordRoundEvent(result.roundId, 'BANKER_DICE_ANNOUNCED');
          }

          if (!(await roundEventExists(result.roundId, 'BANKER_PACKET_WAIT_ANNOUNCED'))) {
            const sent = result.waitForPacket.trim()
              ? await appendSystemChatOnce(
                  params.roomId,
                  `round:${result.roundId}:banker-dice:wait-packet`,
                  result.waitForPacket,
                )
              : null;
            if (!sent) {
              return { kind: 'error', message: '系统播报已暂停，恢复后才能进入发包阶段' };
            }
            await recordRoundEvent(result.roundId, 'BANKER_PACKET_WAIT_ANNOUNCED');
          }

          await markBankerDiceReadyForPacket(result.roundId);
          return result;
        },
      );
      return locked ?? { kind: 'error', message: '投骰正在处理中，请勿重复操作' };
    } finally {
      diceCeremonyInFlight.delete(localKey);
    }
  })();
  diceCeremonyInFlight.set(localKey, task);
  return task;
}

/** 投骰截止后仍没有 BANKER_DICE 记录时，原子取消牌局并走统一退款。 */
export async function cancelBankerDiceTimeout(params: {
  roundId: string;
  roomId: string;
  now?: Date;
}): Promise<boolean> {
  const locked = await withRedisLock(
    `niuniu:room:${params.roomId}:banker-dice`,
    BANKER_DICE_CEREMONY_LOCK_MS,
    async () => {
      const round = await currentRoundForRoom(params.roomId);
      if (
        !round
        || round.id !== params.roundId
        || round.phase !== RoundPhase.SENDING_PACKET
      ) {
        return false;
      }
      if (await latestBankerDiceEvent(round.id)) return false;

      const [deadlineEvent, repostEvent] = await Promise.all([
        prisma.roundEvent.findFirst({
          where: { roundId: round.id, type: BANKER_DICE_DEADLINE_EVENT },
          select: { payload: true },
        }),
        prisma.roundEvent.findFirst({
          where: { roundId: round.id, type: BANKER_REPOST_WINDOW_EVENT },
          select: { payload: true },
        }),
      ]);
      const repostEndsAt = repostEndsAtFromPayload(repostEvent?.payload);
      const endsAt =
        repostEndsAtFromPayload(deadlineEvent?.payload)
        ?? (repostEndsAt
          ? new Date(repostEndsAt.getTime() + LEGACY_BANKER_DICE_TIMEOUT_MS)
          : null);
      if (!endsAt || (params.now ?? new Date()).getTime() < endsAt.getTime()) {
        return false;
      }

      const cancelled = await cancelRound(
        round.id,
        '庄家投骰超时',
        'SYSTEM',
      );
      gameBus.transition({
        roundId: round.id,
        roomId: params.roomId,
        from: RoundPhase.SENDING_PACKET,
        to: cancelled.phase,
      });
      await ensureRoundAnnouncement({
        roundId: round.id,
        roomId: params.roomId,
        to: cancelled.phase,
      }).catch(() => undefined);
      return true;
    },
  );
  return locked ?? false;
}

async function startReplacementRound(roomId: string): Promise<void> {
  const waiting = await ensureWaitingRound(roomId);
  if (waiting.phase !== RoundPhase.WAITING) return;
  try {
    const started = await startRound(waiting.id, false, undefined, 'REPLACEMENT');
    if (started.phase !== RoundPhase.WAITING) {
      gameBus.transition({
        roundId: waiting.id,
        roomId,
        from: RoundPhase.WAITING,
        to: started.phase,
      });
    }
  } catch (error) {
    // 人数不足时保留新 WAITING 局；人数补齐后调度器会继续开局。
    if (
      error instanceof GameError
      && ['NOT_ENOUGH_PLAYERS', 'ROUND_START_DISABLED'].includes(error.code)
    ) {
      return;
    }
    throw error;
  }
}

function parseAmountToken(raw: string): string | null {
  const value = raw.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  return value;
}

function isDecimalAmountToken(raw: string): boolean {
  return /^\d+\.\d*$/.test(raw.trim().replace(/,/g, ''));
}

/** 普通文字无需加载整局；只有这些形态可能进入牌局指令处理。 */
export function isRoomCommandCandidate(raw: string): boolean {
  const text = raw.trim();
  return (
    isBankerRepostCommand(text) ||
    /^sh\s*\d+(?:\.\d{1,2})?$/i.test(text) ||
    isDecimalAmountToken(text) ||
    parseAmountToken(text) !== null
  );
}

export function isBankerRepostCommand(raw: string): boolean {
  const text = raw.trim();
  return /^\/?重推$/i.test(text) || /^\/?ChongTui$/i.test(text);
}

export async function handleRoomChatCommand(params: {
  roomId: string;
  userId: string;
  content: string;
}): Promise<ChatCommandResult> {
  const text = params.content.trim();
  if (!text) return { kind: 'ignored' };

  const round = await currentRoundForRoom(params.roomId);
  const phase = round?.phase ?? null;
  const chatPolicy = phaseChatPolicy(phase);
  const repostCommand = isBankerRepostCommand(text);

  if (
    chatPolicy.muted
    && !(chatPolicy.stage === 'DICE' && repostCommand)
  ) {
    return { kind: 'muted', message: roomChatPolicyMessage(chatPolicy) };
  }

  // 重推：封盘确认窗口内由庄家发送「重推」取消整局、原路退款，并立即准备下一局。
  if (repostCommand) {
    try {
      const locked = await withRedisLock(
        `niuniu:room:${params.roomId}:banker-dice`,
        BANKER_DICE_CEREMONY_LOCK_MS,
        async (): Promise<ChatCommandResult> => {
          const liveRound = await currentRoundForRoom(params.roomId);
          if (!liveRound) return { kind: 'error', message: '当前没有进行中的牌局' };
          if (liveRound.phase !== RoundPhase.SENDING_PACKET) {
            return { kind: 'error', message: '仅在封盘确认阶段可以重推本局' };
          }
          if (liveRound.bankerId !== params.userId) {
            return { kind: 'error', message: '仅本局庄家可重推' };
          }
          if (await latestBankerDiceEvent(liveRound.id)) {
            return { kind: 'error', message: '本局已经开始投骰，不能再重推' };
          }
          const repostWindow = await prisma.roundEvent.findFirst({
            where: {
              roundId: liveRound.id,
              type: BANKER_REPOST_WINDOW_EVENT,
            },
            select: { payload: true },
          });
          const repostEndsAt = repostEndsAtFromPayload(repostWindow?.payload);
          if (repostEndsAt && Date.now() >= repostEndsAt.getTime()) {
            return { kind: 'error', message: '重推确认时间已结束，请继续完成庄家投骰' };
          }

          const cancelled = await cancelRound(
            liveRound.id,
            '庄家重推',
            params.userId,
          );
          gameBus.transition({
            roundId: liveRound.id,
            roomId: params.roomId,
            from: RoundPhase.SENDING_PACKET,
            to: cancelled.phase,
          });
          await ensureRoundAnnouncement({
            roundId: liveRound.id,
            roomId: params.roomId,
            to: cancelled.phase,
          }).catch(() => undefined);
          // 退款事务已完成即视为重推成功；下一局启动若遇瞬时故障，由调度器继续恢复。
          await startReplacementRound(params.roomId).catch((error) => {
            console.error('[banker-repost] start replacement round failed', liveRound.id, error);
          });
          return { kind: 'ok', action: 'repost', echo: text };
        },
      );
      return locked ?? { kind: 'error', message: '牌局正在处理中，请稍后再试' };
    } catch (e) {
      return {
        kind: 'error',
        message: e instanceof GameError ? humanizeGameError(e) : '重推失败，请稍后再试',
      };
    }
  }

  // sh / SH 梭哈（仅下注阶段生效；其余阶段当普通聊天）
  const shMatch = text.match(/^sh\s*(\d+(?:\.\d{1,2})?)$/i);
  if (shMatch) {
    if (!round || round.phase !== RoundPhase.BETTING) {
      return { kind: 'ignored' };
    }
    let amountCents: string | undefined;
    try {
      const requestedCents = parseCommandAmountCents(shMatch[1]!);
      amountCents = String(requestedCents);
      const result = await placeBet(round.id, params.userId, requestedCents, true);
      return successfulBetCommand('all_in', text, requestedCents, result);
    } catch (e) {
      return {
        kind: 'error',
        action: 'all_in',
        ...(amountCents ? { amountCents } : {}),
        message: humanizeCommandError(e, '梭哈失败'),
      };
    }
  }

  // 纯数字：仅竞标/下注阶段当指令；其余阶段当普通聊天发出
  if (round?.phase === RoundPhase.BANKER_BID && isDecimalAmountToken(text)) {
    return { kind: 'error', message: '竞标金额必须是整数，请勿输入小数' };
  }
  const amountToken = parseAmountToken(text);
  if (amountToken === null) return { kind: 'ignored' };

  if (!round) return { kind: 'ignored' };

  if (amountToken === '0' || Number(amountToken) === 0) {
    if (round.phase !== RoundPhase.BETTING) {
      return { kind: 'ignored' };
    }
    try {
      await withdrawBet(round.id, params.userId);
      return { kind: 'ok', action: 'withdraw', echo: '0' };
    } catch (e) {
      return {
        kind: 'error',
        message: e instanceof GameError ? humanizeGameError(e) : '撤回失败',
      };
    }
  }

  if (round.phase === RoundPhase.BANKER_BID) {
    try {
      const bid = await placeBankerBid(
        round.id,
        params.userId,
        parseCommandAmountCents(amountToken),
      );
      const acceptedAmountCents = bid.amountCents;
      return {
        kind: 'ok',
        action: 'bid',
        echo: (acceptedAmountCents / 100n).toString(),
        amountCents: acceptedAmountCents.toString(),
        ...(bid.adjusted ? { notice: bankerBidAdjustedNotice(acceptedAmountCents) } : {}),
        ...(bid?.extendedEndsAt ? { bidExtendedEndsAt: bid.extendedEndsAt } : {}),
      };
    } catch (e) {
      return {
        kind: 'error',
        message:
          e instanceof GameError && e.code === 'PHASE_ENDED'
            ? '3、2、1 播报已结束，正在锁定庄家'
            : e instanceof GameError
              ? humanizeGameError(e)
              : '竞标失败',
      };
    }
  }

  if (round.phase === RoundPhase.BETTING) {
    let amountCents: string | undefined;
    try {
      const requestedCents = parseCommandAmountCents(amountToken);
      amountCents = String(requestedCents);
      const result = await placeBet(round.id, params.userId, requestedCents, false);
      return successfulBetCommand('bet', amountToken, requestedCents, result);
    } catch (e) {
      return {
        kind: 'error',
        action: 'bet',
        ...(amountCents ? { amountCents } : {}),
        message: humanizeCommandError(e, '下注失败'),
      };
    }
  }

  return { kind: 'ignored' };
}

function humanizeGameError(error: GameError): string {
  return gameErrorMessage(error);
}

function humanizeCommandError(error: unknown, fallback: string): string {
  if (error instanceof GameError) return gameErrorMessage(error);
  if (error instanceof WalletError) return walletErrorMessage(error.code);
  return fallback;
}

export async function ensureUserInRoom(roomId: string, userId: string) {
  return prisma.roomMember.findUnique({
    where: { roomId_userId: { roomId, userId } },
  });
}
