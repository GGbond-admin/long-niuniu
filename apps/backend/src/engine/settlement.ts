/**
 * 单局结算引擎 — 对应《06-公式与数值配置总表》第 6 节
 *
 * 规则（已与产品确认）：
 * - 自爆：普通牌型点数 ≤3 直接判输；庄闲双自爆 → 庄赢
 * - 同级比金额，金额相同平局（该对退回，不抽水）
 * - 抽水 5% 只抽赢方盈利；与庄家三费并存
 * - 闲赢从庄池支付，庄池不足按上限赔付（免赔部分记 shortfall）
 */

import {
  CompareResult,
  DEFAULT_HAND_CONFIG,
  HandConfig,
  HandResult,
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
  /** 闲赢：理论应付 */
  payableCents: number;
  /** 闲赢：实付（庄池上限内） */
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
  const pairs: PairSettlement[] = [];

  for (const p of params.players) {
    const playerHand = evaluateHand(p.claimCents);
    const playerBust = isBust(playerHand, handConfig);

    let outcome: PairSettlement['outcome'];
    if (playerBust && bankerBust) {
      outcome = 'BANKER_WIN'; // 双自爆 → 庄赢（已确认）
    } else if (playerBust) {
      outcome = 'BANKER_WIN';
    } else if (bankerBust) {
      outcome = 'PLAYER_WIN';
    } else {
      const cmp = compareHands(bankerHand, playerHand);
      outcome =
        cmp === CompareResult.TIE ? 'TIE' : cmp === CompareResult.PLAYER_WIN ? 'PLAYER_WIN' : 'BANKER_WIN';
    }

    const base: Omit<
      PairSettlement,
      'outcome' | 'multiplier' | 'payableCents' | 'paidCents' | 'shortfallCents' | 'rakeCents' | 'playerNetCents' | 'bankerNetCents'
    > = {
      userId: p.userId,
      betCents: p.betCents,
      playerHand,
      bankerHand,
      isBustPlayer: playerBust,
      isBustBanker: bankerBust,
    };

    if (outcome === 'TIE') {
      stats.tie++;
      pairs.push({
        ...base,
        outcome,
        multiplier: 0,
        payableCents: 0,
        paidCents: 0,
        shortfallCents: 0,
        rakeCents: 0,
        playerNetCents: 0,
        bankerNetCents: 0,
      });
      continue;
    }

    if (outcome === 'PLAYER_WIN') {
      stats.playerWin++;
      const multiplier = multiplierOf(playerHand, handConfig);
      const payable = multiplier * p.betCents;
      const paid = Math.min(payable, potRemaining);
      const shortfall = payable - paid;
      const rake = rakeOf(paid, feeConfig);
      potRemaining -= paid;
      bankerGross -= paid;
      totalRake += rake;
      pairs.push({
        ...base,
        outcome,
        multiplier,
        payableCents: payable,
        paidCents: paid,
        shortfallCents: shortfall,
        rakeCents: rake,
        playerNetCents: paid - rake,
        bankerNetCents: -paid,
      });
      continue;
    }

    // BANKER_WIN
    stats.playerLose++;
    const rake = rakeOf(p.betCents, feeConfig);
    bankerGross += p.betCents - rake;
    totalRake += rake;
    pairs.push({
      ...base,
      outcome,
      multiplier: 0,
      payableCents: 0,
      paidCents: 0,
      shortfallCents: 0,
      rakeCents: rake,
      playerNetCents: -p.betCents,
      bankerNetCents: p.betCents - rake,
    });
  }

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
