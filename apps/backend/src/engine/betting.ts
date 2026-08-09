/**
 * 动态下注/梭哈范围 — 对应《06-公式与数值配置总表》第 3 节
 * 下注上限 = 庄钱 × 0.5% × 人数系数；梭哈上限 = 庄钱 × 5% × 人数系数
 */

export interface BettingConfig {
  betMinCents: number;      // 默认 200 (RM2)
  shMinCents: number;       // 默认 2000 (RM20)
  betRatio: number;         // 默认 0.005
  shRatio: number;          // 默认 0.05
  /** 人数系数分档：按 maxPlayers 升序匹配第一个满足 players <= maxPlayers 的档位 */
  playerCoefTiers: Array<{ maxPlayers: number; coef: number }>;
}

export const DEFAULT_BETTING_CONFIG: BettingConfig = {
  betMinCents: 200,
  shMinCents: 2000,
  betRatio: 0.005,
  shRatio: 0.05,
  playerCoefTiers: [
    { maxPlayers: 9, coef: 2.0 },
    { maxPlayers: 20, coef: 1.5 },
    { maxPlayers: 9999, coef: 1.0 },
  ],
};

export function playerCoef(playerCount: number, config: BettingConfig = DEFAULT_BETTING_CONFIG): number {
  for (const tier of config.playerCoefTiers) {
    if (playerCount <= tier.maxPlayers) return tier.coef;
  }
  return 1.0;
}

export interface BettingRange {
  betMinCents: number;
  betMaxCents: number;
  shMinCents: number;
  shMaxCents: number;
}

export function bettingRange(
  potCents: number,
  playerCount: number,
  config: BettingConfig = DEFAULT_BETTING_CONFIG,
): BettingRange {
  const coef = playerCoef(playerCount, config);
  const betMax = Math.floor(potCents * config.betRatio * coef);
  const shMax = Math.floor(potCents * config.shRatio * coef);
  return {
    betMinCents: config.betMinCents,
    betMaxCents: Math.max(betMax, config.betMinCents),
    shMinCents: config.shMinCents,
    shMaxCents: Math.max(shMax, config.shMinCents),
  };
}

/** 校验一笔下注是否合法（普通/梭哈） */
export function validateBet(
  amountCents: number,
  isAllIn: boolean,
  range: BettingRange,
): { ok: boolean; reason?: string } {
  if (isAllIn) {
    if (amountCents < range.shMinCents) return { ok: false, reason: 'BELOW_SH_MIN' };
    if (amountCents > range.shMaxCents) return { ok: false, reason: 'ABOVE_SH_MAX' };
  } else {
    if (amountCents < range.betMinCents) return { ok: false, reason: 'BELOW_BET_MIN' };
    if (amountCents > range.betMaxCents) return { ok: false, reason: 'ABOVE_BET_MAX' };
  }
  return { ok: true };
}

/**
 * 解析下注指令文本（网页房输入 / 历史兼容）：
 * - 纯数字 → 普通下注（支持小数两位）
 * - "sh金额" → 梭哈
 * - "0" → 撤回
 */
export type BetCommand =
  | { kind: 'BET'; amountCents: number }
  | { kind: 'ALL_IN'; amountCents: number }
  | { kind: 'WITHDRAW' }
  | { kind: 'IGNORE' };

export function parseBetMessage(text: string): BetCommand {
  const t = text.trim();
  if (t === '0') return { kind: 'WITHDRAW' };
  const shMatch = /^(?:sh|SH|Sh|sH)\s*(\d+(?:\.\d{1,2})?)$/.exec(t);
  if (shMatch) {
    return { kind: 'ALL_IN', amountCents: toCents(shMatch[1]) };
  }
  if (/^\d+(?:\.\d{1,2})?$/.test(t)) {
    return { kind: 'BET', amountCents: toCents(t) };
  }
  return { kind: 'IGNORE' };
}

export function toCents(amount: string | number): number {
  const s = String(amount);
  const [int, dec = ''] = s.split('.');
  const d2 = (dec + '00').slice(0, 2);
  return parseInt(int, 10) * 100 + parseInt(d2, 10);
}

export function fromCents(cents: string | number | bigint): string {
  const n =
    typeof cents === 'bigint'
      ? cents
      : typeof cents === 'number'
        ? BigInt(Math.round(cents))
        : BigInt(cents);
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}
