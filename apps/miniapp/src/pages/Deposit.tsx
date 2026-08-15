import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { IconSupport } from '../components/Icons';
import { completeRequest, pendingRequestId } from '../lib/idempotency';
import { backToTab } from '../lib/nav';
import { openExternalLink } from '../telegram';

const PRESET_AMOUNTS = ['100', '200', '500', '1000', '2000', '5000'];
const MANUAL_MIN_AMOUNT = 100;

type Payee = {
  id: string;
  bankName: string;
  accountNo: string;
  accountName: string;
  label?: string | null;
};

type Channels = {
  vpay: {
    available: boolean;
    minCents: string;
    maxCents: string;
    tradeCodes: Array<{ code: string; label: string }>;
  };
};

type VpayOrder = {
  id: string;
  payUrl: string | null;
  status: string;
  rejectReason?: string | null;
};

function formatMoney(amount: string) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  return n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function Deposit({
  kycStatus,
  ownerUid,
}: {
  kycStatus: string;
  ownerUid: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [amount, setAmount] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [payee, setPayee] = useState<Payee | null>(null);
  const [proof, setProof] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [channels, setChannels] = useState<Channels | null>(null);
  const [method, setMethod] = useState<'VPAY' | 'MANUAL'>('MANUAL');
  const [tradeCode, setTradeCode] = useState('');
  const [vpayOrder, setVpayOrder] = useState<VpayOrder | null>(null);

  useEffect(() => {
    if (kycStatus === 'NONE' || kycStatus === 'REJECTED') {
      navigate('/kyc', { replace: true });
      return;
    }
    if (kycStatus === 'PENDING') {
      setError('实名认证审核中，通过后即可充值。');
    }
  }, [kycStatus, navigate]);

  useEffect(() => {
    if (kycStatus !== 'APPROVED') return;
    let cancelled = false;
    api
      .depositChannels()
      .then((result) => {
        if (cancelled) return;
        setChannels(result);
        if (result.vpay.available && result.vpay.tradeCodes.length > 0) {
          setMethod('VPAY');
          setTradeCode(result.vpay.tradeCodes[0].code);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [kycStatus]);

  const vpayAvailable = channels?.vpay.available === true;
  const useVpay = method === 'VPAY' && vpayAvailable;
  const minAmount = useVpay
    ? Number(channels?.vpay.minCents ?? '10000') / 100
    : MANUAL_MIN_AMOUNT;
  const maxAmount = useVpay ? Number(channels?.vpay.maxCents ?? '0') / 100 : 0;

  const amountValue = Number(amount);
  const amountOk =
    Number.isFinite(amountValue) &&
    amountValue >= minAmount &&
    (maxAmount <= 0 || amountValue <= maxAmount) &&
    /^\d+(\.\d{1,2})?$/.test(amount);
  const approved = kycStatus === 'APPROVED';

  const refreshVpayStatus = useCallback(async (orderId: string) => {
    const result = await api.depositStatus(orderId);
    setVpayOrder((current) =>
      current && current.id === orderId
        ? { ...current, status: result.status, rejectReason: result.rejectReason }
        : current,
    );
    return result.status;
  }, []);

  // 支付页在外部打开，回到小程序后靠轮询确认到账
  useEffect(() => {
    if (!vpayOrder || vpayOrder.status !== 'PENDING') return;
    const orderId = vpayOrder.id;
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (cancelled) return;
      void refreshVpayStatus(orderId).catch(() => undefined);
    }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [vpayOrder, refreshVpayStatus]);

  function pickAmount(value: string) {
    setSelected(value);
    setAmount(value);
    setError('');
  }

  function onCustomAmount(value: string) {
    const next = value.replace(/[^\d.]/g, '');
    setAmount(next);
    setSelected(PRESET_AMOUNTS.includes(next) ? next : null);
    setError('');
  }

  async function goPayeeStep() {
    if (!approved) return;
    if (!amountOk) {
      setError(`最低充值 RM${minAmount}`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await api.depositPayee();
      setPayee(result.payee);
      setStep(2);
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      setError(
        code === 'NO_DEPOSIT_PAYEE'
          ? '暂无可用收款账户，请联系客服'
          : `加载收款账户失败：${(err as Error).message}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function startVpay() {
    if (!approved || !amountOk || !tradeCode) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const requestKey = `deposit-vpay:${tradeCode}:${amount}`;
      const requestId = pendingRequestId(requestKey, ownerUid);
      const result = await api.depositVpay(amount, tradeCode, requestId);
      completeRequest(requestKey, requestId, ownerUid);
      setVpayOrder({ id: result.orderId, payUrl: result.payUrl, status: result.status });
      if (result.payUrl) openExternalLink(result.payUrl);
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      const messages: Record<string, string> = {
        VPAY_UNAVAILABLE: '快捷充值暂未开放，请改用银行转账或联系客服。',
        TRADE_CODE_UNAVAILABLE: '该支付方式已关闭，请选择其他方式。',
        AMOUNT_BELOW_MIN: `低于快捷充值最低金额 RM${minAmount}`,
        AMOUNT_ABOVE_MAX: `超过快捷充值最高金额 RM${maxAmount}`,
        VPAY_ORDER_FAILED: '支付通道暂时无法下单，请稍后重试或改用银行转账。',
        IDEMPOTENCY_CONFLICT: '订单信息已变化，请返回重新选择金额。',
      };
      setError(messages[code ?? ''] ?? `下单失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function copyText(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value.replace(/\s/g, ''));
      setCopied(label);
      window.setTimeout(() => setCopied(''), 1500);
    } catch {
      setCopied('');
    }
  }

  async function submit() {
    if (!approved || !amountOk || !proof || !payee) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const requestKey = `deposit:${payee.id}:${amount}`;
      const requestId = pendingRequestId(requestKey, ownerUid);
      const proofUrl = (await api.uploadProof(proof)).url;
      await api.deposit(amount, proofUrl, requestId, payee.id);
      completeRequest(requestKey, requestId, ownerUid);
      setMessage('充值申请已提交，客服核对无误后将自动到账。');
      setProof(null);
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      setError(
        code === 'IDEMPOTENCY_CONFLICT'
          ? '本次充值资料已改变，请返回后重新选择金额和收款账户。'
          : `提交失败：${(err as Error).message}`,
      );
    } finally {
      setBusy(false);
    }
  }

  function resetVpay() {
    setVpayOrder(null);
    setError('');
    setMessage('');
  }

  const title = vpayOrder
    ? '完成支付'
    : step === 1
      ? '充值'
      : step === 2
        ? '转账到此账户'
        : '上传转账凭证';

  return (
    <div className="page subpage deposit-page">
      <header className="subpage-header">
        <button
          type="button"
          onClick={() => {
            if (vpayOrder) {
              resetVpay();
              return;
            }
            if (step === 3) {
              setStep(2);
              setMessage('');
              setError('');
              return;
            }
            if (step === 2) {
              setStep(1);
              setError('');
              return;
            }
            backToTab(navigate, location, 'wallet');
          }}
          aria-label="返回"
        >
          ‹
        </button>
        <div>
          <h1>{title}</h1>
        </div>
        <span />
      </header>

      {vpayOrder && (
        <section className="deposit-paying">
          <div className="deposit-transfer-amount">
            <small>支付金额</small>
            <strong>RM {formatMoney(amount)}</strong>
          </div>

          {vpayOrder.status === 'PENDING' && (
            <>
              <div className="deposit-paying-state waiting">
                <i />
                <div>
                  <strong>等待支付结果</strong>
                  <span>完成支付后请回到本页面，到账会自动更新。</span>
                </div>
              </div>
              {vpayOrder.payUrl && (
                <button
                  className="primary-action deposit-cta-blue"
                  type="button"
                  onClick={() => openExternalLink(vpayOrder.payUrl!)}
                >
                  重新打开支付页
                </button>
              )}
              <button
                className="deposit-secondary-btn"
                type="button"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void refreshVpayStatus(vpayOrder.id)
                    .catch(() => undefined)
                    .finally(() => setBusy(false));
                }}
              >
                {busy ? '查询中…' : '我已完成支付，刷新状态'}
              </button>
            </>
          )}

          {vpayOrder.status === 'COMPLETED' && (
            <div className="deposit-paying-state done">
              <i>✓</i>
              <div>
                <strong>充值已到账</strong>
                <span>金额已加入可用余额，可直接进入牌局。</span>
              </div>
            </div>
          )}

          {vpayOrder.status === 'REJECTED' && (
            <div className="deposit-paying-state failed">
              <i>!</i>
              <div>
                <strong>支付未完成</strong>
                <span>{vpayOrder.rejectReason ?? '本次支付未成功，未扣除任何金额。'}</span>
              </div>
            </div>
          )}

          <button className="deposit-secondary-btn" type="button" onClick={resetVpay}>
            返回充值
          </button>
          <button className="text-link-btn" type="button" onClick={() => navigate('/wallet/orders')}>
            查看充值工单
          </button>
        </section>
      )}

      {!vpayOrder && step === 1 && (
        <>
          <label className="deposit-label">充值金额</label>
          <label className="deposit-amount-box">
            <span>RM</span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(event) => onCustomAmount(event.target.value)}
              placeholder="0.00"
              disabled={!approved}
              aria-label="充值金额"
            />
          </label>
          <p className="deposit-min-hint">
            最低充值 RM{minAmount}
            {maxAmount > 0 ? ` · 单笔上限 RM${maxAmount}` : ''}
          </p>

          <div className="amount-grid deposit-amount-grid">
            {PRESET_AMOUNTS.map((value) => (
              <button
                key={value}
                type="button"
                className={`amount-chip ${selected === value ? 'active' : ''}`}
                onClick={() => pickAmount(value)}
                disabled={!approved}
              >
                {value}
              </button>
            ))}
          </div>

          {vpayAvailable && (
            <>
              <label className="deposit-label">充值方式</label>
              <div className="deposit-method-list">
                <button
                  type="button"
                  className={`deposit-method ${method === 'VPAY' ? 'active' : ''}`}
                  onClick={() => {
                    setMethod('VPAY');
                    setError('');
                  }}
                >
                  <strong>快捷充值</strong>
                  <span>在线支付，成功后自动到账</span>
                </button>
                <button
                  type="button"
                  className={`deposit-method ${method === 'MANUAL' ? 'active' : ''}`}
                  onClick={() => {
                    setMethod('MANUAL');
                    setError('');
                  }}
                >
                  <strong>银行转账</strong>
                  <span>转账后上传凭证，客服核对入账</span>
                </button>
              </div>
            </>
          )}

          {useVpay && (channels?.vpay.tradeCodes.length ?? 0) > 1 && (
            <>
              <label className="deposit-label">支付通道</label>
              <div className="deposit-method-list">
                {channels?.vpay.tradeCodes.map((item) => (
                  <button
                    key={item.code}
                    type="button"
                    className={`deposit-method compact ${tradeCode === item.code ? 'active' : ''}`}
                    onClick={() => {
                      setTradeCode(item.code);
                      setError('');
                    }}
                  >
                    <strong>{item.label}</strong>
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="deposit-info">
            <i>i</i>
            <p>
              {useVpay
                ? '点击下方按钮将跳转至支付页面，请在有效期内完成支付；支付成功后余额自动到账。'
                : '系统会根据您输入的金额自动分配对应的收款账户，请按账户信息完成银行转账。'}
            </p>
          </div>

          <button className="deposit-usdt-btn" type="button" onClick={() => navigate('/support')}>
            <IconSupport size={18} />
            使用USDT充值？联系客服
          </button>

          {error && <div className="inline-alert error">{error}</div>}

          <button
            className="primary-action deposit-next"
            type="button"
            disabled={!approved || !amountOk || busy || (useVpay && !tradeCode)}
            onClick={() => void (useVpay ? startVpay() : goPayeeStep())}
          >
            {busy ? '处理中…' : useVpay ? '立即支付' : '下一步'}
          </button>
        </>
      )}

      {!vpayOrder && step === 2 && payee && (
        <section className="deposit-transfer">
          <div className="deposit-transfer-amount">
            <small>应转账金额</small>
            <strong>RM {formatMoney(amount)}</strong>
          </div>

          <div className="deposit-bank-card">
            <div className="deposit-bank-row">
              <span>银行</span>
              <b>{payee.bankName}</b>
            </div>
            <div className="deposit-bank-row">
              <span>账号</span>
              <div>
                <b>{payee.accountNo}</b>
                <button type="button" onClick={() => void copyText('账号', payee.accountNo)}>
                  {copied === '账号' ? '已复制' : '复制'}
                </button>
              </div>
            </div>
            <div className="deposit-bank-row">
              <span>户名</span>
              <div>
                <b>{payee.accountName}</b>
                <button type="button" onClick={() => void copyText('户名', payee.accountName)}>
                  {copied === '户名' ? '已复制' : '复制'}
                </button>
              </div>
            </div>
          </div>

          <div className="deposit-warn">
            <strong>❗️ 如充值的银行名字与实名的名字不相同 ❗️ 本公司将完全充公所有金额，不得争议</strong>
            <p>请禁止🚫备注敏感字眼，可直接备注银行名字最后的字 / okok / noted / done.</p>
          </div>

          <div className="deposit-tip">
            <i>⚡</i>
            <p>请使用同名银行账户转账指定金额。转账完成后点击下方按钮，客服核对无误后将自动到账。</p>
          </div>

          {error && <div className="inline-alert error">{error}</div>}

          <button className="primary-action deposit-cta-blue" type="button" onClick={() => setStep(3)}>
            下一步 · 上传转账凭证
          </button>
          <button className="deposit-secondary-btn" type="button" onClick={() => setStep(1)}>
            返回修改金额
          </button>
        </section>
      )}

      {!vpayOrder && step === 3 && (
        <section className="deposit-step2">
          <div className="deposit-summary">
            <small>应转账金额</small>
            <strong>RM {formatMoney(amount)}</strong>
          </div>

          {payee && (
            <p className="muted wallet-flow-copy">
              请确认已转账至 {payee.bankName} / {payee.accountName}，再上传凭证。
            </p>
          )}

          <label className="field-label">转账凭证（图片 / PDF，最多 5MB）</label>
          <label className="upload-box">
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={(event) => setProof(event.target.files?.[0] ?? null)}
            />
            <b>{proof ? '✓' : '↑'}</b>
            <span>{proof?.name ?? '点击上传凭证'}</span>
          </label>

          {error && <div className="inline-alert error">{error}</div>}
          {message && <div className="inline-alert">{message}</div>}

          <button
            className="primary-action deposit-cta-blue"
            type="button"
            disabled={busy || !proof || !!message}
            onClick={() => void submit()}
          >
            {busy ? '处理中…' : message ? '已提交' : '确认提交'}
          </button>

          <button className="deposit-secondary-btn" type="button" onClick={() => setStep(2)}>
            返回账户信息
          </button>

          <button className="text-link-btn" type="button" onClick={() => navigate('/wallet/orders')}>
            查看充值工单
          </button>
        </section>
      )}
    </div>
  );
}
