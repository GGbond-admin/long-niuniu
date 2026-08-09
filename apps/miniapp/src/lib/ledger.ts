export const LEDGER_LABELS: Record<string, string> = {
  deposit: '充值到账',
  withdraw_freeze: '提现申请',
  withdraw_complete: '提现成功',
  withdraw_refund: '提现退回',
  rebate: '推广佣金',
  reward: '活动奖励',
  leaderboard_reward: '排行榜奖励',
  bet: '下注冻结',
  bet_adjust: '改注调整',
  bet_withdraw: '撤回下注',
  bid: '上庄冻结',
  settle_win: '对局赢取',
  settle_lose: '对局输掉',
  settle_bet_return: '下注本金退回',
  settle_tie_return: '平局退回',
  settle_banker_return: '庄池结余退回',
  rake: '平台抽水',
  fee_banker_seat: '上庄费',
  fee_service: '服务费',
  fee_packet_agent: '代包费',
  tip: '打赏客服',
  withdraw_fee: '提现手续费',
  group_packet_create: '发出群红包',
  group_packet_claim: '领取群红包',
  group_packet_refund: '群红包退回',
  packet_create: '对局红包发出',
  packet_claim: '对局红包核销',
  packet_return: '对局红包退回',
  cancelled_packet_claim: '取消局红包核销',
  round_cancel_refund: '取消局退款',
  claim_forfeit_refund: '弃权退款',
  adjust: '人工调账',
};

export type LedgerCategory =
  | 'all'
  | 'deposit'
  | 'withdraw'
  | 'rebate'
  | 'reward'
  | 'game'
  | 'fee'
  | 'packet'
  | 'refund'
  | 'adjust';

export const LEDGER_FILTERS: Array<{ key: LedgerCategory; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'deposit', label: '充值' },
  { key: 'withdraw', label: '提现' },
  { key: 'rebate', label: '佣金' },
  { key: 'reward', label: '奖励' },
  { key: 'game', label: '对局' },
  { key: 'fee', label: '费用' },
  { key: 'packet', label: '红包' },
  { key: 'refund', label: '退款' },
  { key: 'adjust', label: '调账' },
];

export function ledgerLabel(refType: string) {
  return LEDGER_LABELS[refType] ?? '其他资金变动';
}

export function formatLedgerAmount(
  direction: string,
  cents: string | number | bigint,
): string {
  const value = BigInt(cents);
  const amount = value < 0n ? -value : value;
  const formatted = `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;
  return `${direction === 'CREDIT' ? '+' : '-'}RM ${formatted}`;
}
