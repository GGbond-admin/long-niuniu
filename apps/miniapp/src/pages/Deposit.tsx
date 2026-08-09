import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { IconSupport } from '../components/Icons';
import { completeRequest, pendingRequestId } from '../lib/idempotency';

const PRESET_AMOUNTS = ['100', '200', '500', '1000', '2000', '5000'];
const MIN_AMOUNT = 100;

type Payee = {
  id: string;
  bankName: string;
  accountNo: string;
  accountName: string;
  label?: string | null;
};

function backToWallet(navigate: ReturnType<typeof useNavigate>) {
  try {
    sessionStorage.setItem('miniapp-tab', 'wallet');
  } catch {
    // ignore
  }
  navigate('/');
}

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
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [amount, setAmount] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [payee, setPayee] = useState<Payee | null>(null);
  const [proof, setProof] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    if (kycStatus === 'NONE' || kycStatus === 'REJECTED') {
      navigate('/kyc', { replace: true });
      return;
    }
    if (kycStatus === 'PENDING') {
      setError('实名认证审核中，通过后即可充值。');
    }
  }, [kycStatus, navigate]);

  const amountValue = Number(amount);
  const amountOk =
    Number.isFinite(amountValue) && amountValue >= MIN_AMOUNT && /^\d+(\.\d{1,2})?$/.test(amount);
  const approved = kycStatus === 'APPROVED';

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
      setError(`最低充值 RM${MIN_AMOUNT}`);
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

  const title = step === 1 ? '充值' : step === 2 ? '转账到此账户' : '上传转账凭证';

  return (
    <div className="page subpage deposit-page">
      <header className="subpage-header">
        <button
          type="button"
          onClick={() => {
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
            backToWallet(navigate);
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

      {step === 1 && (
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
          <p className="deposit-min-hint">最低充值 RM{MIN_AMOUNT}</p>

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

          <div className="deposit-info">
            <i>i</i>
            <p>系统会根据您输入的金额自动分配对应的收款账户，请按账户信息完成银行转账。</p>
          </div>

          <button className="deposit-usdt-btn" type="button" onClick={() => navigate('/support')}>
            <IconSupport size={18} />
            使用USDT充值？联系客服
          </button>

          {error && <div className="inline-alert error">{error}</div>}

          <button
            className="primary-action deposit-next"
            type="button"
            disabled={!approved || !amountOk || busy}
            onClick={() => void goPayeeStep()}
          >
            {busy ? '加载中…' : '下一步'}
          </button>
        </>
      )}

      {step === 2 && payee && (
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

      {step === 3 && (
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
