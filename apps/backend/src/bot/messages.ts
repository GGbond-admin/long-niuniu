import type { RoundScoreboard } from '@prisma/client';
import { fromCents } from '../engine/betting.js';
import { compareScoreboardHandOrder } from '../engine/settlement.js';

export type ScoreboardPresentation = {
  title?: string;
  playerAliases?: Record<string, string>;
  playerNotes?: Record<string, string>;
  bankerAlias?: string;
  bankerNote?: string;
  footer?: string;
};

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function mention(line: Record<string, unknown>, override?: string): string {
  // 成绩单 @ 优先显示玩家昵称，避免暴露 Telegram 用户名或 UID
  const overridden = override?.trim();
  if (overridden) return `@${escapeHtml(overridden)}`;
  const nickname = typeof line.nickname === 'string' ? line.nickname.trim() : '';
  if (nickname) return `@${escapeHtml(nickname)}`;
  const username = line.tgUsername;
  if (typeof username === 'string' && username) return `@${escapeHtml(username)}`;
  return `@${escapeHtml(`UID${line.uid}`)}`;
}

function absoluteAmount(value: unknown): string {
  const amount = BigInt(String(value ?? 0));
  return fromCents(amount >= 0n ? amount : -amount);
}

function feeAmount(value: unknown): string {
  return fromCents(String(value ?? 0));
}

function bankerPairStats(
  banker: Record<string, unknown>,
  players: Array<Record<string, unknown>>,
): { counted: number; won: number; lost: number; tied: number } {
  const raw = banker.stats && typeof banker.stats === 'object'
    ? (banker.stats as Record<string, unknown>)
    : null;
  if (raw && ('playerWin' in raw || 'playerLose' in raw || 'tie' in raw)) {
    const won = Number(raw.playerLose ?? 0);
    const lost = Number(raw.playerWin ?? 0);
    const tied = Number(raw.tie ?? 0);
    if ([won, lost, tied].every((item) => Number.isFinite(item) && item >= 0)) {
      return { counted: won + lost + tied, won, lost, tied };
    }
  }
  let won = 0;
  let lost = 0;
  let tied = 0;
  for (const player of players) {
    if (player.outcome === 'BANKER_WIN') won += 1;
    else if (player.outcome === 'PLAYER_WIN') lost += 1;
    else tied += 1;
  }
  return { counted: players.length, won, lost, tied };
}

function bankerFeeLines(banker: Record<string, unknown>): string[] {
  const fees = banker.fees && typeof banker.fees === 'object'
    ? (banker.fees as Record<string, unknown>)
    : null;
  if (!fees) return [];
  return [
    `上庄费-${feeAmount(fees.seatFeeCents)} · 服务费-${feeAmount(fees.serviceFeeCents)} · 代包费-${feeAmount(fees.packetFeeCents)}`,
  ];
}

function bankerProfitLine(netCents: bigint): string {
  const amount = absoluteAmount(netCents);
  if (netCents > 0n) return `庄盈利+${amount}`;
  if (netCents < 0n) return `庄亏损-${amount}`;
  return '庄盈亏 0.00';
}

/**  enclosed CJK 必须带 VS16，否则会被中易/Noto 画成「得」「无」方字，而不是彩色表情 */
export const SCOREBOARD_EMOJI = {
  win: '\u{1F250}\uFE0F',
  lose: '\u{1F21A}\uFE0F',
  tie: '\u{1F4A7}',
  banker: '\u{1F451}',
} as const;

function outcomeDisplay(outcome: unknown): {
  symbol: string;
  label: '赢' | '输' | '水';
} {
  if (outcome === 'PLAYER_WIN') return { symbol: SCOREBOARD_EMOJI.win, label: '赢' };
  if (outcome === 'BANKER_WIN') return { symbol: SCOREBOARD_EMOJI.lose, label: '输' };
  return { symbol: SCOREBOARD_EMOJI.tie, label: '水' };
}

function netLabel(netCents: bigint): '赢' | '输' | '水' {
  if (netCents > 0n) return '赢';
  if (netCents < 0n) return '输';
  return '水';
}

function cumulativeLine(params: {
  beforeCents: unknown;
  afterCents: unknown;
}): string {
  return `上局 ${fromCents(String(params.beforeCents ?? 0))} · 本局 ${fromCents(String(params.afterCents ?? 0))}`;
}

export function formatScoreboard(
  scoreboard: RoundScoreboard,
  presentation: ScoreboardPresentation = {},
): string[] {
  const players = (
    Array.isArray(scoreboard.playerLines)
      ? (scoreboard.playerLines as Array<Record<string, unknown>>)
      : []
  ).slice().sort(compareScoreboardHandOrder);
  const banker = scoreboard.bankerSummary as Record<string, unknown>;
  const title = presentation.title?.trim() || `至尊牛牛 · 第 ${scoreboard.seqNo} 局成绩单`;
  const lines: string[] = [
    `🏆 <b>${escapeHtml(title)}</b>`,
    '━━━━━━━━━━━━━━━━━━',
  ];

  for (const player of players) {
    const result = outcomeDisplay(player.outcome);
    const shortfall = BigInt(String(player.shortfallCents ?? 0));
    const net = BigInt(String(player.netCents ?? 0));
    // 庄钱赔完后排在后面的赢家一分未得，仍算赢，附注「喝水」
    const shortfallText =
      player.outcome === 'PLAYER_WIN' && shortfall > 0n && net === 0n
        ? '（喝水 · 庄钱已赔完）'
        : shortfall > 0n
          ? `（免赔 ${fromCents(String(shortfall))}）`
          : '';
    const userId = typeof player.userId === 'string' ? player.userId : '';
    const playerNote = userId ? presentation.playerNotes?.[userId]?.trim() : '';
    lines.push(
      `${result.symbol} <b>${mention(player, presentation.playerAliases?.[userId])}</b> ·`,
      `抢 ${fromCents(String(player.claimCents))} · ${player.isAllIn ? '梭哈' : '下'} ${fromCents(String(player.betCents))} · ${result.label}→${absoluteAmount(player.netCents)}${shortfallText}`,
      cumulativeLine({
        beforeCents: player.balanceBeforeCents,
        afterCents: player.balanceAfterCents,
      }),
      ...(playerNote ? [`备注：${escapeHtml(playerNote)}`] : []),
      '',
    );
  }

  const bankerMention = mention(banker, presentation.bankerAlias);
  const bankerNet = BigInt(String(banker.netCents ?? 0));
  const bankerLabel = netLabel(bankerNet);
  const pairStats = bankerPairStats(banker, players);
  const bankerTrend = Array.isArray(banker.trend)
    ? banker.trend
        .filter((item): item is string | number => (
          typeof item === 'string' || typeof item === 'number'
        ))
        .map((item) => String(item).trim())
        .filter(Boolean)
        .map(escapeHtml)
    : [];
  lines.push(
    '━━━━━━━━━━━━━━━━━━',
    `${SCOREBOARD_EMOJI.banker} <b>庄家 ${bankerMention}</b> ·`,
    `抢 ${fromCents(String(banker.claimCents))} · ${bankerLabel}→${absoluteAmount(bankerNet)}`,
    `输 ${pairStats.lost} 家 · 赢 ${pairStats.won} 家 · 水 ${pairStats.tied} 家`,
    ...bankerFeeLines(banker),
    bankerProfitLine(bankerNet),
    `上庄积分：${fromCents(String(banker.balanceBeforeCents ?? 0))}`,
    `庄总积分：${fromCents(String(banker.balanceAfterCents ?? 0))}`,
    ...(presentation.bankerNote?.trim()
      ? [`备注：${escapeHtml(presentation.bankerNote.trim())}`]
      : []),
    ...(presentation.footer?.trim()
      ? ['', '━━━━━━━━━━━━━━━━━━', escapeHtml(presentation.footer.trim())]
      : []),
  );
  if (bankerTrend.length) {
    lines.push([
      '━━━━━━━━━━━━━━━━━━',
      '庄家走势',
      bankerTrend.join(' → '),
    ].join('\n'));
  }

  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (Buffer.byteLength(next, 'utf8') > 3900) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function scoreboardHtmlToText(value: string): string {
  return value
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

export function formatScoreboardPlainText(
  scoreboard: RoundScoreboard,
  presentation: ScoreboardPresentation = {},
): string[] {
  return formatScoreboard(scoreboard, presentation).map(scoreboardHtmlToText);
}
