import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import PaymentPinInput from '../components/PaymentPinInput';
import { goBack } from '../lib/nav';
import type { Session } from '../sessionStore';
import { paymentPinErrorMessage } from '../lib/paymentPin';

type ReturnState = { returnTo?: string };

export default function PaymentPinSettings({
  session,
  onDone,
}: {
  session: Session;
  onDone: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const changing = session.security.paymentPinSet;
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const returnTo = (location.state as ReturnState | null)?.returnTo;
  const approved = session.onboarding.kycStatus === 'APPROVED';

  async function submit() {
    if (newPin.length !== 6 || (changing && currentPin.length !== 6)) {
      setError('请输入完整的六位数字支付密码');
      return;
    }
    if (newPin !== confirmPin) {
      setError('两次输入的新密码不一致');
      setConfirmPin('');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (changing) {
        await api.changePaymentPin(currentPin, newPin);
      } else {
        await api.setPaymentPin(newPin);
      }
      await onDone().catch(() => undefined);
      navigate(returnTo || '/settings', { replace: true, state: null });
    } catch (reason) {
      setError(paymentPinErrorMessage(reason));
      if ((reason as { code?: string }).code === 'PAYMENT_PIN_INVALID') {
        setCurrentPin('');
      } else {
        setNewPin('');
        setConfirmPin('');
      }
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    !busy &&
    newPin.length === 6 &&
    confirmPin.length === 6 &&
    (!changing || currentPin.length === 6);

  return (
    <div className="page subpage pps-page">
      <header className="subpage-header">
        <button
          type="button"
          onClick={() =>
            // 强制设置支付密码期间（已实名但未设密），普通页面都会被守卫弹回本页，
            // 回退历史只会原地打转，因此固定跳到允许访问的协议页；其余情况真实回退。
            approved && !changing
              ? navigate('/settings/legal')
              : goBack(navigate, location, '/settings')
          }
          aria-label="返回"
        >
          ‹
        </button>
        <div>
          <h1>{changing ? '修改支付密码' : '设置支付密码'}</h1>
        </div>
        <span />
      </header>

      {!approved ? (
        <section className="pps-gate">
          <h2>完成实名后即可设置</h2>
          <p>
            {session.onboarding.kycStatus === 'PENDING'
              ? '实名认证正在审核中，通过后即可设置支付密码。'
              : '支付密码用于提现和发送群红包，请先完成实名认证。'}
          </p>
          <button
            type="button"
            className="pps-cta"
            onClick={() =>
              session.onboarding.kycStatus === 'PENDING'
                ? navigate('/support')
                : navigate('/kyc')
            }
          >
            {session.onboarding.kycStatus === 'PENDING' ? '联系客服查询' : '前往实名认证'}
          </button>
        </section>
      ) : (
        <>
          <header className="pps-hero">
            <div className="pps-hero-glow" aria-hidden />
            <span className="pps-step">{changing ? '账户安全' : '资金安全'}</span>
            <h2>{changing ? '定期更新，保护账户资金' : '设置后才能进行资金转出'}</h2>
            <p>六位数字密码，独立于登录，仅用于提现与群红包等敏感操作。</p>
          </header>

          <section className="pps-card">
            {changing && (
              <div className="pps-field">
                <span>当前支付密码</span>
                <PaymentPinInput
                  value={currentPin}
                  onChange={(value) => {
                    setCurrentPin(value);
                    setError('');
                  }}
                  disabled={busy}
                  autoFocus
                  label="当前六位支付密码"
                />
              </div>
            )}

            <div className="pps-field">
              <span>{changing ? '新支付密码' : '支付密码'}</span>
              <PaymentPinInput
                value={newPin}
                onChange={(value) => {
                  setNewPin(value);
                  setError('');
                }}
                disabled={busy}
                autoFocus={!changing}
                label="新的六位支付密码"
              />
              <small>请勿使用 123456、连续数字或六位相同数字</small>
            </div>

            <div className="pps-field">
              <span>再次确认</span>
              <PaymentPinInput
                value={confirmPin}
                onChange={(value) => {
                  setConfirmPin(value);
                  setError('');
                }}
                disabled={busy}
                label="再次输入新的六位支付密码"
              />
            </div>

            {error && (
              <div className="pps-error" role="alert">
                {error}
              </div>
            )}
          </section>

          <button
            type="button"
            className="pps-cta"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {busy ? '保存中…' : changing ? '确认修改' : '启用支付密码'}
          </button>

          {changing ? (
            <button
              type="button"
              className="pps-link"
              onClick={() => navigate('/support')}
            >
              忘记支付密码？联系客服核验重置
            </button>
          ) : (
            <div className="pps-links">
              <button type="button" onClick={() => navigate('/settings/legal')}>
                查看协议与隐私
              </button>
              <button type="button" onClick={() => navigate('/support')}>
                遇到问题？联系客服
              </button>
            </div>
          )}

          <p className="pps-tip">
            连续输错 5 次将锁定 15 分钟。客服不会向您索取完整支付密码。
          </p>
        </>
      )}
    </div>
  );
}
