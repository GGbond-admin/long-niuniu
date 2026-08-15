import { useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { goBack } from '../lib/nav';
import { BackIcon } from '../components/MoneyIcons';
import { completeRequest, pendingRequestId } from '../lib/idempotency';

const PRESETS = ['1', '5', '10', '20', '50'];

const TIP_ERROR: Record<string, string> = {
  INSUFFICIENT_BALANCE: '余额不足，请先充值',
  KYC_REQUIRED: '请先完成实名认证',
  INVALID_TIP_AMOUNT: '打赏金额需在 RM1 ~ RM5000 之间',
  IDEMPOTENCY_CONFLICT: '本次打赏资料已改变，请返回后重新操作',
};

export default function TipSupport({ ownerUid }: { ownerUid: string }) {
  const { roomId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const displayAmount = useMemo(() => {
    const n = Number(amount);
    if (!amount || !Number.isFinite(n) || n < 0) return '0.00';
    return n.toFixed(2);
  }, [amount]);

  async function submit() {
    if (!amount) {
      setError('请输入转账金额');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const requestKey = `tip:${roomId}:${amount}`;
      const requestId = pendingRequestId(requestKey, ownerUid);
      const receipt = await api.tipSupport(roomId, amount, requestId);
      completeRequest(requestKey, requestId, ownerUid);
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
    } catch (e) {
      const code = (e as Error & { code?: string }).code ?? (e as Error).message;
      setError(TIP_ERROR[code] ?? code ?? '转账失败');
    } finally {
      setBusy(false);
    }
  }

  function requestConfirm() {
    if (!amount) {
      setError('请输入转账金额');
      return;
    }
    setError('');
    setConfirmOpen(true);
  }

  return (
    <div className="tip-page">
      <header className="tip-page-nav">
        <button type="button" className="tip-page-back" onClick={() => goBack(navigate, location, roomId ? `/game/${roomId}/play` : '/')} aria-label="返回">
          <BackIcon />
        </button>
        <h1>打赏客服</h1>
        <span />
      </header>

      <div className="tip-page-body">
        <div className="tip-page-payee">
          <span className="tip-page-avatar" aria-hidden>
            服
          </span>
          <strong>客服小妹</strong>
        </div>

        <div className="tip-page-amount">
          <span>打赏金额</span>
          <label>
            <em>RM</em>
            <input
              inputMode="decimal"
              aria-label="打赏金额"
              placeholder="0.00"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value.replace(/[^\d.]/g, '').slice(0, 10));
                setError('');
              }}
              disabled={busy}
              autoFocus
            />
          </label>
          <p className="tip-page-note" style={{ marginTop: 8, textAlign: 'left' }}>
            单笔 RM1 – RM5,000
          </p>
        </div>

        <div className="tip-page-presets">
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
              {value}
            </button>
          ))}
        </div>

        {error && <p className="tip-page-error">{error}</p>}

        <button
          type="button"
          className="tip-page-cta"
          disabled={busy || !amount}
          onClick={requestConfirm}
        >
          {busy ? '处理中…' : `确认打赏 RM ${displayAmount}`}
        </button>

        <p className="tip-page-note">金额将从可用余额扣除，打赏成功后会在群内显示。</p>
      </div>

      {confirmOpen && (
        <div className="withdraw-sheet" role="dialog" aria-modal="true" aria-label="确认打赏">
          <button
            type="button"
            className="withdraw-sheet-backdrop"
            aria-label="关闭"
            onClick={() => setConfirmOpen(false)}
          />
          <div className="withdraw-sheet-panel">
            <div className="withdraw-sheet-handle" />
            <div className="withdraw-sheet-head">
              <div>
                <strong>确认打赏 RM {displayAmount}</strong>
                <p>金额将从可用余额扣除，确认后立即支付。</p>
              </div>
            </div>
            <button
              type="button"
              className="tip-page-cta"
              disabled={busy}
              onClick={() => {
                setConfirmOpen(false);
                void submit();
              }}
            >
              确认支付
            </button>
            <button
              type="button"
              className="withdraw-sheet-cancel"
              onClick={() => setConfirmOpen(false)}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
