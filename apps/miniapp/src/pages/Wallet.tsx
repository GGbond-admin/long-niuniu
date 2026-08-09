import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, rm } from '../api';
import PageHeader from '../components/PageHeader';
import {
  IconArrowUp,
  IconEye,
  IconEyeOff,
  IconList,
  IconPlus,
} from '../components/Icons';
import { formatLedgerAmount, ledgerLabel } from '../lib/ledger';

type WalletData = Awaited<ReturnType<typeof api.wallet>>;

function needsKyc(status: string) {
  return status === 'NONE' || status === 'REJECTED';
}

export default function Wallet({
  kycStatus,
  active = true,
}: {
  kycStatus: string;
  active?: boolean;
}) {
  const navigate = useNavigate();
  const approved = kycStatus === 'APPROVED';
  const pending = kycStatus === 'PENDING';
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [hidden, setHidden] = useState(false);
  const [message, setMessage] = useState('');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    if (!active) return;
    if (needsKyc(kycStatus)) {
      navigate('/kyc', { replace: true });
    }
  }, [active, kycStatus, navigate]);

  const load = useCallback(async () => {
    if (!approved) return;
    try {
      const nextWallet = await api.wallet({ scope: 'available', limit: 8 });
      setWallet(nextWallet);
      setLoadError('');
    } catch {
      setLoadError('余额刷新失败，当前显示的是上次成功加载的数据。');
    }
  }, [approved]);

  useEffect(() => {
    if (!active || !approved) return;
    void load();
    const refresh = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [active, approved, load]);

  if (needsKyc(kycStatus)) {
    return <div className="page loading">正在前往实名认证…</div>;
  }

  if (pending) {
    return (
      <div className="page wallet-page">
        <PageHeader title="钱包" subtitle="实名审核中" />
        <section className="panel panel-lg" style={{ padding: 20 }}>
          <div className="inline-alert" style={{ marginBottom: 0 }}>
            实名认证审核中。通过后即可使用钱包（充值、提现、查看余额与明细）。请留意 Bot 私聊通知。
          </div>
          <button
            className="primary-action"
            type="button"
            style={{ marginTop: 16 }}
            onClick={() => navigate('/', { replace: true })}
          >
            返回大厅
          </button>
        </section>
      </div>
    );
  }

  const total = wallet
    ? BigInt(wallet.balance.availableCents) +
      BigInt(wallet.balance.freezeBankerCents) +
      BigInt(wallet.balance.freezeBetCents) +
      BigInt(wallet.balance.freezeWithdrawCents)
    : 0n;
  const frozen = wallet
    ? BigInt(wallet.balance.freezeBankerCents) + BigInt(wallet.balance.freezeBetCents)
    : 0n;
  const withdrawFrozen = wallet ? BigInt(wallet.balance.freezeWithdrawCents) : 0n;

  function goFlow(path: '/wallet/deposit' | '/wallet/withdraw') {
    setMessage('');
    navigate(path);
  }

  return (
    <div className="page wallet-page">
      <PageHeader
        title="钱包"
        subtitle="Private Vault"
        action={
          <button className="icon-btn" type="button" onClick={() => setHidden((v) => !v)} aria-label="切换余额显示">
            {hidden ? <IconEyeOff size={18} /> : <IconEye size={18} />}
          </button>
        }
      />

      <section className="panel panel-lg balance-card wallet-balance">
        <span className="balance-label">总资产（RM）</span>
        <strong className="balance-amount">{hidden ? '••••••' : rm(total)}</strong>
        <div className="balance-grid">
          <div>
            <small>可用</small>
            <b>{hidden ? '••••' : rm(wallet?.balance.availableCents ?? 0)}</b>
          </div>
          <div>
            <small>游戏冻结</small>
            <b>{hidden ? '••••' : rm(frozen)}</b>
          </div>
          <div>
            <small>提现中</small>
            <b>{hidden ? '••••' : rm(withdrawFrozen)}</b>
          </div>
        </div>
      </section>

      <div className="wallet-actions">
        <button className="wallet-action" type="button" onClick={() => goFlow('/wallet/deposit')}>
          <span>
            <IconPlus size={16} />
          </span>
          <b>充值</b>
        </button>
        <button className="wallet-action" type="button" onClick={() => goFlow('/wallet/withdraw')}>
          <span>
            <IconArrowUp size={16} />
          </span>
          <b>提现</b>
        </button>
        <button className="wallet-action" type="button" onClick={() => navigate('/wallet/orders')}>
          <span>
            <IconList size={16} />
          </span>
          <b>工单</b>
        </button>
      </div>

      {loadError && <div className="inline-alert error">{loadError}</div>}

      {message && (
        <div className="inline-alert" style={{ marginBottom: 16 }}>
          {message}
        </div>
      )}

      <section className="section">
        <div className="section-top">
          <h2>资金明细</h2>
          <button className="text-action" type="button" onClick={() => navigate('/wallet/funds')}>
            全部 / 筛选
          </button>
        </div>
        <div className="transaction-list">
          {wallet?.entries.slice(0, 8).map((entry) => (
            <div className="transaction-row" key={entry.id}>
              <div className="transaction-icon">RM</div>
              <div>
                <strong>{ledgerLabel(entry.refType)}</strong>
                <small>{new Date(entry.createdAt).toLocaleString('zh-MY')}</small>
              </div>
              <b className={entry.direction === 'CREDIT' ? 'positive' : 'negative'}>
                {formatLedgerAmount(entry.direction, entry.amountCents)}
              </b>
            </div>
          ))}
          {(!wallet || wallet.entries.length === 0) && (
            <div className="empty-inline">暂无资金记录</div>
          )}
        </div>
      </section>
    </div>
  );
}
