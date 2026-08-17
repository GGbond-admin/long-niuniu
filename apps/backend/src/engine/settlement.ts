/**
 * 单局结算引擎 — 对应《06-公式与数值配置总表》第 6 节
 *
 * 规则（已与产品确认）：
 * - 免死：抢到 0.01 的一方本对判和，退回本金、不赔不赚、不抽水
 * - 自爆：普通牌型点数 ≤3 直接判输；庄闲双自爆 → 庄赢
 * - 同级比金额，金额相同平局（该对退回，不抽水）
 * - 输方按赢方牌型倍数赔付（金牛 11 倍、对子 12 倍……普通按点数倍数）
 * - 抽水只抽赢方盈利：玩家赢默认 3%、庄家赢默认 5%（可配置）；与庄家三费并存
 * - 闲赢从庄池支付，庄池不足按赔付顺序逐个赔到庄钱归零（见 comparePayoutPriority），
 *   赔到一半的那位拿走剩余庄钱，其后的赢家「喝水」（paid=0，全额记 shortfall）
 * - 庄赢从下注时冻结的最大赔付预留金收取；旧单预留不足时才防御性记 shortfall
 */

import {
  CompareResult,
  DEFAULT_HAND_CONFIG,
  HandConfig,
  HandResult,
  HandType,
  compareHands,
  evaluateHand,
  isBust,
  multiplierOf,
} from './hand.js';
import { BankerFees, DEFAULT_FEE_CONFIG, FeeConfig, bankerFees, rakeOf } from './fees.js';

export interface PlayerInput {
  userId: string;
  betCents: number;
  claimCents: number; // 抢到的红包金额（分）
  /** 下注时已冻结的最大赔付预留金（分）；旧单缺省时按本金处理 */
  reservedCents?: number;
  /** 下注时间（毫秒）：庄钱不足时同倍数、同点数、同红包金额者按此先后赔付 */
  betPlacedAtMs?: number;
}

export interface PairSettlement {
  userId: string;
  betCents: number;
  playerHand: HandResult;
  bankerHand: HandResult;
  outcome: 'PLAYER_WIN' | 'BANKER_WIN' | 'TIE';
  isBustPlayer: boolean;
  isBustBanker: boolean;
  multiplier: number;
  /** 输方理论应付（赢方倍数 × 注额） */
  payableCents: number;
  /** 实际支付（闲赢受庄池上限、庄赢受预留金上限） */
  paidCents: number;
  /** 免赔 */
  shortfallCents: number;
  /** 该笔抽水（赢方支付） */
  rakeCents: number;
  /** 闲家净变动（正=赚，负=亏；不含退回本金逻辑，本金另行解冻） */
  playerNetCents: number;
  /** 庄家该笔净变动 */
  bankerNetCents: number;
}

export interface RoundSettlementResult {
  bankerUserId: string;
  bankerHand: HandResult;
  pairs: PairSettlement[];
  /** 庄家盈亏（未扣费用） */
  bankerGrossCents: number;
  /** 三项费用 */
  fees: BankerFees;
  /** 庄家净结果 = 盈亏 − 费用 */
  bankerNetCents: number;
  /** 平台抽水合计 */
  totalRakeCents: number;
  /** 结束时庄池剩余（赔付后，未含费用扣除） */
  potRemainingCents: number;
  /** 统计：输/赢/平 家数（以闲家视角） */
  stats: { playerWin: number; playerLose: number; tie: number };
}

/** 判定完成、尚未分配庄钱的中间态 */
interface PairDraft {
  index: number;
  input: PlayerInput;
  playerHand: HandResult;
  isBustPlayer: boolean;
  outcome: PairSettlement['outcome'];
  multiplier: number;
  payableCents: number;
}

/** 净变动为零时统一记 +0，避免 -0 流入成绩单与账目核对 */
function zeroSafe(value: number): number {
  return value === 0 ? 0 : value;
}

/**
 * 庄钱不足时的赔付顺序（《红包牛牛｜下注与庄家赔付规则》三）：
 * 倍数高 → 点数大 → 红包金额大 → 下注时间早；全部相同则按入参顺序，保证结果可复现。
 */
function comparePayoutPriority(a: PairDraft, b: PairDraft): number {
  if (a.multiplier !== b.multiplier) return b.multiplier - a.multiplier;
  if (a.playerHand.points !== b.playerHand.points) return b.playerHand.points - a.playerHand.points;
  if (a.input.claimCents !== b.input.claimCents) return b.input.claimCents - a.input.claimCents;
  const aPlacedAt = a.input.betPlacedAtMs ?? Number.MAX_SAFE_INTEGER;
  const bPlacedAt = b.input.betPlacedAtMs ?? Number.MAX_SAFE_INTEGER;
  if (aPlacedAt !== bPlacedAt) return aPlacedAt - bPlacedAt;
  return a.index - b.index;
}

export function settleRound(params: {
  bankerUserId: string;
  bankerClaimCents: number;
  potCents: number;
  players: PlayerInput[];
  participantCount?: number; // 默认 = 闲家数 + 1
  handConfig?: HandConfig;
  feeConfig?: FeeConfig;
}): RoundSettlementResult {
  const handConfig = params.handConfig ?? DEFAULT_HAND_CONFIG;
  const feeConfig = params.feeConfig ?? DEFAULT_FEE_CONFIG;
  const bankerHand = evaluateHand(params.bankerClaimCents);
  const bankerBust = isBust(bankerHand, handConfig);

  let potRemaining = params.potCents;
  let bankerGross = 0;
  let totalRake = 0;
  const stats = { playerWin: 0, playerLose: 0, tie: 0 };

  // 第一步：逐对判定胜负与应付金额，此时不动庄钱
  const drafts: PairDraft[] = params.players.map((input, index) => {
    const playerHand = evaluateHand(input.claimCents);
    const isBustPlayer = isBust(playerHand, handConfig);

    let outcome: PairSettlement['outcome'];
    if (bankerHand.type === HandType.MIANSI || playerHand.type === HandType.MIANSI) {
      outcome = 'TIE'; // 免死（0.01）：本对判和，退回本金不赔付
    } else if (isBustPlayer && bankerBust) {
      outcome = 'BANKER_WIN'; // 双自爆 → 庄赢（已确认）
    } else if (isBustPlayer) {
      outcome = 'BANKER_WIN';
    } else if (bankerBust) {
      outcome = 'PLAYER_WIN';
    } else {
      const cmp = compareHands(bankerHand, playerHand);
      outcome =
        cmp === CompareResult.TIE ? 'TIE' : cmp === CompareResult.PLAYER_WIN ? 'PLAYER_WIN' : 'BANKER_WIN';
    }

    if (outcome === 'TIE') stats.tie++;
    else if (outcome === 'PLAYER_WIN') stats.playerWin++;
    else stats.playerLose++;

    const multiplier =
      outcome === 'TIE'
        ? 0
        : multiplierOf(outcome === 'PLAYER_WIN' ? playerHand : bankerHand, handConfig);
    return {
      index,
      input,
      playerHand,
      isBustPlayer,
      outcome,
      multiplier,
      payableCents: multiplier * input.betCents,
    };
  });

  // 第二步：闲家赢按赔付顺序从庄钱扣款，庄钱归零后其余赢家喝水
  const payments = new Map<number, { paidCents: number; rakeCents: number }>();
  for (const draft of drafts.filter((item) => item.outcome === 'PLAYER_WIN').sort(comparePayoutPriority)) {
    const paidCents = Math.min(draft.payableCents, potRemaining);
    const rakeCents = rakeOf(paidCents, 'PLAYER', feeConfig);
    potRemaining -= paidCents;
    bankerGross -= paidCents;
    totalRake += rakeCents;
    payments.set(draft.index, { paidCents, rakeCents });
  }

  // 庄家赢从各自的最大赔付预留金收取，互不影响，无需排序
  for (const draft of drafts) {
    if (draft.outcome !== 'BANKER_WIN') continue;
    const capacity = Math.max(draft.input.betCents, draft.input.reservedCents ?? draft.input.betCents);
    const paidCents = Math.min(draft.payableCents, capacity);
    const rakeCents = rakeOf(paidCents, 'BANKER', feeConfig);
    bankerGross += paidCents - rakeCents;
    totalRake += rakeCents;
    payments.set(draft.index, { paidCents, rakeCents });
  }

  // 第三步：按入参顺序组装成绩单，避免结算顺序影响展示
  const pairs: PairSettlement[] = drafts.map((draft) => {
    const { paidCents, rakeCents } = payments.get(draft.index) ?? { paidCents: 0, rakeCents: 0 };
    const isPlayerWin = draft.outcome === 'PLAYER_WIN';
    return {
      userId: draft.input.userId,
      betCents: draft.input.betCents,
      playerHand: draft.playerHand,
      bankerHand,
      outcome: draft.outcome,
      isBustPlayer: draft.isBustPlayer,
      isBustBanker: bankerBust,
      multiplier: draft.multiplier,
      payableCents: draft.payableCents,
      paidCents,
      shortfallCents: draft.payableCents - paidCents,
      rakeCents,
      playerNetCents: zeroSafe(isPlayerWin ? paidCents - rakeCents : -paidCents),
      bankerNetCents: zeroSafe(isPlayerWin ? -paidCents : paidCents - rakeCents),
    };
  });

  const participantCount = params.participantCount ?? params.players.length + 1;
  const fees = bankerFees(params.potCents, participantCount, feeConfig);
  const bankerNet = bankerGross - fees.totalCents;

  return {
    bankerUserId: params.bankerUserId,
    bankerHand,
    pairs,
    bankerGrossCents: bankerGross,
    fees,
    bankerNetCents: bankerNet,
    totalRakeCents: totalRake,
    potRemainingCents: potRemaining,
    stats,
  };
}
