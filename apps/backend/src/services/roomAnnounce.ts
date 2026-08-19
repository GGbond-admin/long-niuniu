/**
 * 网页互动群「小助手」播报文案：按对局阶段渲染可配置模板。
 * 对齐竞品体验：开局竞标 → 开注 → 封盘等发包 → 开始抢包 → 认额/成绩单。
 */
import { BetStatus, RoundPhase, UserKind } from '@prisma/client';
import { bettingRange, fromCents } from '../engine/betting.js';
import { bankerSeatFee, DEFAULT_FEE_CONFIG, rakeRatioFor } from '../engine/fees.js';
import {
  formatScoreboard,
  type ScoreboardPresentation,
} from '../bot/messages.js';
import { prisma } from '../lib/prisma.js';
import { cancelReasonText } from './errorMessages.js';
import {
  getMessageTemplatesForRoom,
  parseSettingsSnapshot,
  renderMessage,
  type MessageTemplates,
} from './gameSettings.js';

/** 0.03 → "3"、0.045 → "4.5"（模板里已带 % 符号） */
function formatPercent(ratio: number): string {
  return String(Math.round(ratio * 1000) / 10);
}

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

function mention(user: {
  uid: string;
  nickname?: string | null;
  tgUsername?: string | null;
}): string {
  // 群内 @ 优先显示玩家昵称，避免暴露 Telegram 用户名或 UID
  const name = user.nickname?.trim();
  if (name) return `@${name}`;
  if (user.tgUsername) return `@${user.tgUsername}`;
  return `@UID${user.uid}`;
}

async function loadRound(roundId: string) {
  return prisma.round.findUnique({
    where: { id: roundId },
    include: {
      room: { select: { id: true, title: true } },
      bets: {
        where: { status: BetStatus.FROZEN },
        include: { user: { select: { uid: true, nickname: true, tgUsername: true } } },
        orderBy: { createdAt: 'asc' },
      },
      packet: true,
      scoreboard: true,
      events: {
        where: { type: 'BANKER_REPOST_WINDOW' },
        select: { type: true, payload: true },
        take: 1,
      },
    },
  });
}

function buildSealedSummary(
  templates: MessageTemplates,
  round: NonNullable<Awaited<ReturnType<typeof loadRound>>>,
  banker: {
    uid: string;
    nickname?: string | null;
    tgUsername?: string | null;
  } | null,
): string {
  const pot = fromCents(round.potCents);
  const packetTotalRm = fromCents(round.packet?.totalCents ?? 0n);
  const packetCount = round.packet?.participantCount ?? round.bets.length + 1;
  let betSum = 0n;
  let shSum = 0n;
  const betLines = round.bets.map((bet) => {
    betSum += bet.amountCents;
    if (bet.isAllIn) shSum += bet.amountCents;
    return `${mention(bet.user)} ${fromCents(bet.amountCents)}${bet.isAllIn ? '梭哈' : ''}`;
  });
  const settings = round.configSnapshot
    ? parseSettingsSnapshot(round.configSnapshot)
    : null;
  return stripHtml(
    renderMessage(templates.sealedSummary, {
      seqNo: round.seqNo,
      banker: banker ? mention(banker) : '—',
      pot,
      packetTotal: packetTotalRm,
      packetCount,
      betTotal: fromCents(betSum),
      shTotal: fromCents(shSum),
      tailPackerBanker: settings?.round.tailPackerBankerName ?? '代包手·庄家尾包',
      tailPackerPlayer: settings?.round.tailPackerPlayerName ?? '代包手·闲家尾包',
      betList: betLines.length ? betLines.join('\n') : '（无人下注）',
    }),
  );
}

export type AnnounceBanner = 'bet-start' | 'bet-stop' | 'claim-start' | 'claim-stop';

export type AnnounceMessage = (
  | { kind: 'text'; content: string }
  | { kind: 'banner'; banner: AnnounceBanner }
  | {
      kind: 'countdown';
      mode: 'bid' | 'bet' | 'claim' | 'repost';
      endsAt: string;
      template: string;
      afterTemplate?: string;
    }
) & {
  /** 发送本条前等待的毫秒数：给红包卡片留出停留时间，避免立刻被顶出屏幕 */
  delayMs?: number;
  /** 成绩单等需要后续原位更新的消息使用稳定语义键。 */
  messageKey?: string;
  scoreboardChunkIndex?: number;
};

function text(
  content: string,
  options?: Pick<AnnounceMessage, 'messageKey' | 'scoreboardChunkIndex'>,
): AnnounceMessage {
  return { kind: 'text', content, ...options };
}

function banner(key: AnnounceBanner): AnnounceMessage {
  return { kind: 'banner', banner: key };
}

function minimumWholeBid(cents: string | number | bigint): string {
  const normalized =
    typeof cents === 'bigint'
      ? cents
      : typeof cents === 'number'
        ? BigInt(Math.round(cents))
        : BigInt(cents);
  return ((normalized + 99n) / 100n).toString();
}

function countdown(
  mode: 'bid' | 'bet' | 'claim' | 'repost',
  endsAt: Date | null | undefined,
  template: string,
  afterTemplate?: string,
): AnnounceMessage | null {
  if (!endsAt) return null;
  return {
    kind: 'countdown',
    mode,
    endsAt: endsAt.toISOString(),
    template: stripHtml(template),
    afterTemplate: afterTemplate ? stripHtml(afterTemplate) : undefined,
  };
}

function eventEndsAt(payload: unknown): Date | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as { endsAt?: unknown }).endsAt;
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 返回本阶段应推送到互动群的小助手消息列表（文本 + 阶段横幅图） */
export async function buildRoundAnnounceMessages(params: {
  roundId: string;
  to: string;
}): Promise<AnnounceMessage[]> {
  const round = await loadRound(params.roundId);
  if (!round) return [text(`阶段变更：${params.to}`)];
  const templates = await getMessageTemplatesForRoom(round.roomId);

  const banker = round.bankerId
    ? await prisma.user.findUnique({
        where: { id: round.bankerId },
        select: {
          uid: true,
          nickname: true,
          tgUsername: true,
          kind: true,
          wallet: { select: { availableCents: true } },
          virtualPlayer: {
            select: { enabled: true, canContinue: true },
          },
        },
      })
    : null;

  const settings = round.configSnapshot
    ? parseSettingsSnapshot(round.configSnapshot)
    : null;

  if (params.to === RoundPhase.BANKER_BID) {
    const bidSeconds = settings?.round.bidDurationSeconds ?? 30;
    const messages: AnnounceMessage[] = [
      text(
        stripHtml(
          renderMessage(templates.bidStart, {
            seqNo: round.seqNo,
            bidSeconds,
            minBid: minimumWholeBid(settings?.round.bankerBidMinCents ?? 10_000),
          }),
        ),
      ),
    ];
    const live = countdown(
      'bid',
      round.bidEndsAt,
      '竞标倒计时 · 还剩 {{remaining}} 秒\n首次报整数，后续每次固定加 RM 100。',
    );
    if (live) messages.push(live);
    return messages;
  }

  if (params.to === RoundPhase.BETTING) {
    const players = Math.max(1, round.bets.length + (banker ? 1 : 0));
    const range = settings
      ? bettingRange(Number(round.potCents), Math.max(players, 1), settings.betting)
      : null;
    const bankerLabel = banker ? mention(banker) : '—';
    const pot = fromCents(round.potCents);
    const messages: AnnounceMessage[] = [
      text(
        stripHtml(
          renderMessage(templates.bankerSelected, {
            seqNo: round.seqNo,
            banker: bankerLabel,
            pot,
          }),
        ),
      ),
      banner('bet-start'),
      text(
        stripHtml(
          renderMessage(templates.betStart, {
            seqNo: round.seqNo,
            banker: bankerLabel,
            pot,
            betSeconds: settings?.round.betDurationSeconds ?? 50,
            betMin: fromCents(range?.betMinCents ?? 200),
            betMax: fromCents(range?.betMaxCents ?? 0),
            shMin: fromCents(range?.shMinCents ?? 2_000),
            shMax: '各自余额',
          }),
        ),
      ),
    ];
    // 与顶栏共用 betEndsAt，聊天内每秒刷新剩余秒数
    const live = countdown('bet', round.betEndsAt, templates.betCountdown);
    if (live) messages.push(live);
    return messages;
  }

  if (params.to === RoundPhase.SENDING_PACKET) {
    const repostSeconds = settings?.round.repostWindowSeconds ?? 5;
    const diceSeconds = settings?.round.bankerDiceTimeoutSeconds ?? 15;
    let prompt = stripHtml(
      renderMessage(templates.dicePrompt, {
        banker: banker ? mention(banker) : '庄家',
        repostWindow: repostSeconds,
        remaining: '{{remaining}}',
        diceSeconds,
      }),
    );
    if (!prompt.includes('{{remaining}}')) {
      const staticTitle = /【封盘确认\s*·\s*\d+\s*秒】/;
      prompt = staticTitle.test(prompt)
        ? prompt.replace(staticTitle, '【封盘确认 · {{remaining}} 秒】')
        : `【封盘确认 · {{remaining}} 秒】\n${prompt}`;
    }
    const repostEndsAt = eventEndsAt(
      round.events.find((item) => item.type === 'BANKER_REPOST_WINDOW')?.payload,
    );
    const live = countdown(
      'repost',
      repostEndsAt,
      prompt,
      `【封盘确认已结束】\n请庄家在 ${diceSeconds} 秒内完成投骰，超时自动取消并退款`,
    );
    return [
      banner('bet-stop'),
      text(buildSealedSummary(templates, round, banker)),
      live ?? text(prompt.replace(/\{\{\s*remaining\s*\}\}/g, String(repostSeconds))),
    ];
  }

  if (params.to === RoundPhase.CLAIMING) {
    const claimSeconds = settings?.round.claimDurationSeconds ?? 40;
    // 红包卡片刚插入聊天流：横幅后的台词各慢 2 秒发出，让玩家先看到红包。
    // 不再发「抢包进行中 · 还剩 N 秒」倒计时气泡，顶栏倒计时已足够。
    return [
      banner('claim-start'),
      {
        ...text(stripHtml(renderMessage(templates.claimStart, { claimSeconds }))),
        delayMs: 2_000,
      },
      {
        ...text(stripHtml(renderMessage(templates.claimWarning, { claimSeconds }))),
        delayMs: 2_000,
      },
    ];
  }

  if (params.to === RoundPhase.CLAIM_EXPIRED) {
    const playerRakePercent = formatPercent(
      settings ? rakeRatioFor('PLAYER', settings.fees) : DEFAULT_FEE_CONFIG.playerRakeRatio,
    );
    const bankerRakePercent = formatPercent(
      settings ? rakeRatioFor('BANKER', settings.fees) : DEFAULT_FEE_CONFIG.bankerRakeRatio,
    );
    return [
      banner('claim-stop'),
      text(stripHtml(templates.claimExpired)),
      text(
        stripHtml(
          renderMessage(templates.rakeNotice, {
            playerRake: playerRakePercent,
            bankerRake: bankerRakePercent,
          }),
        ),
      ),
    ];
  }

  if (params.to === RoundPhase.SETTLING) {
    return [text(stripHtml(templates.settlingWait))];
  }

  if (params.to === RoundPhase.FINISHED) {
    const messages = [
      text(stripHtml(templates.settlingWait), { messageKey: 'finished:settling' }),
    ];
    if (round.scoreboard) {
      const presentation =
        round.scoreboard.presentation
        && typeof round.scoreboard.presentation === 'object'
        && !Array.isArray(round.scoreboard.presentation)
          ? round.scoreboard.presentation as ScoreboardPresentation
          : {};
      const chunks = formatScoreboard(round.scoreboard, presentation);
      for (let index = 0; index < chunks.length; index += 1) {
        messages.push(
          text(stripHtml(chunks[index]!), {
            messageKey: `scoreboard:${index}`,
            scoreboardChunkIndex: index,
          }),
        );
      }
    } else {
      messages.push(
        text(`🏆 第 ${round.seqNo} 局结算完成`, {
          messageKey: 'scoreboard:0',
          scoreboardChunkIndex: 0,
        }),
      );
    }
    const continuationReserve =
      settings
        ? round.potCents
          + BigInt(
            bankerSeatFee(Number(round.potCents), settings.fees)
            + settings.fees.serviceFeeCents,
          )
        : null;
    const continuationFundingInsufficient =
      continuationReserve !== null
      && banker?.wallet
      && banker.wallet.availableCents < continuationReserve
      && !(
        banker.kind === UserKind.VIRTUAL
        && banker.virtualPlayer?.enabled === true
        && banker.virtualPlayer.canContinue
      );
    // 局末询问庄家是否续庄（按钮由前端续庄窗展示）。
    // 已知余额不足时不展示无效按钮，完成事件落库后由 scheduler 发幂等提示并开竞标。
    if (
      banker &&
      settings &&
      !round.continuationUsed &&
      !round.isContinued
      && !continuationFundingInsufficient
    ) {
      messages.push(
        text(
          stripHtml(
            renderMessage(templates.continuationPrompt, {
              banker: mention(banker),
              window: settings.round.continuationWindowSeconds,
              pot: fromCents(round.potCents),
            }),
          ),
          { messageKey: 'continuation' },
        ),
      );
    }
    return messages;
  }

  if (params.to === RoundPhase.CANCELLED) {
    return [
      text(
        stripHtml(
          renderMessage(templates.cancelled, {
            seqNo: round.seqNo,
            reason: cancelReasonText(round.cancelReason),
          }),
        ),
      ),
    ];
  }

  if (params.to === RoundPhase.WAITING) {
    return [text('本局已结束，等待下一局开局…')];
  }

  return [text(`阶段变更：${params.to}`)];
}
