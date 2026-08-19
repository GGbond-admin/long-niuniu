import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { goBack } from '../lib/nav';
import { BackIcon } from '../components/MoneyIcons';
import PaymentPinSheet from '../components/PaymentPinSheet';
import { completeRequest, pendingRequestId } from '../lib/idempotency';
import { paymentPinErrorMessage } from '../lib/paymentPin';

const PRESETS = ['1', '5', '10', '20', '50'];

const TIP_ERROR: Record<string, string> = {
  INSUFFICIENT_BALANCE: '余额不足，请先充值',
  KYC_REQUIRED: '请先完成实名认证',
  INVALID_TIP_AMOUNT: '打赏金额需在 RM1 ~ RM5000 之间',
  IDEMPOTENCY_CONFLICT: '本次打赏资料已改变，请返回后重新操作',
};

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
  nickname,
  avatarUrl,
}: {
  ownerUid: string;
  paymentPinSet: boolean;
  nickname?: string;
  avatarUrl?: string | null;
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
  const previewName = nickname?.trim() || `玩家${ownerUid.slice(-4)}`;

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
        // 群聊仍挂载且会收到 tip_thanks；真实回退可移除覆盖层历史，避免 play→play。
        navigate(-1);
      } else {
        navigate(`/game/${roomId}/play`, {
          replace: true,
          state: {
            tipNotice: {
              nickname: receipt.nickname,
              amountCents: receipt.amountCents,
              message: receipt.message,
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
      setError(TIP_ERROR[code] ?? code ?? '转账失败');
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
      <div className="tip-page-ambient" aria-hidden>
        <i />
        <i />
      </div>
      <header className="tip-page-nav">
        <button
          type="button"
          className="tip-page-back"
          onClick={() => goBack(navigate, location, roomId ? `/game/${roomId}/play` : '/')}
          aria-label="返回"
        >
          <BackIcon />
        </button>
        <h1>送一份心意</h1>
        <span />
      </header>

      <main className="tip-page-body">
        <section className="tip-page-hero" aria-labelledby="tip-page-title">
          <span className="tip-page-hero-shine" aria-hidden />
          <span className="tip-page-avatar" aria-hidden>
            <svg viewBox="0 0 24 24">
              <path d="M5 12a7 7 0 0 1 14 0" />
              <path d="M5 12v4a2 2 0 0 0 2 2h1v-6H5Z" />
              <path d="M19 12v4a2 2 0 0 1-2 2h-1v-6h3Z" />
              <path d="M16 18c-.7 1.2-1.9 2-4 2" />
            </svg>
            <i>♥</i>
          </span>
          <div className="tip-page-hero-copy">
            <small>24H ONLINE SUPPORT</small>
            <h2 id="tip-page-title">送给客服小妹</h2>
            <p>谢谢每一次耐心守候，也谢谢你的认可。</p>
          </div>
          <span className="tip-page-live-pill">
            <i aria-hidden />
            全群播报
          </span>
        </section>

        <section className="tip-page-card">
          <div className="tip-page-amount">
            <div className="tip-page-amount-head">
              <span>选择心意金额</span>
              <small>RM 1 – 5,000</small>
            </div>
            <label>
              <em>RM</em>
              <input
                inputMode="decimal"
                aria-label="打赏金额"
                placeholder="0.00"
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
                className={amount === value ? 'active' : ''}
                onClick={() => {
                  setAmount(value);
                  setError('');
                }}
                disabled={busy}
              >
                <small>RM</small>
                <b>{value}</b>
              </button>
            ))}
          </div>
        </section>

        {error && <p className="tip-page-error">{error}</p>}

        <section className="tip-page-preview" aria-label="互动群弹幕预览">
          <div className="tip-page-preview-head">
            <span>
              <i aria-hidden />
              互动群弹幕预览
            </span>
            <small>打赏成功后实时出现</small>
          </div>
          <div className="tip-page-preview-stage">
            <div className="tip-page-preview-card">
              <span className="tip-page-preview-avatar" aria-hidden>
                {avatarUrl ? <img src={avatarUrl} alt="" /> : previewName.slice(0, 1)}
              </span>
              <span className="tip-page-preview-copy">
                <strong>
                  {previewName}
                  <em>打赏客服小妹</em>
                </strong>
                <small>感谢这份心意，为你全群播报</small>
              </span>
              <b>RM {displayAmount}</b>
            </div>
          </div>
        </section>

        <button
          type="button"
          className="tip-page-cta"
          disabled={busy || !amount}
          onClick={requestPaymentPin}
        >
          <span>{busy ? '正在送出心意…' : '确认打赏'}</span>
          {!busy && <strong>RM {displayAmount}</strong>}
        </button>

        <p className="tip-page-security-note">
          <svg viewBox="0 0 20 20" aria-hidden>
            <rect x="4.5" y="8.5" width="11" height="8" rx="2" />
            <path d="M7 8.5V6.8a3 3 0 0 1 6 0v1.7" />
          </svg>
          支付密码验证 · 记录可在账单中查看
        </p>
      </main>

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
