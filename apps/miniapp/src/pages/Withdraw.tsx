import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, rm } from '../api';
import InstitutionLogo from '../components/InstitutionLogo';
import PaymentPinSheet from '../components/PaymentPinSheet';
import {
  readSelectedWithdrawAccountId,
  writeSelectedWithdrawAccountId,
} from '../data/institutions';
import { completeRequest, pendingRequestId } from '../lib/idempotency';
import { paymentPinErrorMessage } from '../lib/paymentPin';

const PRESET_AMOUNTS = ['100', '200', '500', '1000', '2000', '5000'];

type Account = Awaited<ReturnType<typeof api.withdrawAccounts>>['items'][number];
type WithdrawInfo = Awaited<ReturnType<typeof api.withdrawInfo>>;

function backToWallet(navigate: ReturnType<typeof useNavigate>) {
  try {
    sessionStorage.setItem('miniapp-tab', 'wallet');
  } catch {
    // ignore
  }
  navigate('/');
}

function parseAmountCents(value: string): bigint | null {
  if (!/^(?!0+(?:\.0{1,2})?$)\d+(\.\d{1,2})?$/.test(value)) return null;
  const [i, d = ''] = value.split('.');
  return BigInt(i) * 100n + BigInt((d + '00').slice(0, 2));
}

export default function Withdraw({
  kycStatus,
  paymentPinSet,
  ownerUid,
}: {
  kycStatus: string;
  paymentPinSet: boolean;
  ownerUid: string;
}) {
  const navigate = useNavigate();
  const [available, setAvailable] = useState('0');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [info, setInfo] = useState<WithdrawInfo | null>(null);
  const [amount, setAmount] = useState('1000');
  const [selected, setSelected] = useState<string | null>('1000');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [pinOpen, setPinOpen] = useState(false);
  const [pinError, setPinError] = useState('');

  const selectedAccount = useMemo(
    () => accounts.find((item) => item.id === selectedAccountId && item.status === 'APPROVED') ?? null,
    [accounts, selectedAccountId],
  );

  const amountCents = useMemo(() => parseAmountCents(amount), [amount]);
  const minCents = BigInt(info?.minCents ?? '10000');
  const feeRatio = info?.feeRatioAfterFree ?? 0.03;
  const freeRemaining = info?.freeRemaining ?? 0;
  const freeDailyLimit = info?.freeDailyLimit ?? 2;
  const willChargeFee = freeRemaining <= 0;
  const feeCents =
    willChargeFee && amountCents != null
      ? (amountCents * BigInt(Math.round(feeRatio * 1_000_000)) + 500_000n) / 1_000_000n
      : 0n;
  const receiveCents = amountCents != null ? amountCents - feeCents : null;

  const load = useCallback(async () => {
    if (kycStatus !== 'APPROVED') return;
    const [wallet, accountResult, withdrawInfo] = await Promise.all([
      api.wallet(),
      api.withdrawAccounts(),
      api.withdrawInfo(),
    ]);
    setAvailable(wallet.balance.availableCents);
    setAccounts(accountResult.items);
    setInfo(withdrawInfo);

    const stored = readSelectedWithdrawAccountId();
    const preferred =
      accountResult.items.find((item) => item.id === stored && item.status === 'APPROVED') ??
      accountResult.items.find((item) => item.isDefault && item.status === 'APPROVED') ??
      accountResult.items.find((item) => item.status === 'APPROVED');

    const nextId = preferred?.id ?? '';
    setSelectedAccountId(nextId);
    if (nextId) writeSelectedWithdrawAccountId(nextId);
  }, [kycStatus]);

  useEffect(() => {
    if (kycStatus === 'NONE' || kycStatus === 'REJECTED') {
      navigate('/kyc', { replace: true });
      return;
    }
    if (kycStatus === 'PENDING') {
      setError('实名认证审核中，通过后即可提现。');
      return;
    }
    void load().catch((err) => setError((err as Error).message || '加载失败'));
  }, [kycStatus, navigate, load]);

  function pickAmount(value: string) {
    setSelected(value);
    setAmount(value);
  }

  function onCustomAmount(value: string) {
    const next = value.replace(/[^\d.]/g, '');
    setAmount(next);
    setSelected(PRESET_AMOUNTS.includes(next) ? next : null);
  }

  function validateWithdrawal(): boolean {
    if (kycStatus !== 'APPROVED' || !amount || !selectedAccountId || amountCents == null) {
      return false;
    }
    if (amountCents < minCents) {
      setError(`最低提现 RM ${rm(minCents)}`);
      return false;
    }
    if (amountCents > BigInt(available || '0')) {
      setError('可用余额不足');
      return false;
    }
    return true;
  }

  function requestPaymentPin() {
    if (!validateWithdrawal()) return;
    setError('');
    if (!paymentPinSet) {
      navigate('/settings/payment-pin', {
        state: { returnTo: '/wallet/withdraw' },
      });
      return;
    }
    setPinError('');
    setPinOpen(true);
  }

  async function submitWithdraw(paymentPin: string) {
    if (!validateWithdrawal()) return;
    const requestKey = 'withdraw';
    const requestId = pendingRequestId(requestKey, ownerUid);
    setBusy(true);
    setMessage('');
    setError('');
    setPinError('');
    try {
      const result = await api.withdraw(amount, selectedAccountId, requestId, paymentPin);
      completeRequest(requestKey, requestId, ownerUid);
      setPinOpen(false);
      setMessage(
        result.feeCents !== '0'
          ? `提现已提交：手续费 RM ${rm(result.feeCents)}，预计到账 RM ${rm(result.netCents)}。申请金额已冻结，等待财务处理。`
          : `提现已提交：本次免手续费，预计到账 RM ${rm(result.netCents)}。申请金额已冻结，等待财务处理。`,
      );
      setAmount('');
      setSelected(null);
      await load();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'PAYMENT_PIN_REQUIRED') {
        setPinOpen(false);
        navigate('/settings/payment-pin', {
          state: { returnTo: '/wallet/withdraw' },
        });
        return;
      }
      if (code?.startsWith('PAYMENT_PIN_')) {
        setPinError(paymentPinErrorMessage(err));
        return;
      }
      if (code === 'IDEMPOTENCY_CONFLICT') {
        completeRequest(requestKey, requestId, ownerUid);
        setPinOpen(false);
        setMessage('上一笔提现已提交，系统已阻止重复扣款，请到提现工单查看处理状态。');
        await load().catch(() => undefined);
        return;
      }
      setPinOpen(false);
      setError(
        code === 'INSUFFICIENT_BALANCE'
          ? '可用余额不足'
          : code === 'BELOW_MIN_WITHDRAW'
            ? `最低提现 RM ${rm(minCents)}`
            : code === 'INVALID_WITHDRAW_ACCOUNT'
              ? '所选收款账户当前不可用，请重新选择'
            : `提交失败：${(err as Error).message}`,
      );
    } finally {
      setBusy(false);
    }
  }

  const approved = kycStatus === 'APPROVED';
  const canSubmit =
    approved &&
    !!selectedAccount &&
    amountCents != null &&
    amountCents >= minCents &&
    amountCents <= BigInt(available || '0') &&
    !busy;

  return (
    <div className="page subpage wd-page">
      <header className="subpage-header">
        <button type="button" onClick={() => backToWallet(navigate)} aria-label="返回">
          ‹
        </button>
        <div>
          <h1>提现</h1>
        </div>
        <button
          type="button"
          className="wd-orders-link"
          onClick={() => navigate('/wallet/orders')}
          aria-label="提现工单"
        >
          工单
        </button>
      </header>

      <button
        type="button"
        className="wd-account-card"
        disabled={!approved}
        onClick={() => navigate('/wallet/withdraw/accounts')}
      >
        {selectedAccount ? (
          <>
            <InstitutionLogo name={selectedAccount.institution} size={44} />
            <div className="wd-account-main">
              <div className="wd-account-title">
                <strong>{selectedAccount.institution}</strong>
                {selectedAccount.isDefault && <em>默认</em>}
              </div>
              <p>
                {selectedAccount.accountNoMasked} · {selectedAccount.accountName}
              </p>
            </div>
          </>
        ) : (
          <div className="wd-account-main">
            <strong>选择到账账户</strong>
            <p>请选择已审核通过的银行或电子钱包</p>
          </div>
        )}
        <span className="wd-chevron">›</span>
      </button>

      <section className="wd-amount-card">
        <div className="wd-amount-label">
          <span>提现金额</span>
          <button type="button" className="wd-all-btn" disabled={!approved || available === '0'} onClick={() => {
            const cents = BigInt(available || '0');
            const whole = Number(cents) / 100;
            const value = whole.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
            setSelected(null);
            setAmount(value === '0' ? '' : value);
          }}>
            全部
          </button>
        </div>
        <div className="wd-amount-input">
          <span>RM</span>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(event) => onCustomAmount(event.target.value)}
            placeholder="0"
            disabled={!approved}
          />
        </div>
        <p className="wd-min">最低提现 RM {rm(minCents)}</p>
        <p className="wd-balance">
          可提现余额: RM {rm(available)} · 冻结额度不可提现
        </p>

        <div className="wd-presets">
          {PRESET_AMOUNTS.map((value) => (
            <button
              key={value}
              type="button"
              className={selected === value ? 'active' : ''}
              onClick={() => pickAmount(value)}
              disabled={!approved}
            >
              {value}
            </button>
          ))}
        </div>
      </section>

      <section className="wd-free-card">
        <div className="wd-free-row">
          <span>今日剩余免费提现次数</span>
          <strong>
            <b>{freeRemaining}</b>/{freeDailyLimit}
          </strong>
        </div>
        <p>
          第 {freeDailyLimit + 1} 次提现起，每笔将抽取提款金额的 {(feeRatio * 100).toFixed(0)}% 作为手续费
          {willChargeFee && amountCents != null && amountCents > 0n
            ? ` · 本笔预计手续费 RM ${rm(feeCents)}，到账约 RM ${rm(receiveCents ?? 0n)}`
            : ''}
        </p>
      </section>

      <section className="wd-tips">
        <span className="wd-tips-icon">i</span>
        <div>
          <p>提现将打入上方默认/所选账户，审核时间为 1–24 小时。</p>
          <p>点击顶部账户卡片可管理收款账号。</p>
          <p>仅限 USDT 充值的余额可使用 USDT 提款，请联系客服处理。</p>
        </div>
      </section>

      {error && <div className="inline-alert error">{error}</div>}
      {message && <div className="inline-alert">{message}</div>}

      <button type="button" className="wd-usdt-btn" onClick={() => navigate('/support')}>
        USDT 提款？联系客服
      </button>

      <button
        className="primary-action wd-submit"
        type="button"
        disabled={!canSubmit}
        onClick={requestPaymentPin}
      >
        {busy ? '处理中…' : '申请提现'}
      </button>
      <PaymentPinSheet
        open={pinOpen}
        title="确认提现"
        description={`资金将转入 ${selectedAccount?.institution ?? '所选收款账户'}`}
        amount={amountCents == null ? undefined : `RM ${rm(amountCents)}`}
        busy={busy}
        error={pinError}
        onClose={() => {
          if (!busy) setPinOpen(false);
        }}
        onConfirm={(pin) => void submitWithdraw(pin)}
      />
    </div>
  );
}
