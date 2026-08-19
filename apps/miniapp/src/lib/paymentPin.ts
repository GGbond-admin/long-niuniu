export type ApiSecurityError = Error & {
  code?: string;
  status?: number;
  details?: {
    remainingAttempts?: number;
    lockedUntil?: string;
  };
};

export function paymentPinErrorMessage(error: unknown): string {
  const issue = error as ApiSecurityError;
  const remaining = issue.details?.remainingAttempts;
  switch (issue.code ?? issue.message) {
    case 'PAYMENT_PIN_REQUIRED':
      return '请先设置支付密码';
    case 'PAYMENT_PIN_INVALID':
      return typeof remaining === 'number'
        ? `支付密码不正确，还可尝试 ${remaining} 次`
        : '支付密码不正确';
    case 'PAYMENT_PIN_LOCKED': {
      const lockedUntil = issue.details?.lockedUntil;
      return lockedUntil
        ? `支付密码已锁定，请在 ${new Date(lockedUntil).toLocaleTimeString('zh-MY', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
          })} 后重试`
        : '支付密码已锁定，请 15 分钟后重试';
    }
    case 'PAYMENT_PIN_FORMAT':
      return '请输入六位数字支付密码';
    case 'PAYMENT_PIN_TOO_WEAK':
      return '密码过于简单，请避免连续或重复数字';
    case 'PAYMENT_PIN_ALREADY_SET':
      return '支付密码已设置，请使用修改功能';
    case 'PAYMENT_PIN_UNCHANGED':
      return '新密码不能与当前支付密码相同';
    case 'PAYMENT_PIN_CHANGED':
      return '支付密码状态已更新，请重新输入后再试';
    default:
      return issue.message || '支付密码验证失败';
  }
}
