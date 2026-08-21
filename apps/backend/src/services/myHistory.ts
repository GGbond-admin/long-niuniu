import { HAND_LABEL, type HandType } from '../engine/hand.js';

/** 我的战绩单次最多返回的局数 */
export const MY_HISTORY_MAX_ROUNDS = 200;

export type MyHistoryItem = {
  roundId: string;
  seqNo: number;
  finishedAt: string | null;
  role: 'BANKER' | 'PLAYER';
  netCents: string;
  handType: string | null;
  handLabel: string | null;
  points: number | null;
  betCents: string | null;
  claimCents: string | null;
  isAllIn: boolean;
  multiplier: number | null;
  shortfallCents: string | null;
  bankerNickname: string | null;
  bankerUid: string | null;
};

export type MyHistorySummary = {
  rounds: number;
  wins: number;
  losses: number;
  ties: number;
  bankerRounds: number;
  netCents: string;
};

export type MyHistoryRound = {
  id: string;
  seqNo: number;
  finishedAt: Date | null;
  bankerId: string | null;
  scoreboard: { playerLines: unknown; bankerSummary: unknown } | null;
};

export function safeCentsString(value: unknown): string {
  try {
    return String(BigInt(String(value ?? 0)));
  } catch {
    return '0';
  }
}

export function handLabelOf(type: unknown): string | null {
  if (typeof type !== 'string' || !type) return null;
  return HAND_LABEL[type as HandType] ?? type;
}

/** 从结算成绩单中提取指定用户视角的单局战绩；未参与结算（撤注/取消局）返回 null。 */
export function buildMyHistoryItem(
  round: MyHistoryRound,
  userId: string,
): MyHistoryItem | null {
  const scoreboard = round.scoreboard;
  if (!scoreboard) return null;
  const banker =
    scoreboard.bankerSummary && typeof scoreboard.bankerSummary === 'object'
      ? (scoreboard.bankerSummary as Record<string, unknown>)
      : null;
  const base = {
    roundId: round.id,
    seqNo: round.seqNo,
    finishedAt: round.finishedAt?.toISOString() ?? null,
    bankerNickname: banker ? String(banker.nickname ?? '') || null : null,
    bankerUid: banker ? String(banker.uid ?? '') || null : null,
  };
  if (round.bankerId === userId && banker) {
    return {
      ...base,
      role: 'BANKER',
      netCents: safeCentsString(banker.netCents),
      handType: typeof banker.handType === 'string' ? banker.handType : null,
      handLabel: handLabelOf(banker.handType),
      points: Number.isFinite(Number(banker.points)) ? Number(banker.points) : null,
      betCents: null,
      claimCents: safeCentsString(banker.claimCents),
      isAllIn: false,
      multiplier: null,
      shortfallCents: null,
    };
  }
  const lines = Array.isArray(scoreboard.playerLines) ? scoreboard.playerLines : [];
  for (const raw of lines) {
    const line = (raw ?? {}) as Record<string, unknown>;
    if (String(line.userId ?? '') !== userId) continue;
    return {
      ...base,
      role: 'PLAYER',
      netCents: safeCentsString(line.netCents),
      handType: typeof line.handType === 'string' ? line.handType : null,
      handLabel: handLabelOf(line.handType),
      points: Number.isFinite(Number(line.points)) ? Number(line.points) : null,
      betCents: safeCentsString(line.betCents),
      claimCents: safeCentsString(line.claimCents),
      isAllIn: Boolean(line.isAllIn),
      multiplier: Number.isFinite(Number(line.multiplier)) ? Number(line.multiplier) : null,
      shortfallCents: safeCentsString(line.shortfallCents),
    };
  }
  return null;
}

export function summarizeMyHistory(items: MyHistoryItem[]): MyHistorySummary {
  let netCents = 0n;
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let bankerRounds = 0;
  for (const item of items) {
    const net = BigInt(item.netCents);
    netCents += net;
    if (net > 0n) wins += 1;
    else if (net < 0n) losses += 1;
    else ties += 1;
    if (item.role === 'BANKER') bankerRounds += 1;
  }
  return {
    rounds: items.length,
    wins,
    losses,
    ties,
    bankerRounds,
    netCents: String(netCents),
  };
}
