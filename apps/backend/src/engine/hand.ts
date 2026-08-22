/**
 * 牌型与点数引擎 — 对应《06-公式与数值配置总表》第 1、2 节
 * 金额以「分」(cents) 传入，展示金额 = cents / 100，固定两位小数。
 */

export enum HandType {
  BAOZI = 'BAOZI',       // 豹子
  MANNIU = 'MANNIU',     // 满牛
  FANSHUN = 'FANSHUN',   // 反顺（倒顺）
  SHUNZI = 'SHUNZI',     // 顺子
  DUIZI = 'DUIZI',       // 对子
  JINNIU = 'JINNIU',     // 金牛
  NIUNIU = 'NIUNIU',     // 牛牛（三位相加刚好等于 10）
  MIANSI = 'MIANSI',     // 免死（固定 0.01，判和不赔不赚）
  NORMAL = 'NORMAL',     // 普通
}

/** 免死判定金额：RM0.01（分） */
export const MIANSI_AMOUNT_CENTS = 1;

/** 牛牛判定：三位关键数字之和 */
export const NIUNIU_DIGIT_SUM = 10;

/** 牌型等级，数值越大越强（免死不参与比牌，等级仅作占位） */
export const HAND_RANK: Record<HandType, number> = {
  [HandType.BAOZI]: 8,
  [HandType.MANNIU]: 7,
  [HandType.SHUNZI]: 6,
  [HandType.FANSHUN]: 5,
  [HandType.DUIZI]: 4,
  [HandType.JINNIU]: 3,
  [HandType.NIUNIU]: 2,
  [HandType.NORMAL]: 1,
  [HandType.MIANSI]: 0,
};

export const HAND_LABEL: Record<HandType, string> = {
  [HandType.BAOZI]: '豹子',
  [HandType.MANNIU]: '满牛',
  [HandType.FANSHUN]: '反顺',
  [HandType.SHUNZI]: '顺子',
  [HandType.DUIZI]: '对子',
  [HandType.JINNIU]: '金牛',
  [HandType.NIUNIU]: '牛牛',
  [HandType.MIANSI]: '免死',
  [HandType.NORMAL]: '普通',
};

export interface HandResult {
  type: HandType;
  /** 点数 0–10：三位数字之和为 10 记 10 点（牛牛）；其余取个位，个位 0 记 0 点 */
  points: number;
  /** 三位关键数字 [整数位个位, 小数第一位, 小数第二位] */
  digits: [number, number, number];
  amountCents: number;
}

export interface HandConfig {
  /** 牌型倍数（普通牌型用 normalMultipliers） */
  multipliers: Record<HandType, number>;
  /** 普通牌型 0–10 点各自倍数 */
  normalMultipliers: Record<number, number>;
  /** 自爆总开关。关闭后不再按点数判自爆，只走正常比牌。 */
  bustEnabled: boolean;
  /** 自爆阈值：点数 <= bustThreshold 判自爆（默认 3）；仅普通牌型参与自爆 */
  bustThreshold: number;
}

export const DEFAULT_HAND_CONFIG: HandConfig = {
  multipliers: {
    [HandType.BAOZI]: 17,
    [HandType.MANNIU]: 15,
    [HandType.FANSHUN]: 14,
    [HandType.SHUNZI]: 13,
    [HandType.DUIZI]: 12,
    [HandType.JINNIU]: 11,
    [HandType.NIUNIU]: 10,
    [HandType.MIANSI]: 1, // 占位，免死判和不参与赔付
    [HandType.NORMAL]: 1, // 占位，普通用 normalMultipliers
  },
  normalMultipliers: { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 2, 9: 3, 10: 4 },
  bustEnabled: true,
  bustThreshold: 3,
};

/**
 * 本局可能出现的最高赔付倍数。
 * 风控必须读取局配置快照，而不能假定后台永远保持默认 17 倍。
 * 免死固定判和、NORMAL 的特殊牌型占位值均不参与；普通牌使用点数倍数表。
 */
export function maxPayoutMultiplier(config: HandConfig = DEFAULT_HAND_CONFIG): number {
  const special = Object.entries(config.multipliers)
    .filter(([type]) => type !== HandType.MIANSI && type !== HandType.NORMAL)
    .map(([, multiplier]) => multiplier);
  const candidates = [...special, ...Object.values(config.normalMultipliers)].filter(
    (multiplier) => Number.isInteger(multiplier) && multiplier > 0,
  );
  return candidates.length > 0 ? Math.max(...candidates) : 1;
}

/** 金额（分）→ 三位关键数字之和的点数：和为 10 记 10 点，其余取个位（含 0 点） */
export function pointsOf(amountCents: number): number {
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new Error(`invalid amountCents: ${amountCents}`);
  }
  const [a, b, c] = keyDigits(amountCents);
  const sum = a + b + c;
  if (sum === NIUNIU_DIGIT_SUM) return 10;
  return sum % 10;
}

/** 取三位关键数字 [a,b,c]：a=整数位个位，b、c=小数两位 */
export function keyDigits(amountCents: number): [number, number, number] {
  const c = amountCents % 10;
  const b = Math.floor(amountCents / 10) % 10;
  const a = Math.floor(amountCents / 100) % 10;
  return [a, b, c];
}

/** 判定牌型（优先级由高到低） */
export function handTypeOf(amountCents: number): HandType {
  // 免死：抢到 RM0.01 判和，不再按其他牌型判定
  if (amountCents === MIANSI_AMOUNT_CENTS) return HandType.MIANSI;

  const [a, b, c] = keyDigits(amountCents);

  // 豹子：三位非零相同
  if (a !== 0 && a === b && b === c) return HandType.BAOZI;
  // 满牛：整数金额（小数两位均为 0）
  if (b === 0 && c === 0 && amountCents >= 100) return HandType.MANNIU;
  // 反顺（倒顺）：连续递减，最大 9.87；0.98 按规则列为倒顺
  if ((b === a - 1 && c === b - 1) || (a === 0 && b === 9 && c === 8)) return HandType.FANSHUN;
  // 顺子：连续递增（0 可作起点）
  if (b === a + 1 && c === b + 1) return HandType.SHUNZI;
  // 对子：末两位相同且非零
  if (b === c && b !== 0) return HandType.DUIZI;
  // 金牛：0.X0（首位与末位为 0，中间 1–9）
  if (a === 0 && c === 0 && b >= 1) return HandType.JINNIU;
  // 牛牛：三位相加刚好等于 10，兜底于其他特别牌型之后
  if (a + b + c === NIUNIU_DIGIT_SUM) return HandType.NIUNIU;
  return HandType.NORMAL;
}

export function evaluateHand(amountCents: number): HandResult {
  return {
    type: handTypeOf(amountCents),
    points: pointsOf(amountCents),
    digits: keyDigits(amountCents),
    amountCents,
  };
}

/**
 * 是否自爆：仅普通牌型且点数 ≤ 阈值。
 * 后台可关闭自爆；关闭后一律按正常比牌。
 * 特殊牌型（豹子/满牛/顺子/倒顺/对子/金牛/牛牛）与免死一律不自爆——规则固定写死，
 * 不受门槛配置影响，防止误配导致特殊牌型被判输。
 */
export function isBust(hand: HandResult, config: HandConfig = DEFAULT_HAND_CONFIG): boolean {
  if (config.bustEnabled === false) return false;
  if (hand.type !== HandType.NORMAL) return false;
  return hand.points <= config.bustThreshold;
}

/** 该手牌的赔付倍数 */
export function multiplierOf(hand: HandResult, config: HandConfig = DEFAULT_HAND_CONFIG): number {
  if (hand.type === HandType.NORMAL) {
    return config.normalMultipliers[hand.points] ?? 1;
  }
  return config.multipliers[hand.type];
}

export enum CompareResult {
  BANKER_WIN = 'BANKER_WIN',
  PLAYER_WIN = 'PLAYER_WIN',
  TIE = 'TIE',
}

/**
 * 同级比较键：[主键, 次键]，越大越强。
 * - 普通：先比点数（牛牛/10点 > 9…>1 > 0），同点再比金额
 * - 豹子 / 满牛 / 顺子 / 倒顺 / 牛牛：比整笔金额
 * - 对子：先比后两位（99>…>11），后两位相同再比前一位
 * - 金牛：只比中间位（前后不算）
 */
export function sameTypeStrength(hand: HandResult): [number, number] {
  switch (hand.type) {
    case HandType.DUIZI:
      return [hand.amountCents % 100, hand.digits[0]];
    case HandType.JINNIU:
      return [hand.digits[1], 0];
    case HandType.NORMAL:
      return [hand.points, hand.amountCents];
    default:
      return [hand.amountCents, 0];
  }
}

/** 正数表示 a 更强，负数表示 b 更强，0 表示同级比较键相同。 */
export function compareHandStrength(a: HandResult, b: HandResult): number {
  const rankDiff = HAND_RANK[a.type] - HAND_RANK[b.type];
  if (rankDiff !== 0) return rankDiff;
  const [aPrimary, aSecondary] = sameTypeStrength(a);
  const [bPrimary, bSecondary] = sameTypeStrength(b);
  if (aPrimary !== bPrimary) return aPrimary - bPrimary;
  if (aSecondary !== bSecondary) return aSecondary - bSecondary;
  return 0;
}

/**
 * 比牌（不含自爆逻辑，自爆在结算层先行判定）：
 * 1) 比牌型等级；2) 同级按该牌型规则比较；3) 比较键相同再比整笔金额；4) 完全相同 → 庄赢。
 * 免死（0.01）在结算层单独判和，本函数不会收到免死牌。
 */
export function compareHands(banker: HandResult, player: HandResult): CompareResult {
  const diff = compareHandStrength(banker, player);
  if (diff > 0) return CompareResult.BANKER_WIN;
  if (diff < 0) return CompareResult.PLAYER_WIN;
  if (banker.amountCents !== player.amountCents) {
    return banker.amountCents > player.amountCents
      ? CompareResult.BANKER_WIN
      : CompareResult.PLAYER_WIN;
  }
  return CompareResult.BANKER_WIN; // 完全相同 → 庄赢
}
