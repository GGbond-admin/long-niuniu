import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, rm, type GameAdminConsole } from '../api';
import PaymentPinSheet from '../components/PaymentPinSheet';
import { completeRequest, pendingRequestId } from '../lib/idempotency';
import { goBack } from '../lib/nav';
import { paymentPinErrorMessage } from '../lib/paymentPin';

const greetings = [
  '管理员送福利，祝大家好运',
  '恭喜发财，大吉大利',
  '今日好运，请查收',
  '游戏愉快，牛气冲天',
];

const errors: Record<string, string> = {
  INSUFFICIENT_GAME_BUDGET: '本游戏运营预算不足，请联系平台财务拨款',
  INVALID_PACKET_AMOUNT: '红包总金额至少为 RM0.10',
  INVALID_PACKET_COUNT: '红包个数需在 1～50 之间',
  PACKET_TOO_SMALL: '金额太小，每份至少 RM0.01',
  GAME_ADMIN_ACCESS_DENIED: '管理员授权已停用，请返回刷新',
  GAME_ADMIN_PERMISSION_DENIED: '当前授权没有发送预算红包权限',
};

function formatInputAmount(value: string) {
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(value);
  if (!match) return '0.00';
  const whole = match[1]!.replace(/^0+(?=\d)/, '');
  return `${whole}.${(match[2] ?? '').padEnd(2, '0')}`;
}

export default function GameAdminSendPacket({
  paymentPinSet,
  ownerUid,
}: {
  paymentPinSet: boolean;
  ownerUid: string;
}) {
  const { gameCode = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [consoleData, setConsoleData] = useState<GameAdminConsole | null>(null);
  const [mode, setMode] = useState<'RANDOM' | 'EQUAL'>('RANDOM');
  const [count, setCount] = useState('1');
  const [amount, setAmount] = useState('');
  const [greeting, setGreeting] = useState(greetings[0]!);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pinOpen, setPinOpen] = useState(false);
  const [pinError, setPinError] = useState('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void api
      .gameAdminConsole(gameCode)
      .then(setConsoleData)
      .catch((cause) => setError((cause as Error).message || '预算加载失败'));
    return () => {
      mounted.current = false;
    };
  }, [gameCode]);

  const displayAmount = useMemo(() => {
    return formatInputAmount(amount);
  }, [amount]);

  const remaining = useMemo(() => {
    if (!consoleData || !/^\d+(?:\.\d{1,2})?$/.test(amount)) return null;
    const [whole, decimals = ''] = amount.split('.');
    const cents = BigInt(whole) * 100n + BigInt((decimals + '00').slice(0, 2));
    return BigInt(consoleData.budget.balanceCents) - cents;
  }, [amount, consoleData]);

  function validate() {
    const countValue = Number(count);
    if (!Number.isInteger(countValue) || countValue < 1 || countValue > 50) {
      setError('红包个数需为 1～50 个');
      return null;
    }
    if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) {
      setError('请填写正确的总金额，最多两位小数');
      return null;
    }
    if (remaining !== null && remaining < 0n) {
      setError('本游戏运营预算不足');
      return null;
    }
    return countValue;
  }

  function requestPin() {
    if (validate() === null) return;
    setError('');
    if (!paymentPinSet) {
      navigate('/settings/payment-pin', {
        state: { returnTo: `/game-admin/${gameCode}/send-packet` },
      });
      return;
    }
    setPinError('');
    setPinOpen(true);
  }

  async function submit(paymentPin: string) {
    const countValue = validate();
    if (countValue === null) return;
    const normalizedGreeting = greeting.trim() || greetings[0]!;
    const requestKey = `game-admin-packet:${gameCode}`;
    const requestId = pendingRequestId(requestKey, ownerUid);
    setBusy(true);
    setError('');
    setPinError('');
    try {
      const result = await api.gameAdminSendPacket(gameCode, {
        amount,
        count: countValue,
        mode,
        greeting: normalizedGreeting,
        requestId,
        paymentPin,
      });
      completeRequest(requestKey, requestId, ownerUid);
      if (!mounted.current) return;
      setPinOpen(false);
      navigate(`/game-admin/${gameCode}`, {
        replace: true,
        state: { packetSent: result.packetId },
      });
    } catch (cause) {
      const code = (cause as Error & { code?: string }).code ?? (cause as Error).message;
      if (code === 'IDEMPOTENCY_CONFLICT') {
        completeRequest(requestKey, requestId, ownerUid);
      }
      if (!mounted.current) return;
      if (code === 'PAYMENT_PIN_REQUIRED') {
        setPinOpen(false);
        navigate('/settings/payment-pin', {
          state: { returnTo: `/game-admin/${gameCode}/send-packet` },
        });
        return;
      }
      if (code.startsWith('PAYMENT_PIN_')) {
        setPinError(paymentPinErrorMessage(cause));
        return;
      }
      setPinOpen(false);
      setError(
        code === 'IDEMPOTENCY_CONFLICT'
          ? '上一笔红包已发送，系统已阻止重复扣款。'
          : errors[code] ?? (cause as Error).message ?? '发送失败',
      );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div className="gam-page gam-packet">
      <header className="gam-nav">
        <button type="button" onClick={() => goBack(navigate, location, `/game-admin/${gameCode}`)} aria-label="返回">‹</button>
        <span><small>ADMIN PACKET</small><strong>发送管理员红包</strong></span>
        <i />
      </header>

      <main>
        <section className="gam-packet-budget">
          <span><small>{gameCode} · 共享运营预算</small><strong>RM {rm(consoleData?.budget.balanceCents ?? '0')}</strong></span>
          <em>平台备付金托管</em>
        </section>

        <section className="gam-packet-card">
          <div className="gam-packet-mark">
            <span>管</span>
            <div><small>GAME ADMINISTRATOR</small><strong>管理员专属红包</strong></div>
          </div>

          <button className="gam-packet-mode" type="button" disabled={busy} onClick={() => setMode((current) => current === 'RANDOM' ? 'EQUAL' : 'RANDOM')}>
            <span><small>分配方式</small><strong>{mode === 'RANDOM' ? '拼手气红包' : '平均红包'}</strong></span>
            <em>切换 ›</em>
          </button>
          <label className="gam-packet-row">
            <span>红包个数</span>
            <input inputMode="numeric" value={count} disabled={busy} onChange={(event) => setCount(event.target.value.replace(/\D/g, '').slice(0, 2))} placeholder="1" />
            <i>个</i>
          </label>
          <label className="gam-packet-row">
            <span>总金额</span>
            <input inputMode="decimal" value={amount} disabled={busy} onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, '').slice(0, 24))} placeholder="0.00" />
            <i>RM</i>
          </label>
          <label className="gam-packet-greeting">
            <span>祝福语</span>
            <div>
              <input value={greeting} maxLength={40} disabled={busy} onChange={(event) => setGreeting(event.target.value)} />
              <button type="button" disabled={busy} onClick={() => setGreeting(greetings[Math.floor(Math.random() * greetings.length)]!)}>换</button>
            </div>
          </label>
        </section>

        <section className="gam-packet-total">
          <small>本次预算支出</small>
          <span><i>RM</i><strong>{displayAmount}</strong></span>
          <p className={remaining !== null && remaining < 0n ? 'negative' : ''}>
            发送后预算余额 {remaining === null ? '—' : `RM ${rm(remaining)}`}
          </p>
        </section>

        {error && <div className="gam-alert error">{error}</div>}

        <button className="gam-packet-cta" type="button" disabled={busy || !amount || !count || !consoleData} onClick={requestPin}>
          {busy ? '正在锁定预算…' : '验证支付密码并发送'}
        </button>
        <p className="gam-packet-note">
          未领取金额 24 小时后原路退回本游戏预算；该红包不会扣除你的个人钱包余额。
        </p>
      </main>

      <PaymentPinSheet
        open={pinOpen}
        title="确认管理员红包"
        description={`${gameCode} · ${mode === 'RANDOM' ? '拼手气' : '平均'} · ${count || 0} 个`}
        amount={`RM ${displayAmount}`}
        busy={busy}
        error={pinError}
        onClose={() => !busy && setPinOpen(false)}
        onConfirm={(pin) => void submit(pin)}
      />
    </div>
  );
}
