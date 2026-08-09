import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import InstitutionLogo from '../components/InstitutionLogo';
import { writeSelectedWithdrawAccountId } from '../data/institutions';

type Account = Awaited<ReturnType<typeof api.withdrawAccounts>>['items'][number];
type Institution = { code: string; name: string; type: 'BANK' | 'EWALLET' };
type ReturnState = { returnTo?: string };

const statusLabel: Record<string, string> = {
  APPROVED: '已通过',
  PENDING: '审核中',
  REJECTED: '已驳回',
};

export default function WithdrawAccounts({
  kycStatus,
  purpose = 'select',
  returnTo = '/wallet/withdraw',
}: {
  kycStatus: string;
  /** select: 提现时选账户；manage: 设置中心管理账户 */
  purpose?: 'select' | 'manage';
  returnTo?: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const managing = purpose === 'manage';
  // 从「我的」进入时应回到「我的」，从设置进入才回设置
  const backTo = (location.state as ReturnState | null)?.returnTo ?? returnTo;
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [banks, setBanks] = useState<Institution[]>([]);
  const [ewallets, setEwallets] = useState<Institution[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [mode, setMode] = useState<'list' | 'add' | 'edit'>('list');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menuAccount, setMenuAccount] = useState<Account | null>(null);
  const [addType, setAddType] = useState<'BANK' | 'EWALLET'>('BANK');
  const [institution, setInstitution] = useState('');
  const [accountNo, setAccountNo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const [accountResult, institutions] = await Promise.all([
      api.withdrawAccounts(),
      api.paymentInstitutions(),
    ]);
    setAccounts(accountResult.items);
    setBanks(institutions.banks);
    setEwallets(institutions.ewallets);
    const preferred =
      accountResult.items.find((item) => item.isDefault && item.status === 'APPROVED') ??
      accountResult.items.find((item) => item.status === 'APPROVED');
    setSelectedId((prev) => {
      if (prev && accountResult.items.some((item) => item.id === prev && item.status === 'APPROVED')) {
        return prev;
      }
      try {
        const stored = sessionStorage.getItem('withdraw-selected-account-id') ?? '';
        if (stored && accountResult.items.some((item) => item.id === stored && item.status === 'APPROVED')) {
          return stored;
        }
      } catch {
        // ignore
      }
      return preferred?.id ?? '';
    });
  }, []);

  useEffect(() => {
    if (kycStatus === 'NONE' || kycStatus === 'REJECTED') {
      navigate('/kyc', { replace: true });
      return;
    }
    if (kycStatus === 'PENDING') {
      setError('实名认证审核中，通过后即可管理提现账户。');
      return;
    }
    if (kycStatus !== 'APPROVED') {
      navigate(backTo, { replace: true });
      return;
    }
    void load().catch((err) => setError((err as Error).message || '加载失败'));
  }, [kycStatus, navigate, load, backTo]);

  useEffect(() => {
    const list = addType === 'BANK' ? banks : ewallets;
    if (!list.some((item) => item.name === institution)) {
      setInstitution(list[0]?.name ?? '');
    }
  }, [addType, banks, ewallets, institution]);

  function choose(account: Account) {
    if (account.status !== 'APPROVED') return;
    setSelectedId(account.id);
    writeSelectedWithdrawAccountId(account.id);
    if (managing) {
      setMessage(`已选择 ${account.institution} 作为提现账户`);
      return;
    }
    navigate('/wallet/withdraw');
  }

  function startAdd() {
    setMode('add');
    setEditingId(null);
    setAddType('BANK');
    setAccountNo('');
    setInstitution(banks[0]?.name ?? '');
    setError('');
    setMessage('');
  }

  function openMenu(account: Account, event: MouseEvent) {
    event.stopPropagation();
    setError('');
    setMessage('');
    setMenuAccount(account);
  }

  function startEdit(account: Account) {
    setMenuAccount(null);
    setMode('edit');
    setEditingId(account.id);
    setAddType(account.type);
    setInstitution(account.institution);
    setAccountNo('');
    setError('');
    setMessage('');
  }

  async function removeAccount(account: Account) {
    if (accounts.length <= 1) {
      setMenuAccount(null);
      setError('至少保留一个到账账户');
      return;
    }
    const ok = window.confirm(`确认删除「${account.institution}」？删除后不可恢复。`);
    if (!ok) return;
    setBusy(true);
    setError('');
    setMessage('');
    setMenuAccount(null);
    try {
      await api.deleteWithdrawAccount(account.id);
      if (editingId === account.id) {
        setMode('list');
        setEditingId(null);
      }
      if (selectedId === account.id) {
        writeSelectedWithdrawAccountId('');
        setSelectedId('');
      }
      setMessage('账户已删除');
      await load();
    } catch (err) {
      const code = (err as { code?: string }).code;
      setError(
        code === 'LAST_ACCOUNT'
          ? '至少保留一个到账账户'
          : `删除失败：${(err as Error).message}`,
      );
    } finally {
      setBusy(false);
    }
  }

  function cancelForm() {
    setMode('list');
    setEditingId(null);
    setAccountNo('');
    setError('');
  }

  async function submitForm() {
    if (!institution || accountNo.trim().length < 4) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (mode === 'edit' && editingId) {
        await api.updateWithdrawAccount(editingId, {
          type: addType,
          institution,
          accountNo: accountNo.trim(),
        });
        setMessage('账号已更新并重新提交审核，通过后可继续使用。');
      } else {
        await api.addWithdrawAccount({
          type: addType,
          institution,
          accountNo: accountNo.trim(),
        });
        setMessage('账号已提交审核，通过后可选择使用。');
      }
      setMode('list');
      setEditingId(null);
      setAccountNo('');
      await load();
    } catch (err) {
      const code = (err as { code?: string }).code;
      setError(
        code === 'TOO_MANY_PENDING'
          ? '待审核账号过多，请稍后再试'
          : code === 'UNKNOWN_INSTITUTION'
            ? '请选择支持的银行或电子钱包'
            : `提交失败：${(err as Error).message}`,
      );
    } finally {
      setBusy(false);
    }
  }

  const institutionOptions = addType === 'BANK' ? banks : ewallets;
  const formOpen = mode === 'add' || mode === 'edit';

  return (
    <div className="page subpage withdraw-accounts-page">
      <header className="subpage-header">
        <button type="button" onClick={() => navigate(backTo)} aria-label="返回">
          ‹
        </button>
        <div>
          <h1>{managing ? '提现账户' : '选择到账账户'}</h1>
        </div>
        <span />
      </header>

      <p className="muted withdraw-accounts-hint">
        {managing
          ? '在此添加银行或电子钱包账号，审核通过后可用于提现。户名须与实名一致。'
          : '点选已通过账户即可切换；可修改或删除账户，修改后需重新审核。'}
      </p>

      {kycStatus === 'PENDING' && (
        <div className="inline-alert" style={{ marginBottom: 14 }}>
          实名认证审核中，通过后即可添加银行或电子钱包账号。
        </div>
      )}

      {kycStatus === 'APPROVED' && (
      <div className="withdraw-pick-list">
        {accounts.map((item) => {
          const selectable = item.status === 'APPROVED';
          const active = selectedId === item.id;
          return (
            <div
              key={item.id}
              className={`withdraw-pick-card ${active ? 'active' : ''} ${selectable ? '' : 'disabled'}`}
            >
              <button
                type="button"
                className="withdraw-pick-select"
                disabled={!selectable}
                onClick={() => choose(item)}
              >
                <InstitutionLogo name={item.institution} size={44} />
                <div className="withdraw-pick-main">
                  <div className="withdraw-pick-top">
                    <strong>{item.institution}</strong>
                    <span className={`status ${item.status.toLowerCase()}`}>
                      {statusLabel[item.status] ?? item.status}
                    </span>
                  </div>
                  <p>
                    {item.type === 'BANK' ? '银行账户' : '电子钱包'} · {item.accountNoMasked}
                  </p>
                  <small>
                    户名 {item.accountName}
                    {item.isDefault ? ' · 默认' : ''}
                    {item.status === 'REJECTED' && item.rejectReason ? ` · ${item.rejectReason}` : ''}
                  </small>
                </div>
                {active && <em className="withdraw-pick-check">✓</em>}
              </button>
              <button
                type="button"
                className="withdraw-more-btn"
                disabled={busy}
                aria-label="账户操作"
                onClick={(event) => openMenu(item, event)}
              >
                <span />
                <span />
                <span />
              </button>
            </div>
          );
        })}
        {accounts.length === 0 && <div className="empty-inline">暂无账户，请先添加</div>}
      </div>
      )}

      {kycStatus === 'APPROVED' && !formOpen ? (
        <button className="deposit-secondary-btn" type="button" onClick={startAdd}>
          + 添加新账号
        </button>
      ) : kycStatus === 'APPROVED' && formOpen ? (
        <section className="withdraw-add-box">
          <div className="section-top">
            <h2>{mode === 'edit' ? '修改账号' : '添加新账号'}</h2>
            <button className="text-link-btn withdraw-add-link" type="button" onClick={cancelForm}>
              取消
            </button>
          </div>

          <label className="field-label">账号类型</label>
          <div className="channel-toggle">
            <button
              className={addType === 'BANK' ? 'active' : ''}
              type="button"
              onClick={() => setAddType('BANK')}
            >
              银行
            </button>
            <button
              className={addType === 'EWALLET' ? 'active' : ''}
              type="button"
              onClick={() => setAddType('EWALLET')}
            >
              电子钱包
            </button>
          </div>

          <label className="field-label">{addType === 'BANK' ? '选择银行' : '选择电子钱包'}</label>
          <div className="withdraw-institution-grid">
            {institutionOptions.map((item) => (
              <button
                key={item.code}
                type="button"
                className={`withdraw-institution-chip ${institution === item.name ? 'active' : ''}`}
                onClick={() => setInstitution(item.name)}
              >
                <InstitutionLogo name={item.name} size={28} />
                <span>{item.name}</span>
              </button>
            ))}
          </div>

          <label className="field-label">
            {addType === 'BANK' ? '银行账号' : '钱包账号 / DuitNow / 手机号'}
          </label>
          <input
            className="withdraw-input"
            value={accountNo}
            onChange={(e) => setAccountNo(e.target.value)}
            placeholder={
              mode === 'edit'
                ? '请输入新的完整账号（安全起见需重新填写）'
                : addType === 'BANK'
                  ? '请输入银行账号'
                  : '请输入钱包账号或手机号'
            }
          />

          <p className="muted wallet-flow-copy">
            户名须与实名一致。
            {mode === 'edit' ? '修改后将重新进入审核，通过后才可用于提现。' : '新增账号需后台审核通过后才可使用。'}
          </p>

          {error && <div className="inline-alert error">{error}</div>}
          {message && <div className="inline-alert">{message}</div>}

          <button
            className="primary-action"
            type="button"
            disabled={busy || !institution || accountNo.trim().length < 4}
            onClick={() => void submitForm()}
          >
            {busy ? '提交中…' : mode === 'edit' ? '保存并重新审核' : '提交审核'}
          </button>
        </section>
      ) : null}

      {error && !formOpen && <div className="inline-alert error">{error}</div>}
      {message && !formOpen && <div className="inline-alert">{message}</div>}

      {menuAccount && (
        <div className="withdraw-sheet" role="dialog" aria-modal="true" aria-label="账户操作">
          <button
            type="button"
            className="withdraw-sheet-backdrop"
            aria-label="关闭"
            onClick={() => setMenuAccount(null)}
          />
          <div className="withdraw-sheet-panel">
            <div className="withdraw-sheet-handle" />
            <div className="withdraw-sheet-head">
              <InstitutionLogo name={menuAccount.institution} size={40} />
              <div>
                <strong>{menuAccount.institution}</strong>
                <p>
                  {menuAccount.type === 'BANK' ? '银行账户' : '电子钱包'} · {menuAccount.accountNoMasked}
                </p>
              </div>
            </div>
            <div className="withdraw-sheet-actions">
              <button type="button" disabled={busy} onClick={() => startEdit(menuAccount)}>
                <span className="withdraw-sheet-icon" aria-hidden>
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
                    <path
                      d="M4 16.5V20h3.5L18 9.5 14.5 6 4 16.5Z"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinejoin="round"
                    />
                    <path d="M12.8 7.7l3.5 3.5" stroke="currentColor" strokeWidth="1.7" />
                  </svg>
                </span>
                <span>
                  <b>修改账号</b>
                  <small>修改后需重新审核</small>
                </span>
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy || accounts.length <= 1}
                onClick={() => void removeAccount(menuAccount)}
              >
                <span className="withdraw-sheet-icon trash" aria-hidden>
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
                    <path
                      d="M5 7h14M9 7V5h6v2M8 7l1 12h6l1-12"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <span>
                  <b>删除账号</b>
                  <small>{accounts.length <= 1 ? '至少保留一个账户' : '删除后不可恢复'}</small>
                </span>
              </button>
            </div>
            <button
              type="button"
              className="withdraw-sheet-cancel"
              onClick={() => setMenuAccount(null)}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
