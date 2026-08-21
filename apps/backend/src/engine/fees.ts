/**
 * 庄家费用与红包总额 — 对应《06-公式与数值配置总表》第 5 节
 */

export interface FeeConfig {
  /** 上庄费比例（默认 1% = 0.01） */
  bankerSeatFeeRatio: number;
  /** 服务费：每场固定（分），默认 3800 = RM38 */
  serviceFeeCents: number;
  /** 红包人均单价（分），默认 104 = RM1.04 */
  packetPerHeadCents: number;
  /** 玩家（闲家）赢抽水比例（只抽赢方盈利），默认 3% */
  playerRakeRatio: number;
  /** 庄家盈利抽水比例：按本局对赌毛利抽取，亏损不抽，默认 5% */
  bankerRakeRatio: number;
  /**
   * @deprecated 旧版单一抽水比例。仅用于历史局配置快照兼容：
   * 快照里存在 rakeRatio 而缺少分侧比例时，两侧均按此值抽取。
   */
  rakeRatio?: number;
}

export const DEFAULT_FEE_CONFIG: FeeConfig = {
  bankerSeatFeeRatio: 0.01,
  serviceFeeCents: 3800,
  packetPerHeadCents: 104,
  playerRakeRatio: 0.03,
  bankerRakeRatio: 0.05,
};

/** 上庄费 = 庄钱 × 比例 */
export function bankerSeatFee(potCents: number, config: FeeConfig = DEFAULT_FEE_CONFIG): number {
  return Math.round(potCents * config.bankerSeatFeeRatio);
}

/** 竞标时需备足：庄钱 + 上庄费 + 服务费（代包费在锁定庄家后才按人数计） */
export function bankerBidReserveCents(
  bidCents: number,
  config: FeeConfig = DEFAULT_FEE_CONFIG,
): number {
  return bidCents + bankerSeatFee(bidCents, config) + config.serviceFeeCents;
}

/**
 * 当前余额最多能出的上庄整数金额（分）。
 * 需同时扣上庄费与服务费，故略低于账面可用余额。
 */
export function maxAffordableBankerBidCents(
  availableCents: number,
  config: FeeConfig = DEFAULT_FEE_CONFIG,
  roomMaxCents = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(availableCents) || availableCents < 100) return 0;
  const leftover = availableCents - config.serviceFeeCents;
  if (leftover < 100) return 0;
  const ratio = Math.max(0, config.bankerSeatFeeRatio);
  const roomMax = Math.floor(Math.max(0, roomMaxCents) / 100) * 100;
  let candidate = Math.min(Math.floor(leftover / (1 + ratio)), roomMax);
  candidate = Math.floor(candidate / 100) * 100;
  while (candidate >= 100) {
    if (bankerBidReserveCents(candidate, config) <= availableCents) return candidate;
    candidate -= 100;
  }
  return 0;
}

/** 红包总额 = 参与人数 × 人均单价（参与人数 = 庄家 + 已下注闲家） */
export function packetTotal(participantCount: number, config: FeeConfig = DEFAULT_FEE_CONFIG): number {
  return participantCount * config.packetPerHeadCents;
}

/** 代包费 = 本局红包总额 */
export function packetAgentFee(participantCount: number, config: FeeConfig = DEFAULT_FEE_CONFIG): number {
  return packetTotal(participantCount, config);
}

export interface BankerFees {
  seatFeeCents: number;
  serviceFeeCents: number;
  packetFeeCents: number;
  totalCents: number;
}

export function bankerFees(
  potCents: number,
  participantCount: number,
  config: FeeConfig = DEFAULT_FEE_CONFIG,
): BankerFees {
  const seatFeeCents = bankerSeatFee(potCents, config);
  const serviceFeeCents = config.serviceFeeCents;
  const packetFeeCents = packetAgentFee(participantCount, config);
  return {
    seatFeeCents,
    serviceFeeCents,
    packetFeeCents,
    totalCents: seatFeeCents + serviceFeeCents + packetFeeCents,
  };
}

export type RakeSide = 'PLAYER' | 'BANKER';

/** 分侧抽水比例：优先分侧配置，历史快照回退到旧版单一 rakeRatio */
export function rakeRatioFor(side: RakeSide, config: FeeConfig = DEFAULT_FEE_CONFIG): number {
  if (side === 'PLAYER') {
    return config.playerRakeRatio ?? config.rakeRatio ?? DEFAULT_FEE_CONFIG.playerRakeRatio;
  }
  return config.bankerRakeRatio ?? config.rakeRatio ?? DEFAULT_FEE_CONFIG.bankerRakeRatio;
}

/** 抽水：只抽赢方盈利。闲家按该笔实付；庄家按本局对赌毛利，亏损不抽。 */
export function rakeOf(
  profitCents: number,
  side: RakeSide,
  config: FeeConfig = DEFAULT_FEE_CONFIG,
): number {
  if (profitCents <= 0) return 0;
  return Math.round(profitCents * rakeRatioFor(side, config));
}
