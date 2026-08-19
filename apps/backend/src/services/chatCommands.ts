/**
 * 网页互动群聊天指令：数字竞标/下注、sh 梭哈、0 撤回、/重推。
 */
import { RoundPhase } from '@prisma/client';
import { fromCents, toCentsBigInt } from '../engine/betting.js';
import { prisma } from '../lib/prisma.js';
import { withRedisLock } from '../lib/redis.js';
import {
  cancelRound,
  currentRoundForRoom,
  GameError,
  placeBankerBid,
  placeBet,
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
import { WalletError } from './wallet.js';
import { gameErrorMessage, walletErrorMessage } from './errorMessages.js';

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

function compactMoney(cents: bigint): string {
  return fromCents(cents).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
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
    ? `${action === 'all_in' ? 'sh' : ''}${compactMoney(acceptedCents)}`
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

const MUTED_PHASES = new Set<string>([RoundPhase.CLAIMING]);
const diceCeremonyInFlight = new Map<string, Promise<DiceThrowResult>>();

/**
 * 与小程序 SequentialDice 节奏对齐（单颗：转动 720 + 落地 380 + 间隔 180 ≈ 1280ms）。
 * 后端必须等上一颗动画走完再推下一颗，最后一颗落地后再播报点数，否则助手会「抢跑」。
 */
const BANKER_DICE_BETWEEN_MS = 1_400;
const BANKER_DICE_BEFORE_ANNOUNCE_MS = 1_500;
const BANKER_DICE_CEREMONY_LOCK_MS = 20_000;

export function isChatMuted(phase: string | null | undefined): boolean {
  return !!phase && MUTED_PHASES.has(phase);
}

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
    return { kind: 'error', message: '当前不是掷骰阶段，请等待小助手播报投骰后再试' };
  }
  if (round.bankerId !== params.userId) {
    return { kind: 'error', message: '仅本局庄家可投骰子' };
  }
  if (await roundEventExists(round.id, 'BANKER_DICE_READY_FOR_PACKET')) {
    return { kind: 'error', message: '本局已投过骰子' };
  }
  const existing = await prisma.roundEvent.findFirst({
    where: { roundId: round.id, type: 'BANKER_DICE' },
    select: { id: true, payload: true },
  });
  let dice = diceFromPayload(existing?.payload);
  if (existing && !dice) return { kind: 'error', message: '本局投骰记录异常，请联系运营处理' };
  if (!dice) {
    dice = [
      1 + Math.floor(Math.random() * 6),
      1 + Math.floor(Math.random() * 6),
      1 + Math.floor(Math.random() * 6),
    ];
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
            return { kind: 'error', message: '当前不是掷骰阶段，请等待小助手播报投骰后再试' };
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
            return { kind: 'error', message: '小助手封盘播报尚未完成，请稍后再试' };
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
              return { kind: 'error', message: '小助手已暂停，恢复后才能完成开骰播报' };
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
              return { kind: 'error', message: '小助手已暂停，恢复后才能进入发包阶段' };
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

function parseAmountToken(raw: string): string | null {
  const value = raw.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  return value;
}

/** 普通文字无需加载整局；只有这些形态可能进入牌局指令处理。 */
export function isRoomCommandCandidate(raw: string): boolean {
  const text = raw.trim();
  return (
    /^\/重推$/i.test(text) ||
    /^\/ChongTui$/i.test(text) ||
    /^sh\s*\d+(?:\.\d{1,2})?$/i.test(text) ||
    parseAmountToken(text) !== null
  );
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

  if (isChatMuted(phase)) {
    return { kind: 'muted', message: '抢红包阶段禁止发言，请专注领取' };
  }

  // /重推：庄家在待发包阶段可取消本局重开
  if (/^\/重推$/i.test(text) || /^\/ChongTui$/i.test(text)) {
    if (!round) return { kind: 'error', message: '当前没有进行中的牌局' };
    if (round.phase !== RoundPhase.SENDING_PACKET) {
      return { kind: 'error', message: '仅在等待发包阶段可重推本局' };
    }
    if (round.bankerId !== params.userId) {
      return { kind: 'error', message: '仅本局庄家可重推' };
    }
    try {
      const cancelled = await cancelRound(round.id, '庄家重推', params.userId);
      gameBus.transition({
        roundId: round.id,
        roomId: params.roomId,
        from: RoundPhase.SENDING_PACKET,
        to: cancelled.phase,
      });
      return { kind: 'ok', action: 'repost', echo: text };
    } catch (e) {
      return {
        kind: 'error',
        message: e instanceof GameError ? e.code : '重推失败',
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
      return {
        kind: 'ok',
        action: 'bid',
        echo: amountToken,
        ...(bid?.extendedEndsAt ? { bidExtendedEndsAt: bid.extendedEndsAt } : {}),
      };
    } catch (e) {
      return {
        kind: 'error',
        message:
          e instanceof GameError && e.code === 'PHASE_ENDED'
            ? '竞标已截止，正在进行 3、2、1 最终确认'
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
