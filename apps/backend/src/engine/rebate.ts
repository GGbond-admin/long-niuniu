/**
 * 推广返水 — 对应《06-公式与数值配置总表》第 7 节
 * 佣金 = 自身有效下注×0.7% + 直属×0.5% + 二级×0.3%
 */

export interface RebateConfig {
  selfRate: number; // 0.007
  l1Rate: number;   // 0.005
  l2Rate: number;   // 0.003
  /** 平局注码是否计入有效下注（默认不计） */
  includeTieBets: boolean;
}

export const DEFAULT_REBATE_CONFIG: RebateConfig = {
  selfRate: 0.007,
  l1Rate: 0.005,
  l2Rate: 0.003,
  includeTieBets: false,
};

export interface DailyTurnover {
  selfCents: number;
  l1Cents: number;
  l2Cents: number;
}

export function dailyCommission(
  t: DailyTurnover,
  config: RebateConfig = DEFAULT_REBATE_CONFIG,
): number {
  return (
    Math.round(t.selfCents * config.selfRate) +
    Math.round(t.l1Cents * config.l1Rate) +
    Math.round(t.l2Cents * config.l2Rate)
  );
}

/**
 * 庄家有效下注 = 本局对赌结算的闲家下注总额（不按庄钱，输赢均计）
 * 闲家有效下注 = 参与结算的自身下注（输赢均计；平局按配置）
 */
export function effectiveTurnoverForBanker(
  settledBets: Array<{ betCents: number; outcome: 'PLAYER_WIN' | 'BANKER_WIN' | 'TIE' }>,
  config: RebateConfig = DEFAULT_REBATE_CONFIG,
): number {
  return settledBets.reduce((sum, b) => {
    if (b.outcome === 'TIE' && !config.includeTieBets) return sum;
    return sum + b.betCents;
  }, 0);
}

export function effectiveTurnoverForPlayer(
  betCents: number,
  outcome: 'PLAYER_WIN' | 'BANKER_WIN' | 'TIE',
  config: RebateConfig = DEFAULT_REBATE_CONFIG,
): number {
  if (outcome === 'TIE' && !config.includeTieBets) return 0;
  return betCents;
}
