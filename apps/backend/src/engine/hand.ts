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
  [HandType.FANSHUN]: 6,
  [HandType.SHUNZI]: 5,
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
  /** 点数 1–10（10 = 最大点数；「牛牛」是独立牌型，见 HandType.NIUNIU） */
  points: number;
  /** 三位关键数字 [整数位个位, 小数第一位, 小数第二位] */
  digits: [number, number, number];
  amountCents: number;
}

export interface HandConfig {
  /** 牌型倍数（普通牌型用 normalMultipliers） */
  multipliers: Record<HandType, number>;
  /** 普通牌型 1–10 点各自倍数 */
  normalMultipliers: Record<number, number>;
  /** 自爆阈值：点数 <= bustThreshold 判自爆（默认 3） */
  bustThreshold: number;
  /** 特殊牌型是否豁免自爆（默认 true） */
  bustExemptSpecialHands: boolean;
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
  normalMultipliers: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 2, 9: 3, 10: 4 },
  bustThreshold: 3,
  bustExemptSpecialHands: true,
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

/** 金额（分）→ 所有数字之和的点数：个位为 0 记 10 点 */
export function pointsOf(amountCents: number): number {
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new Error(`invalid amountCents: ${amountCents}`);
  }
  let sum = 0;
  let n = amountCents; // cents 的十进制数字 == 金额全部数字（两位小数）
  if (n === 0) return 10;
  while (n > 0) {
    sum += n % 10;
    n = Math.floor(n / 10);
  }
  const unit = sum % 10;
  return unit === 0 ? 10 : unit;
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
  // 反顺（倒顺）：连续递减；0.98 为规则钦定特例
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

/** 是否自爆：普通牌型且点数 ≤ 阈值（特殊牌型默认豁免；免死永不自爆） */
export function isBust(hand: HandResult, config: HandConfig = DEFAULT_HAND_CONFIG): boolean {
  if (hand.type === HandType.MIANSI) return false;
  if (hand.type !== HandType.NORMAL && config.bustExemptSpecialHands) return false;
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
 * 比牌（不含自爆逻辑，自爆在结算层先行判定）：
 * 1) 比牌型等级；2) 同级比金额；3) 金额相同 → 平局
 */
export function compareHands(banker: HandResult, player: HandResult): CompareResult {
  const br = HAND_RANK[banker.type];
  const pr = HAND_RANK[player.type];
  if (br !== pr) return br > pr ? CompareResult.BANKER_WIN : CompareResult.PLAYER_WIN;
  if (banker.amountCents !== player.amountCents) {
    return banker.amountCents > player.amountCents
      ? CompareResult.BANKER_WIN
      : CompareResult.PLAYER_WIN;
  }
  return CompareResult.TIE;
}
