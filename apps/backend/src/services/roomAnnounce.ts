/**
 * 网页互动群「小助手」播报文案：按对局阶段渲染可配置模板。
 * 对齐竞品体验：开局竞标 → 开注 → 封盘等发包 → 开始抢包 → 认额/成绩单。
 */
import { BetStatus, RoundPhase } from '@prisma/client';
import { bettingRange, fromCents } from '../engine/betting.js';
import { formatScoreboard } from '../bot/messages.js';
import { prisma } from '../lib/prisma.js';
import {
  getMessageTemplatesForRoom,
  parseSettingsSnapshot,
  renderMessage,
  type MessageTemplates,
} from './gameSettings.js';

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
  if (user.tgUsername) return `@${user.tgUsername}`;
  const name = user.nickname?.trim();
  return name ? `@${name}` : `@UID${user.uid}`;
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
    return `@${bet.user.nickname} ${fromCents(bet.amountCents)}${bet.isAllIn ? '梭哈' : ''}`;
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

export type AnnounceMessage =
  | { kind: 'text'; content: string }
  | { kind: 'banner'; banner: AnnounceBanner }
  | {
      kind: 'countdown';
      mode: 'bid' | 'bet' | 'claim';
      endsAt: string;
      template: string;
    };

function text(content: string): AnnounceMessage {
  return { kind: 'text', content };
}

function banner(key: AnnounceBanner): AnnounceMessage {
  return { kind: 'banner', banner: key };
}

function countdown(
  mode: 'bid' | 'bet' | 'claim',
  endsAt: Date | null | undefined,
  template: string,
): AnnounceMessage | null {
  if (!endsAt) return null;
  return {
    kind: 'countdown',
    mode,
    endsAt: endsAt.toISOString(),
    template: stripHtml(template),
  };
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
        select: { uid: true, nickname: true, tgUsername: true },
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
            minBid: fromCents(settings?.round.bankerBidMinCents ?? 10_000),
          }),
        ),
      ),
    ];
    const live = countdown(
      'bid',
      round.bidEndsAt,
      '竞标倒计时 · 还剩 {{remaining}} 秒\n直接发送金额出价，时间到进入最终确认！',
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
            shMax: fromCents(range?.shMaxCents ?? 0),
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
    return [
      banner('bet-stop'),
      text(buildSealedSummary(templates, round, banker)),
      text(
        stripHtml(
          renderMessage(templates.dicePrompt, {
            banker: banker ? mention(banker) : '庄家',
          }),
        ),
      ),
    ];
  }

  if (params.to === RoundPhase.CLAIMING) {
    const claimSeconds = settings?.round.claimDurationSeconds ?? 30;
    const messages: AnnounceMessage[] = [
      banner('claim-start'),
      text(stripHtml(renderMessage(templates.claimStart, { claimSeconds }))),
      text(stripHtml(renderMessage(templates.claimWarning, { claimSeconds }))),
    ];
    const live = countdown('claim', round.claimEndsAt, templates.claimCountdown);
    if (live) messages.push(live);
    return messages;
  }

  if (params.to === RoundPhase.CLAIM_EXPIRED) {
    const rakePercent = Math.round((settings?.fees.rakeRatio ?? 0.05) * 100);
    return [
      banner('claim-stop'),
      text(stripHtml(templates.claimExpired)),
      text(
        stripHtml(
          renderMessage(templates.rakeNotice, {
            playerRake: rakePercent,
            bankerRake: rakePercent,
          }),
        ),
      ),
    ];
  }

  if (params.to === RoundPhase.SETTLING) {
    return [text(stripHtml(templates.settlingWait))];
  }

  if (params.to === RoundPhase.FINISHED) {
    const messages = [text(stripHtml(templates.settlingWait))];
    if (round.scoreboard) {
      for (const chunk of formatScoreboard(round.scoreboard)) {
        messages.push(text(stripHtml(chunk)));
      }
    } else {
      messages.push(text(`🏆 第 ${round.seqNo} 局结算完成`));
    }
    // 局末询问庄家是否续庄（按钮由前端续庄窗展示）
    if (
      banker &&
      settings &&
      !round.continuationUsed &&
      !round.isContinued
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
            reason: round.cancelReason ?? '运营取消',
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
