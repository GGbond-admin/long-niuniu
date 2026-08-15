import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { goBack } from '../lib/nav';
import { LegalLinks } from './LegalDoc';

type KycSnapshot = Awaited<ReturnType<typeof api.me>>['kyc'];

export default function KycForm({ onDone }: { onDone: () => Promise<void> }) {
  const [form, setForm] = useState({
    realName: '',
    duitnowId: '',
  });
  const [snapshot, setSnapshot] = useState<KycSnapshot>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    setLoading(true);
    setLoadFailed(false);
    api
      .me()
      .then((me) => setSnapshot(me.kyc))
      .catch(() => setLoadFailed(true))
      .finally(() => setLoading(false));
  }, [retryKey]);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const locked = snapshot?.status === 'APPROVED' || snapshot?.status === 'PENDING';
  const valid = form.realName.length >= 2 && form.duitnowId.length >= 4 && agreed;

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api.submitKyc({
        realName: form.realName.trim(),
        duitnowId: form.duitnowId.trim(),
        agreed: true,
      });
      await onDone();
      navigate('/', { replace: true });
    } catch (e) {
      const code = (e as Error & { code?: string }).code;
      setError(code === 'ALREADY_PENDING' ? '已提交，请等待审核' : '提交失败，请检查资料');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="loading">加载中…</div>;

  if (loadFailed) {
    return (
      <div className="page subpage kyc-page">
        <header className="subpage-header">
          <button type="button" onClick={() => goBack(navigate, location)} aria-label="返回">
            ‹
          </button>
          <div>
            <span className="eyebrow">身份核验</span>
            <h1>实名认证</h1>
          </div>
          <span />
        </header>
        <section className="feature-load-error" role="alert">
          <strong>认证状态没有加载成功</strong>
          <p>请检查网络后重试，避免重复提交认证资料。</p>
          <button type="button" onClick={() => setRetryKey((key) => key + 1)}>
            重试
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="page subpage kyc-page">
      <header className="subpage-header">
        <button type="button" onClick={() => goBack(navigate, location)} aria-label="返回">
          ‹
        </button>
        <div>
          <span className="eyebrow">身份核验</span>
          <h1>实名认证</h1>
        </div>
        <span />
      </header>

      <div className="notice">
        完成实名并通过审核后，才可使用钱包交易及参与游戏。姓名须与 Touch &apos;n Go 账号完全一致，审核通过后无法自行修改。银行卡与电子钱包请在「提现账户」中单独添加。
      </div>

      {locked ? (
        <section className="form-card kyc-readonly">
          <div className="kyc-status-row">
            <span>当前状态</span>
            <strong className={`kyc-status ${snapshot?.status.toLowerCase()}`}>
              {snapshot?.status === 'APPROVED' ? '已通过' : '审核中'}
            </strong>
          </div>
          <div className="kyc-field">
            <span>真实姓名</span>
            <b>{snapshot?.realName ?? '—'}</b>
          </div>
          <div className="kyc-field">
            <span>DuitNow ID</span>
            <b>{snapshot?.duitnowIdMasked ?? '—'}</b>
          </div>
          {snapshot?.rejectReason && (
            <div className="inline-alert error">驳回原因：{snapshot.rejectReason}</div>
          )}
          {snapshot?.status === 'APPROVED' && (
            <button
              className="btn"
              type="button"
              onClick={() => navigate('/settings/banks', { state: { returnTo: '/kyc' } })}
            >
              管理提现账户
            </button>
          )}
          <button className="btn secondary" type="button" onClick={() => goBack(navigate, location)}>
            返回
          </button>
        </section>
      ) : (
        <>
          {snapshot?.status === 'REJECTED' && snapshot.rejectReason && (
            <div className="inline-alert error" style={{ marginBottom: 14 }}>
              上次驳回：{snapshot.rejectReason}。请修改后重新提交。
            </div>
          )}

          <section className="form-card kyc-form">
            <label className="field-label" htmlFor="kyc-realName">
              真实姓名（须与 Touch &apos;n Go 账号姓名完全一致）
            </label>
            <input
              id="kyc-realName"
              className="input"
              placeholder="请输入姓名"
              value={form.realName}
              onChange={set('realName')}
              autoComplete="name"
            />

            <label className="field-label" htmlFor="kyc-duitnow">
              Touch &apos;n Go eWallet DuitNow ID
            </label>
            <input
              id="kyc-duitnow"
              className="input"
              placeholder="请输入 DuitNow ID"
              value={form.duitnowId}
              onChange={set('duitnowId')}
            />

            <div className="checkbox-row">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                id="agree"
              />
              <label htmlFor="agree">
                我已阅读并同意
                <LegalLinks />
                ，确认所填信息真实准确。
              </label>
            </div>

            {error && <div className="inline-alert error">{error}</div>}

            <button className="btn" type="button" disabled={!valid || busy} onClick={() => void submit()}>
              {busy ? '提交中…' : '提交认证'}
            </button>
            <button
              className="btn secondary"
              type="button"
              disabled={busy}
              onClick={() => navigate('/', { replace: true })}
            >
              稍后认证，返回大厅
            </button>
          </section>
        </>
      )}
    </div>
  );
}
