import { describe, expect, it } from 'vitest';
import {
  amountToCents,
  buildSign,
  buildSignSource,
  centsToAmount,
  formatDt,
  mapOrderState,
  md5Upper,
  parseSign,
  verifyNotifySign,
} from './vpay.js';

const API_TOKEN = 'demo-trader-token';

describe('VPay 签名算法', () => {
  it('按 ASCII 升序拼接非空参数，并排除 sign', () => {
    expect(
      buildSignSource({
        title: 'This is Demo',
        amount: '100',
        name: 'XXX XX XXXX',
        trader_id: '123456',
        sign: 'should-be-ignored',
        payer_name: '',
        notify_url: undefined,
      }),
    ).toBe('amount=100&name=XXX XX XXXX&title=This is Demo&trader_id=123456');
  });

  it('文档示例的 Unix 时间戳按 +8 区格式化为 2025-12-12 12:12:12', () => {
    expect(formatDt(1765512732, 480)).toBe('2025-12-12 12:12:12');
  });

  it('时区偏移不同会得到不同的 dt，从而改变签名', () => {
    const params = { action: 'TRADER_ORDER', trader_id: '123456' };
    const kl = buildSign(params, {
      apiToken: API_TOKEN,
      unixSeconds: 1765512732,
      timezoneOffsetMinutes: 480,
    });
    const utc = buildSign(params, {
      apiToken: API_TOKEN,
      unixSeconds: 1765512732,
      timezoneOffsetMinutes: 0,
    });
    expect(kl).not.toBe(utc);
    expect(parseSign(kl)?.dt).toBe('2025-12-12 12:12:12');
    expect(parseSign(utc)?.dt).toBe('2025-12-12 04:12:12');
  });

  it('sign 为 Base64(token=…&dt=…&ap=MD5大写)', () => {
    const params = { action: 'TRADER_ORDER', amount: '100.00', trader_id: '123456' };
    const sign = buildSign(params, {
      apiToken: API_TOKEN,
      unixSeconds: 1765512732,
      timezoneOffsetMinutes: 480,
    });
    expect(Buffer.from(sign, 'base64').toString('utf8')).toBe(
      `token=${API_TOKEN}&dt=2025-12-12 12:12:12&ap=${md5Upper(buildSignSource(params))}`,
    );
  });
});

describe('VPay 回调验签', () => {
  const notify = {
    trader_id: '123456',
    trade_no: '20251212121212123',
    out_trade_no: 'ckdeposit0001',
    state: '3',
    amount: '100.00',
    title: 'Deposit',
    notify_time: '2025-12-12 12:12:12',
  };
  const sign = buildSign(notify, {
    apiToken: API_TOKEN,
    unixSeconds: 1765512732,
    timezoneOffsetMinutes: 480,
  });

  it('接受平台下发的合法签名', () => {
    expect(verifyNotifySign(notify, sign, API_TOKEN)).toBe(true);
  });

  it('不依赖本地时区推测 dt，回调可用任意时间戳签发', () => {
    const signedElsewhere = buildSign(notify, {
      apiToken: API_TOKEN,
      unixSeconds: 1765512732,
      timezoneOffsetMinutes: -300,
    });
    expect(verifyNotifySign(notify, signedElsewhere, API_TOKEN)).toBe(true);
  });

  it('篡改金额后验签失败', () => {
    expect(verifyNotifySign({ ...notify, amount: '9999.00' }, sign, API_TOKEN)).toBe(false);
  });

  it('新增扩展字段会改变摘要（需平台重新签名）', () => {
    expect(verifyNotifySign({ ...notify, extra_field: 'x' }, sign, API_TOKEN)).toBe(false);
  });

  it('密钥不符时拒绝', () => {
    expect(verifyNotifySign(notify, sign, 'another-token')).toBe(false);
  });

  it('空签名或非 Base64 均拒绝', () => {
    expect(verifyNotifySign(notify, '', API_TOKEN)).toBe(false);
    expect(verifyNotifySign(notify, 'not-a-valid-sign!!', API_TOKEN)).toBe(false);
  });
});

describe('VPay 金额与状态换算', () => {
  it('分与 RM 字符串互转', () => {
    expect(centsToAmount(10_000n)).toBe('100.00');
    expect(centsToAmount(12_345n)).toBe('123.45');
    expect(centsToAmount(5n)).toBe('0.05');
    expect(amountToCents('100')).toBe(10_000n);
    expect(amountToCents('100.5')).toBe(10_050n);
    expect(amountToCents('123.45')).toBe(12_345n);
  });

  it('拒绝非法金额格式', () => {
    expect(amountToCents('')).toBeNull();
    expect(amountToCents('abc')).toBeNull();
    expect(amountToCents('100.456')).toBeNull();
    expect(amountToCents('-100')).toBeNull();
  });

  it('网关状态映射到工单状态', () => {
    expect(mapOrderState('3')).toBe('COMPLETED');
    expect(mapOrderState(1)).toBe('REJECTED');
    expect(mapOrderState(4)).toBe('REJECTED');
    expect(mapOrderState(2)).toBe('PENDING');
    expect(mapOrderState(5)).toBe('PENDING');
    expect(mapOrderState('x')).toBe('UNKNOWN');
  });
});
