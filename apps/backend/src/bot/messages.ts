import type { RoundScoreboard } from '@prisma/client';
import { fromCents } from '../engine/betting.js';
import { HAND_LABEL, type HandType } from '../engine/hand.js';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function mention(line: Record<string, unknown>): string {
  const username = line.tgUsername;
  if (typeof username === 'string' && username) return `@${escapeHtml(username)}`;
  return escapeHtml(line.nickname || `UID ${line.uid}`);
}

function handLabel(type: unknown, points: unknown): string {
  if (type === 'NORMAL') return `${points}点`;
  return HAND_LABEL[type as HandType] ?? String(type);
}

function signedMoney(value: string | number | bigint): string {
  const amount = BigInt(value);
  return `${amount >= 0n ? '+' : '-'}RM ${fromCents(amount >= 0n ? amount : -amount)}`;
}

export function formatScoreboard(scoreboard: RoundScoreboard): string[] {
  const players = scoreboard.playerLines as Array<Record<string, unknown>>;
  const banker = scoreboard.bankerSummary as Record<string, unknown>;
  const stats = banker.stats as Record<string, number>;
  const fees = banker.fees as Record<string, number>;
  const lines: string[] = [
    `🏆 <b>至尊牛牛 · 第 ${scoreboard.seqNo} 局成绩单</b>`,
    '━━━━━━━━━━━━━━━━━━',
  ];

  for (const player of players) {
    const multiplier = Number(player.multiplier ?? 0);
    const outcome =
      player.outcome === 'PLAYER_WIN'
        ? `赢 ${signedMoney(String(player.netCents))}`
        : player.outcome === 'BANKER_WIN'
          ? `输 ${signedMoney(String(player.netCents))}${multiplier > 1 ? `（庄家牌型 ×${multiplier}）` : ''}`
          : '平';
    lines.push(
      `${player.isBust ? '💥 ' : ''}<b>${mention(player)}</b> · RM ${fromCents(String(player.claimCents))} · ${player.isAllIn ? '梭哈' : '下注'} RM ${fromCents(String(player.betCents))}`,
      `${handLabel(player.handType, player.points)} → ${outcome}${BigInt(String(player.shortfallCents)) > 0n ? `（免赔 RM ${fromCents(String(player.shortfallCents))}）` : ''}`,
      `积分：RM ${fromCents(String(player.balanceBeforeCents))} → RM ${fromCents(String(player.balanceAfterCents))}`,
      '',
    );
  }

  const bankerMention = mention(banker);
  const bankerNet = BigInt(String(banker.netCents));
  const bankerGross = BigInt(String(banker.grossCents ?? banker.netCents));
  const balanceBefore = BigInt(String(banker.balanceBeforeCents ?? 0));
  const balanceAfter = BigInt(String(banker.balanceAfterCents ?? balanceBefore + bankerNet));
  const trend = Array.isArray(banker.trend) ? banker.trend.map(String).join(' → ') : '—';
  lines.push(
    '━━━━━━━━━━━━━━━━━━',
    `🎲 <b>庄家 ${bankerMention}</b> · RM ${fromCents(String(banker.claimCents))}`,
    `${banker.isBust ? '💥 ' : ''}${handLabel(banker.handType, banker.points)}`,
    `闲家统计：赢 ${stats?.playerWin ?? 0} / 输 ${stats?.playerLose ?? 0} / 平 ${stats?.tie ?? 0}`,
    `庄家盈利 ${signedMoney(bankerGross)}（已扣抽水）`,
    `上庄费 -RM ${fromCents(fees?.seatFeeCents ?? 0)} · 服务费 -RM ${fromCents(fees?.serviceFeeCents ?? 0)} · 代包费 -RM ${fromCents(fees?.packetFeeCents ?? 0)}`,
    `庄家实际盈利 ${signedMoney(bankerNet)}`,
    `上庄积分 RM ${fromCents(balanceBefore)} · 盈利 ${signedMoney(bankerNet)} · 庄总积分 RM ${fromCents(balanceAfter)}`,
    `累计做庄盈亏：${signedMoney(String(banker.totalProfitCents))}`,
    `走势：${escapeHtml(trend)}`,
  );

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
