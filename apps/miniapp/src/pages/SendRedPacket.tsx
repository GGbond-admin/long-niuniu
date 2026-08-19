import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { goBack } from '../lib/nav';
import { BackIcon } from '../components/MoneyIcons';
import PaymentPinSheet from '../components/PaymentPinSheet';
import { completeRequest, pendingRequestId } from '../lib/idempotency';
import { paymentPinErrorMessage } from '../lib/paymentPin';

const GREETINGS = [
  '恭喜发财，大吉大利',
  '大吉大利，今晚吃鸡',
  '财源广进，红包拿来',
  '牛气冲天，发发发',
  '好运连连，恭喜发财',
];

const PACKET_ERROR: Record<string, string> = {
  INSUFFICIENT_BALANCE: '余额不足，请先充值',
  KYC_REQUIRED: '请先完成实名认证',
  INVALID_PACKET_AMOUNT: '红包金额超出范围（RM0.10 ~ RM10000）',
  INVALID_PACKET_COUNT: '红包个数需在 1 ~ 50 之间',
  PACKET_TOO_SMALL: '金额太小，每份至少 RM0.01',
};

export default function SendRedPacket({
  paymentPinSet,
  ownerUid,
}: {
  paymentPinSet: boolean;
  ownerUid: string;
}) {
  const { roomId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState<'RANDOM' | 'EQUAL'>('RANDOM');
  const [count, setCount] = useState('');
  const [amount, setAmount] = useState('');
  const [greeting, setGreeting] = useState(GREETINGS[0]!);
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

  function validatePacket(): number | null {
    const countNum = Number(count);
    if (!Number.isInteger(countNum) || countNum < 1 || countNum > 50) {
      setError('红包个数需为 1～50 个');
      return null;
    }
    if (!amount) {
      setError('请填写总金额');
      return null;
    }
    return countNum;
  }

  function requestPaymentPin() {
    if (validatePacket() == null) return;
    setError('');
    if (!paymentPinSet) {
      navigate('/settings/payment-pin', {
        state: { returnTo: `/game/${roomId}/send-packet` },
      });
      return;
    }
    setPinError('');
    setPinOpen(true);
  }

  async function submit(paymentPin: string) {
    const countNum = validatePacket();
    if (countNum == null) return;
    const normalizedGreeting = greeting.trim() || '恭喜发财，大吉大利';
    const requestKey = `group-packet:${roomId}`;
    const requestId = pendingRequestId(requestKey, ownerUid);
    setBusy(true);
    setError('');
    setPinError('');
    try {
      const result = await api.sendGroupPacket(
        roomId,
        amount,
        countNum,
        mode,
        normalizedGreeting,
        requestId,
        paymentPin,
      );
      completeRequest(requestKey, requestId, ownerUid);
      if (!mountedRef.current) return;
      setPinOpen(false);
      const openedOverRoom = Boolean(
        (location.state as { backgroundLocation?: unknown } | null)?.backgroundLocation,
      );
      if (openedOverRoom) {
        // 群聊仍挂载且会收到 USER_PACKET；真实回退可移除覆盖层历史，避免 play→play。
        navigate(-1);
      } else {
        navigate(`/game/${roomId}/play`, {
          replace: true,
          state: {
            sentPacket: {
              packetId: result.packetId,
              greeting: normalizedGreeting,
            },
          },
        });
      }
    } catch (e) {
      const code = (e as Error & { code?: string }).code ?? (e as Error).message;
      // 冲突代表服务端已有该笔结果；即使页面已离开也必须清掉本地请求号。
      if (code === 'IDEMPOTENCY_CONFLICT') {
        completeRequest(requestKey, requestId, ownerUid);
      }
      if (!mountedRef.current) return;
      if (code === 'PAYMENT_PIN_REQUIRED') {
        setPinOpen(false);
        navigate('/settings/payment-pin', {
          state: { returnTo: `/game/${roomId}/send-packet` },
        });
        return;
      }
      if (code.startsWith('PAYMENT_PIN_')) {
        setPinError(paymentPinErrorMessage(e));
        return;
      }
      if (code === 'IDEMPOTENCY_CONFLICT') {
        setPinOpen(false);
        setError('上一笔红包已发送，系统已阻止重复扣款，请返回群聊查看。');
        return;
      }
      setPinOpen(false);
      setError(PACKET_ERROR[code] ?? code ?? '发送失败');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <div className="cash-page cash-packet">
      <header className="cash-nav">
        <button type="button" className="cash-back" onClick={() => goBack(navigate, location, roomId ? `/game/${roomId}/play` : '/')} aria-label="返回">
          <BackIcon />
        </button>
        <h1>发红包</h1>
        <span />
      </header>

      <div className="cash-body">
        <section className="cash-sheet">
          <button
            type="button"
            className="cash-mode"
            onClick={() => setMode((m) => (m === 'RANDOM' ? 'EQUAL' : 'RANDOM'))}
            disabled={busy}
          >
            <b>{mode === 'RANDOM' ? '拼手气红包' : '普通红包'}</b>
            <em>改为{mode === 'RANDOM' ? '平均' : '拼手气'}</em>
          </button>

          <label className="cash-row">
            <span>红包个数</span>
            <input
              inputMode="numeric"
              placeholder="填写个数"
              value={count}
              onChange={(e) => {
                setCount(e.target.value.replace(/\D/g, '').slice(0, 2));
                setError('');
              }}
              disabled={busy}
            />
            <i>个</i>
          </label>

          <label className="cash-row">
            <span>总金额</span>
            <input
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value.replace(/[^\d.]/g, '').slice(0, 10));
                setError('');
              }}
              disabled={busy}
            />
            <i>RM</i>
          </label>

          <label className="cash-greet">
            <input
              value={greeting}
              maxLength={40}
              placeholder="恭喜发财，大吉大利"
              onChange={(e) => setGreeting(e.target.value)}
              disabled={busy}
            />
            <button
              type="button"
              className="cash-greet-swap"
              onClick={() =>
                setGreeting(GREETINGS[Math.floor(Math.random() * GREETINGS.length)]!)
              }
              disabled={busy}
            >
              换一句
            </button>
          </label>
        </section>

        <div className="cash-total">
          <small>RM</small>
          <strong>{displayAmount}</strong>
        </div>

        {error && <p className="cash-error">{error}</p>}

        <button
          type="button"
          className="cash-cta packet"
          disabled={busy || !amount || !count}
          onClick={requestPaymentPin}
        >
          {busy ? '发送中…' : '塞钱进红包'}
        </button>

        <p className="cash-note">未领取金额将在 24 小时后退回余额</p>
      </div>
      <PaymentPinSheet
        open={pinOpen}
        title="确认发送红包"
        description={`${mode === 'RANDOM' ? '拼手气红包' : '普通红包'} · ${count || 0} 个`}
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
