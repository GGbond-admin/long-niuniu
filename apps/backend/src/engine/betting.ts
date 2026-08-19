/**
 * 动态下注范围 — 对应《06-公式与数值配置总表》第 3 节
 * 普通下注上限 = 庄钱 × 0.5% × 人数系数，再受「余额 ÷ 本局最高倍数」约束（向下取整到完整 RM）。
 * 梭哈固定 1:1：最低额默认 RM20，最高额 = 玩家当前可承担余额（精确到分），不受房间庄钱上限限制。
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

export type BetAdjustmentReason = 'ROOM_LIMIT' | 'LIABILITY_LIMIT';

/** 梭哈固定 1:1 赔付（《普通下注与梭哈下注规则说明》二），不看牌型倍数。 */
export const ALL_IN_PAYOUT_MULTIPLIER = 1;

interface BetAcceptanceBase {
  requestedCents: bigint;
  liabilityBalanceCents: bigint;
  maxAffordableCents: bigint;
  roomMinCents: bigint;
  roomMaxCents: bigint;
  maxAcceptedCents: bigint;
  maxMultiplier: number;
  /** 本笔实际按几倍预留：普通=本局最高牌型倍数，梭哈=1 */
  liabilityMultiplier: number;
}

export type BetAcceptance =
  | (BetAcceptanceBase & {
      ok: true;
      acceptedCents: bigint;
      reservedCents: bigint;
      adjusted: boolean;
      adjustedBy: BetAdjustmentReason[];
    })
  | (BetAcceptanceBase & {
      ok: false;
      reason: 'BELOW_BET_MIN' | 'BELOW_SH_MIN' | 'MAX_LIABILITY_BELOW_MIN';
    });

/** 当前赔付余额在最高倍数下可支持的下注额；按需求向下取整至完整 RM。 */
export function maxAffordableBetCents(
  liabilityBalanceCents: bigint,
  maxMultiplier: number,
): bigint {
  if (liabilityBalanceCents < 0n) throw new Error('liabilityBalanceCents must be non-negative');
  if (!Number.isInteger(maxMultiplier) || maxMultiplier <= 0) {
    throw new Error('maxMultiplier must be a positive integer');
  }
  const wholeRm = liabilityBalanceCents / (BigInt(maxMultiplier) * 100n);
  return wholeRm * 100n;
}

/**
 * 计算最终接受下注：
 * - 低于玩法最低额仍拒绝；
 * - 普通下注高于房间上限或余额赔付能力时自动降额；
 * - 普通下注预留覆盖本局最高倍数的最坏损失；
 * - 梭哈固定 1:1，只受余额限制，预留 = 注额本身，可精确到分押上全部余额。
 */
export function acceptBetAmount(params: {
  requestedCents: bigint;
  liabilityBalanceCents: bigint;
  maxMultiplier: number;
  isAllIn: boolean;
  range: BettingRange;
}): BetAcceptance {
  const roomMinCents = BigInt(params.isAllIn ? params.range.shMinCents : params.range.betMinCents);
  const roomMaxCents = params.isAllIn
    ? params.liabilityBalanceCents
    : BigInt(params.range.betMaxCents);
  const liabilityMultiplier = params.isAllIn ? ALL_IN_PAYOUT_MULTIPLIER : params.maxMultiplier;
  const maxAffordableCents = params.isAllIn
    ? params.liabilityBalanceCents
    : maxAffordableBetCents(params.liabilityBalanceCents, params.maxMultiplier);
  const maxAcceptedCents =
    maxAffordableCents < roomMaxCents ? maxAffordableCents : roomMaxCents;
  const base: BetAcceptanceBase = {
    requestedCents: params.requestedCents,
    liabilityBalanceCents: params.liabilityBalanceCents,
    maxAffordableCents,
    roomMinCents,
    roomMaxCents,
    maxAcceptedCents,
    maxMultiplier: params.maxMultiplier,
    liabilityMultiplier,
  };

  if (params.requestedCents < roomMinCents) {
    return {
      ...base,
      ok: false,
      reason: params.isAllIn ? 'BELOW_SH_MIN' : 'BELOW_BET_MIN',
    };
  }
  if (maxAcceptedCents < roomMinCents) {
    return { ...base, ok: false, reason: 'MAX_LIABILITY_BELOW_MIN' };
  }

  const acceptedCents =
    params.requestedCents < maxAcceptedCents ? params.requestedCents : maxAcceptedCents;
  const adjustedBy: BetAdjustmentReason[] = [];
  if (!params.isAllIn && params.requestedCents > roomMaxCents) adjustedBy.push('ROOM_LIMIT');
  if (params.requestedCents > maxAffordableCents) adjustedBy.push('LIABILITY_LIMIT');

  return {
    ...base,
    ok: true,
    acceptedCents,
    reservedCents: acceptedCents * BigInt(liabilityMultiplier),
    adjusted: acceptedCents !== params.requestedCents,
    adjustedBy,
  };
}

export function bettingRange(
  potCents: number,
  playerCount: number,
  config: BettingConfig = DEFAULT_BETTING_CONFIG,
): BettingRange {
  const coef = playerCoef(playerCount, config);
  const betMax = Math.floor(potCents * config.betRatio * coef);
  return {
    betMinCents: config.betMinCents,
    betMaxCents: Math.max(betMax, config.betMinCents),
    shMinCents: config.shMinCents,
    // 兼容旧字段：梭哈不再按庄钱封顶，展示/接受均以玩家余额为准
    shMaxCents: 0,
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

/** PostgreSQL BIGINT 正数上限；所有持久化金额必须在此范围内。 */
export const MAX_MONEY_CENTS = 9_223_372_036_854_775_807n;

/** 从十进制字符串精确解析金额，避免先经过 Number 导致大额舍入。 */
export function toCentsBigInt(amount: string): bigint {
  const normalized = amount.trim();
  // 先限长再构造 BigInt，避免超长 REST/WS 输入放大 CPU 消耗。
  if (normalized.length > 32) throw new Error('AMOUNT_TOO_LARGE');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) throw new Error('INVALID_AMOUNT');
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const cents = BigInt(match[1]) * 100n + BigInt(fraction || '0');
  if (cents > MAX_MONEY_CENTS) throw new Error('AMOUNT_TOO_LARGE');
  return cents;
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
