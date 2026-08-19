/**
 * 单局结算引擎 — 对应《06-公式与数值配置总表》第 6 节
 *
 * 规则（已与产品确认）：
 * - 免死：抢到 0.01 的一方本对判和，退回本金、不赔不赚、不抽水
 * - 自爆：普通牌型点数 ≤3 直接判输；庄闲双自爆 → 庄赢
 * - 同级比金额，金额相同平局（该对退回，不抽水）
 * - 输方按赢方牌型倍数赔付（金牛 11 倍、对子 12 倍……普通按点数倍数）
 * - 梭哈单固定 1:1：赢只拿注额、输只赔注额，牌型倍数只用于胜负判定与赔付排序
 * - 抽水只抽赢方盈利：玩家赢默认 3%、庄家赢默认 5%（可配置）；与庄家三费并存
 * - 闲赢从庄池支付，庄池不足按赔付顺序逐个赔到庄钱归零（见 comparePayoutPriority），
 *   赔到一半的那位拿走剩余庄钱，其后的赢家「喝水」（paid=0，全额记 shortfall）
 * - 庄赢从下注时冻结的最大赔付预留金收取；旧单预留不足时才防御性记 shortfall
 */

import {
  CompareResult,
  DEFAULT_HAND_CONFIG,
  HAND_LABEL,
  HAND_RANK,
  HandConfig,
  HandResult,
  HandType,
  compareHands,
  evaluateHand,
  isBust,
  multiplierOf,
} from './hand.js';
import { BankerFees, DEFAULT_FEE_CONFIG, FeeConfig, bankerFees, rakeOf } from './fees.js';
import { ALL_IN_PAYOUT_MULTIPLIER } from './betting.js';

export interface PlayerInput {
  userId: string;
  betCents: number;
  claimCents: number; // 抢到的红包金额（分）
  /** 下注时已冻结的最大赔付预留金（分）；旧单缺省时按本金处理 */
  reservedCents?: number;
  /** 下注时间（毫秒）：庄钱不足时同倍数、同点数、同红包金额者按此先后赔付 */
  betPlacedAtMs?: number;
  /** 梭哈单：赔付固定 1:1，不按牌型倍数 */
  isAllIn?: boolean;
}

export interface PairSettlement {
  userId: string;
  betCents: number;
  playerHand: HandResult;
  bankerHand: HandResult;
  outcome: 'PLAYER_WIN' | 'BANKER_WIN' | 'TIE';
  isBustPlayer: boolean;
  isBustBanker: boolean;
  /** 本对是否梭哈单 */
  isAllIn: boolean;
  /** 实际赔付倍数：普通=赢方牌型倍数，梭哈=1 */
  multiplier: number;
  /** 赢方牌型倍数（梭哈也保留，用于赔付排序与展示） */
  handMultiplier: number;
  /** 输方理论应付（赔付倍数 × 注额） */
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
  isAllIn: boolean;
  multiplier: number;
  handMultiplier: number;
  payableCents: number;
}

/** 净变动为零时统一记 +0，避免 -0 流入成绩单与账目核对 */
function zeroSafe(value: number): number {
  return value === 0 ? 0 : value;
}

function asHandType(value: unknown): HandType {
  return Object.values(HandType).includes(value as HandType)
    ? (value as HandType)
    : HandType.NORMAL;
}

/**
 * 成绩单展示用：按玩家自己的牌型等级从高到低，同级再比点数/红包金额。
 * 与赔付顺序（comparePayoutPriority）同一口径，避免「排前面却没拿到钱」的观感。
 */
export function compareScoreboardHandOrder(
  a: { handType?: unknown; points?: unknown; claimCents?: unknown },
  b: { handType?: unknown; points?: unknown; claimCents?: unknown },
  _config: HandConfig = DEFAULT_HAND_CONFIG,
): number {
  const aHand = {
    type: asHandType(a.handType),
    points: Number(a.points ?? 0),
    amountCents: Number(a.claimCents ?? 0),
  };
  const bHand = {
    type: asHandType(b.handType),
    points: Number(b.points ?? 0),
    amountCents: Number(b.claimCents ?? 0),
  };
  if (aHand.type !== bHand.type) return HAND_RANK[bHand.type] - HAND_RANK[aHand.type];
  if (aHand.points !== bHand.points) return bHand.points - aHand.points;
  if (aHand.amountCents !== bHand.amountCents) return bHand.amountCents - aHand.amountCents;
  return 0;
}

/** 从一局不可变成绩单中还原该局庄家的走势标签。 */
export function bankerTrendLabelFromSummary(summary: unknown): string | null {
  if (!summary || typeof summary !== 'object') return null;
  const snapshot = summary as { handType?: unknown; points?: unknown };
  if (
    typeof snapshot.handType !== 'string'
    || !Object.values(HandType).includes(snapshot.handType as HandType)
  ) {
    return null;
  }
  const handType = snapshot.handType as HandType;
  if (handType !== HandType.NORMAL) return HAND_LABEL[handType];
  if (typeof snapshot.points !== 'number' && typeof snapshot.points !== 'string') return null;
  const points = Number(snapshot.points);
  return Number.isInteger(points) && points >= 1 && points <= 10 ? `${points}点` : null;
}

/** 单个庄家在单个房间内的走势；调用方只传入该庄家自己的历史。 */
export function continueBankerTrend(
  previousTrend: unknown,
  bankerLabel: string,
  trendLength: number,
): string[] {
  const previous = Array.isArray(previousTrend)
    ? previousTrend.map((item) => String(item)).filter(Boolean)
    : [];
  const limit = Number.isInteger(trendLength) && trendLength > 0 ? trendLength : 10;
  return [...previous, bankerLabel].slice(-limit);
}

/**
 * 庄钱不足时的赔付顺序（《普通下注与梭哈下注规则说明》三）：
 * 牌型等级高 → 点数大 → 红包金额大 → 下注时间早；全部相同则按入参顺序，保证结果可复现。
 * 按牌型等级而非后台倍数排序，改倍数不会改变赔付先后。
 * 梭哈与普通单同队排序，按各自牌型比较，不因 1:1 赔付而降级。
 */
function comparePayoutPriority(a: PairDraft, b: PairDraft): number {
  if (a.playerHand.type !== b.playerHand.type) {
    return HAND_RANK[b.playerHand.type] - HAND_RANK[a.playerHand.type];
  }
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
  /** 已创建红包的实际总额；有人弃权时仍保持原代包费不变。 */
  packetFeeCents?: number;
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

    const isAllIn = input.isAllIn === true;
    const handMultiplier =
      outcome === 'TIE'
        ? 0
        : multiplierOf(outcome === 'PLAYER_WIN' ? playerHand : bankerHand, handConfig);
    // 梭哈固定 1:1；牌型倍数仅留作赔付排序与成绩单展示
    const multiplier =
      outcome === 'TIE' ? 0 : isAllIn ? ALL_IN_PAYOUT_MULTIPLIER : handMultiplier;
    return {
      index,
      input,
      playerHand,
      isBustPlayer,
      outcome,
      isAllIn,
      multiplier,
      handMultiplier,
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

  // 第三步：成绩单按玩家自己的牌型倍数从大到小展示（赔付顺序已在上一步处理）
  const pairs: PairSettlement[] = drafts
    .map((draft) => {
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
        isAllIn: draft.isAllIn,
        multiplier: draft.multiplier,
        handMultiplier: draft.handMultiplier,
        payableCents: draft.payableCents,
        paidCents,
        shortfallCents: draft.payableCents - paidCents,
        rakeCents,
        playerNetCents: zeroSafe(isPlayerWin ? paidCents - rakeCents : -paidCents),
        bankerNetCents: zeroSafe(isPlayerWin ? -paidCents : paidCents - rakeCents),
      };
    })
    .sort((left, right) =>
      compareScoreboardHandOrder(
        {
          handType: left.playerHand.type,
          points: left.playerHand.points,
          claimCents: left.playerHand.amountCents,
        },
        {
          handType: right.playerHand.type,
          points: right.playerHand.points,
          claimCents: right.playerHand.amountCents,
        },
        handConfig,
      ),
    );

  const participantCount = params.participantCount ?? params.players.length + 1;
  const calculatedFees = bankerFees(params.potCents, participantCount, feeConfig);
  const fees =
    params.packetFeeCents === undefined
      ? calculatedFees
      : {
          ...calculatedFees,
          packetFeeCents: params.packetFeeCents,
          totalCents:
            calculatedFees.seatFeeCents
            + calculatedFees.serviceFeeCents
            + params.packetFeeCents,
        };
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
