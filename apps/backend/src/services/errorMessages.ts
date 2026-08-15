import type { GameError } from './game.js';

/**
 * 玩家可见错误的统一中文文案。
 * HTTP 响应（server.ts setErrorHandler）与聊天指令（chatCommands.ts）共用，
 * 避免英文错误码直接上屏。
 */

function formatRangeAmount(value: unknown): string | null {
  if (typeof value === 'bigint') return `RM ${(Number(value) / 100).toFixed(2)}`;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return `RM ${(Number(value) / 100).toFixed(2)}`;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return `RM ${(value / 100).toFixed(2)}`;
}

const GAME_ERROR_AMOUNT_KEY: Record<string, string> = {
  BELOW_BET_MIN: 'betMinCents',
  ABOVE_BET_MAX: 'betMaxCents',
  BELOW_SH_MIN: 'shMinCents',
  ABOVE_SH_MAX: 'shMaxCents',
  MAX_LIABILITY_BELOW_MIN: 'maxAcceptedCents',
};

const GAME_ERROR_MESSAGES: Record<string, string> = {
  // 阶段与状态
  INVALID_PHASE: '当前阶段不可操作，请点刷新同步状态',
  PHASE_ENDED: '本阶段倒计时已结束，请等待下一阶段',
  ROUND_NOT_FOUND: '当前牌局不存在，请刷新状态',
  ROUND_SETTLING: '牌局正在结算中，请稍候',
  ROUND_NOT_FINISHED: '牌局尚未结束',
  ROUND_NOT_CANCELLED: '牌局未处于取消状态',
  ROUND_INCOMPLETE: '牌局信息不完整，请联系客服',
  ROOM_NOT_FOUND: '房间不存在或已关闭',
  ROOM_PAUSED: '房间已暂停，请稍后再试',
  ROOM_BANNED: '您已被移出该房间，如有疑问请联系客服',
  NOT_ENOUGH_PLAYERS: '人数不足，无法开局',
  GAME_NOT_SUPPORTED: '该游戏暂未开放',
  // 金额
  INVALID_AMOUNT: '金额无效，请重新输入',
  AMOUNT_TOO_LARGE: '金额过大，请重新输入',
  INSUFFICIENT_BALANCE: '可用余额不足',
  BID_OUT_OF_RANGE: '竞标金额超出范围',
  BET_OUT_OF_RANGE: '下注金额超出范围',
  BELOW_BET_MIN: '低于最低下注金额',
  ABOVE_BET_MAX: '超过最高下注金额',
  BELOW_SH_MIN: '低于最低梭哈金额',
  ABOVE_SH_MAX: '超过最高梭哈金额',
  MAX_LIABILITY_BELOW_MIN: '余额不足以承担最低下注的最大赔付，当前最高可下注',
  // 下注与庄家
  BANKER_CANNOT_BET: '庄家不能下注',
  BET_NOT_EDITABLE: '当前下注已锁定，无法修改',
  NO_ACTIVE_BET: '当前没有可撤回的下注',
  NOT_ROUND_BANKER: '只有本局庄家可以执行此操作',
  BANKER_NOT_SET: '本局庄家尚未确定',
  BANKER_NOT_FOUND: '庄家信息异常，请联系客服',
  BANKER_DICE_NOT_READY: '庄家尚未完成投骰',
  BANKER_CANNOT_FORFEIT: '庄家不能放弃领取',
  BANKER_CLAIM_MISSING: '庄家认领记录缺失，请联系客服',
  PLAYER_CLAIMS_MISSING: '仍有玩家未完成认领',
  // 红包
  PACKET_NOT_FOUND: '红包不存在或已失效',
  PACKET_EXPIRED: '红包已过期',
  PACKET_EMPTY: '红包已被领完',
  PACKET_NOT_SENT: '红包尚未发出',
  PACKET_NOT_INTERNAL: '该红包不支持站内领取',
  PACKET_URL_MISSING: '红包链接缺失，请联系客服',
  PACKET_TOTAL_EXCEEDED: '领取总额超过红包金额，请联系客服',
  PACKET_RETURN_OUT_OF_RANGE: '回收金额超出范围',
  PACKET_RECONCILIATION_OUT_OF_RANGE: '对账金额超出范围',
  ALREADY_CLAIMED: '您已领取过该红包',
  NOT_ELIGIBLE_TO_CLAIM: '您不符合本局领取条件',
  CLAIM_ALREADY_RECORDED: '认领已记录，无需重复提交',
  CLAIM_NOT_FOUND: '认领记录不存在',
  CLAIM_NOT_EDITABLE: '该认领记录已锁定，无法修改',
  TNG_NAME_MISMATCH: 'TNG 姓名与实名不一致，请核对后重试',
  TNG_ACCOUNT_UNAVAILABLE: '收款账户暂不可用，请稍后重试',
  TNG_ACCOUNT_LIMIT_EXCEEDED: '收款账户今日额度已满，请稍后重试',
  MATCH_OVERRIDE_REASON_REQUIRED: '请填写强制匹配原因',
  CORRECTION_REASON_REQUIRED: '请填写更正原因（至少 4 字）',
  // 准入
  KYC_REQUIRED: '请先完成实名认证',
  NOT_IN_ROOM: '您已不在互动群内，请点右上角刷新重新进入',
  USER_NOT_ACTIVE: '账号状态异常，请联系客服',
  WALLET_NOT_FOUND: '钱包状态异常，请联系客服',
  VIRTUAL_DISABLED: '该账号已停用',
  VIRTUAL_WRONG_ROOM: '该账号不属于当前房间',
  VIRTUAL_CAPABILITY_DENIED: '该账号无此操作权限',
  ROUND_CONFIG_SNAPSHOT_MISSING: '牌局配置缺失，请联系客服',
};

export function gameErrorMessage(error: GameError): string {
  const base = GAME_ERROR_MESSAGES[error.code] ?? '操作失败，请稍后重试';
  const rangeKey = GAME_ERROR_AMOUNT_KEY[error.code];
  if (rangeKey) {
    const amount = formatRangeAmount(error.details?.[rangeKey]);
    if (amount) return `${base} ${amount}`;
  }
  return base;
}

const WALLET_ERROR_MESSAGES: Record<string, string> = {
  INSUFFICIENT_BALANCE: '可用余额不足',
  WALLET_NOT_FOUND: '钱包状态异常，请联系客服',
  INVALID_AMOUNT: '金额无效，请重新输入',
  IDEMPOTENCY_CONFLICT: '该请求已提交过，请勿重复操作',
  USER_REQUIRED: '账户信息缺失，请重新登录',
};

export function walletErrorMessage(code: string): string {
  return WALLET_ERROR_MESSAGES[code] ?? '操作失败，请稍后重试';
}

const PAYMENT_PIN_MESSAGES: Record<string, string> = {
  PAYMENT_PIN_REQUIRED: '请先设置支付密码',
  PAYMENT_PIN_NOT_SET: '请先设置支付密码',
  PAYMENT_PIN_INVALID: '支付密码不正确',
  PAYMENT_PIN_LOCKED: '支付密码已锁定，请稍后再试',
  PAYMENT_PIN_WEAK: '支付密码过于简单，请勿使用连续或相同数字',
};

export function paymentPinMessage(code: string): string {
  return PAYMENT_PIN_MESSAGES[code] ?? '支付密码校验失败，请重试';
}

const CANCEL_REASON_MESSAGES: Record<string, string> = {
  NO_VALID_BANKER_BID: '本局无有效竞标，自动流局',
  NOT_ENOUGH_PLAYERS: '人数不足，自动流局',
};

/** 取消原因：内部码映射为中文；运营填写的自由文本原样透出。 */
export function cancelReasonText(reason: string | null | undefined): string {
  if (!reason) return '运营取消';
  return CANCEL_REASON_MESSAGES[reason] ?? reason;
}
