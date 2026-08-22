import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { goBack } from '../lib/nav';
import { BackIcon } from '../components/MoneyIcons';
import PaymentPinSheet from '../components/PaymentPinSheet';
import { completeRequest, pendingRequestId } from '../lib/idempotency';
import { paymentPinErrorMessage } from '../lib/paymentPin';

const PRESETS = ['20', '50', '100', '500', '1000', '2000'];

const TIP_ERROR: Record<string, string> = {
  INSUFFICIENT_BALANCE: '余额不足，请先充值',
  KYC_REQUIRED: '请先完成实名认证',
  INVALID_TIP_AMOUNT: '打赏金额需在 RM1 ~ RM5,000 之间',
  IDEMPOTENCY_CONFLICT: '本次打赏资料已改变，请返回后重新操作',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
  REQUEST_TIMEOUT: '网络超时，请稍后重试',
  INTERNAL: '服务器繁忙，请稍后重试',
};

const RAW_ERROR_CODE = /^[A-Z][A-Z0-9_]+$/;

function tipErrorMessage(error: unknown): string {
  const issue = error as Error & { code?: string };
  const code = issue.code ?? '';
  if (code && TIP_ERROR[code]) return TIP_ERROR[code];
  const message = issue.message?.trim() ?? '';
  if (message && !RAW_ERROR_CODE.test(message)) return message;
  if (code && !RAW_ERROR_CODE.test(code)) return code;
  return '打赏未完成，请稍后重试';
}

function normalizeMoneyInput(value: string) {
  const cleaned = value.replace(/[^\d.]/g, '').slice(0, 10);
  const dot = cleaned.indexOf('.');
  if (dot < 0) return cleaned.replace(/^0+(?=\d)/, '');
  const whole = (cleaned.slice(0, dot) || '0').replace(/^0+(?=\d)/, '');
  const fraction = cleaned.slice(dot + 1).replace(/\./g, '').slice(0, 2);
  return `${whole}.${fraction}`;
}

export default function TipSupport({
  ownerUid,
  paymentPinSet,
}: {
  ownerUid: string;
  paymentPinSet: boolean;
}) {
  const { roomId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pinOpen, setPinOpen] = useState(false);
  const [pinError, setPinError] = useState('');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const displayAmount = useMemo(() => {
    const n = Number(amount);
    if (!amount || !Number.isFinite(n) || n < 0) return '0.00';
    return n.toFixed(2);
  }, [amount]);

  const selectedPreset = useMemo(() => {
    const n = Number(amount);
    if (!amount || !Number.isFinite(n)) return '';
    return PRESETS.find((value) => Number(value) === n) ?? '';
  }, [amount]);

  function validateAmount() {
    if (!/^(?!0+(?:\.0{1,2})?$)\d+(\.\d{1,2})?$/.test(amount)) {
      setError('请输入正确的打赏金额');
      return false;
    }
    const value = Number(amount);
    if (value < 1 || value > 5_000) {
      setError('打赏金额需在 RM1 ~ RM5,000 之间');
      return false;
    }
    return true;
  }

  async function submit(paymentPin: string) {
    if (!validateAmount()) return;
    setBusy(true);
    setError('');
    setPinError('');
    try {
      const requestKey = `tip:${roomId}:${amount}`;
      const requestId = pendingRequestId(requestKey, ownerUid);
      const receipt = await api.tipSupport(roomId, amount, requestId, paymentPin);
      completeRequest(requestKey, requestId, ownerUid);
      if (!mountedRef.current) return;
      setPinOpen(false);
      const openedOverRoom = Boolean(
        (location.state as { backgroundLocation?: unknown } | null)?.backgroundLocation,
      );
      if (openedOverRoom) {
        navigate(-1);
      } else {
        navigate(`/game/${roomId}/play`, {
          replace: true,
          state: {
            tipNotice: {
              nickname: receipt.nickname,
              amountCents: receipt.amountCents,
              avatarUrl: receipt.avatarUrl,
            },
          },
        });
      }
    } catch (e) {
      if (!mountedRef.current) return;
      const code = (e as Error & { code?: string }).code ?? (e as Error).message;
      if (code === 'PAYMENT_PIN_REQUIRED') {
        setPinOpen(false);
        navigate('/settings/payment-pin', {
          state: { returnTo: `/game/${roomId}/tip` },
        });
        return;
      }
      if (code.startsWith('PAYMENT_PIN_')) {
        setPinError(paymentPinErrorMessage(e));
        return;
      }
      setPinOpen(false);
      setError(tipErrorMessage(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  function requestPaymentPin() {
    if (!validateAmount()) return;
    setError('');
    if (!paymentPinSet) {
      navigate('/settings/payment-pin', {
        state: { returnTo: `/game/${roomId}/tip` },
      });
      return;
    }
    setPinError('');
    setPinOpen(true);
  }

  return (
    <div className="tip-page">
      <div className="tip-page-glow" aria-hidden />
      <header className="tip-page-nav">
        <button
          type="button"
          className="tip-page-back"
          onClick={() => goBack(navigate, location, roomId ? `/game/${roomId}/play` : '/')}
          aria-label="返回"
        >
          <BackIcon />
        </button>
        <h1>打赏</h1>
        <span />
      </header>

      <main className="tip-page-body">
        <section className="tip-page-hero" aria-labelledby="tip-page-title">
          <span className="tip-page-avatar" aria-hidden>
            <img src="/avatars/support-girl.jpg" alt="" />
          </span>
          <p className="tip-page-kicker">打赏给</p>
          <h2 id="tip-page-title">客服小妹</h2>
        </section>

        <section className="tip-page-stage">
          <div className="tip-page-amount">
            <span>转账金额</span>
            <label>
              <em>RM</em>
              <input
                inputMode="decimal"
                aria-label="打赏金额"
                placeholder="0"
                value={amount}
                onChange={(e) => {
                  setAmount(normalizeMoneyInput(e.target.value));
                  setError('');
                }}
                autoComplete="off"
                disabled={busy}
              />
            </label>
          </div>
          <div className="tip-page-presets" aria-label="快捷选择打赏金额">
            {PRESETS.map((value) => (
              <button
                key={value}
                type="button"
                className={selectedPreset === value ? 'active' : ''}
                onClick={() => {
                  setAmount(value);
                  setError('');
                }}
                disabled={busy}
              >
                {value}
              </button>
            ))}
          </div>
        </section>

        {error ? (
          <p className="tip-page-error" role="alert">
            {error}
          </p>
        ) : null}
      </main>

      <footer className="tip-page-dock">
        <button
          type="button"
          className="tip-page-cta"
          disabled={busy || !amount}
          onClick={requestPaymentPin}
        >
          {busy ? '支付中…' : amount ? `确认打赏 RM ${displayAmount}` : '输入金额后打赏'}
        </button>
      </footer>

      <PaymentPinSheet
        open={pinOpen}
        title="确认打赏"
        description="打赏给客服小妹，金额将从可用余额扣除"
        amount={`RM ${displayAmount}`}
        busy={busy}
        error={pinError}
        onClose={() => {
          if (!busy) setPinOpen(false);
        }}
        onConfirm={(pin) => void submit(pin)}
      />
    </div>
  );
}
