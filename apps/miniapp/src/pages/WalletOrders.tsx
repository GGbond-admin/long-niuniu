import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, rm } from '../api';
import { backToTab } from '../lib/nav';

type Orders = Awaited<ReturnType<typeof api.walletOrders>>;

export default function WalletOrders() {
  const navigate = useNavigate();
  const location = useLocation();
  const [orders, setOrders] = useState<Orders | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .walletOrders()
      .then(setOrders)
      .catch((err) => setError((err as Error).message || '工单加载失败'))
      .finally(() => setLoading(false));
  }, []);

  const rows = [
    ...(orders?.deposits ?? []).map((item) => ({ ...item, kind: '充值' as const })),
    ...(orders?.withdrawals ?? []).map((item) => ({ ...item, kind: '提现' as const })),
  ].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));

  return (
    <div className="page subpage">
      <header className="subpage-header">
        <button
          type="button"
          onClick={() => backToTab(navigate, location, 'wallet')}
          aria-label="返回"
        >
          ‹
        </button>
        <div>
          <h1>我的工单</h1>
        </div>
        <span />
      </header>

      <p className="muted" style={{ marginBottom: 16, fontSize: 13, lineHeight: 1.5 }}>
        查看充值与提现申请进度。如有疑问，可前往在线客服协助。
      </p>

      {loading && <div className="empty-inline">加载中…</div>}
      {error && <div className="inline-alert error">{error}</div>}

      {!loading && !error && (
        <div className="transaction-list">
          {rows.length === 0 ? (
            <div className="empty-inline">暂无工单</div>
          ) : (
            rows.map((order) => (
              <div className="transaction-row" key={order.id}>
                <div className="transaction-icon">{order.kind === '充值' ? '+' : '↑'}</div>
                <div>
                  <strong>
                    {order.kind} RM {rm(order.amountCents)}
                  </strong>
                  <small>{new Date(order.createdAt).toLocaleString('zh-MY')}</small>
                  {order.kind === '提现' && order.status !== 'REJECTED' && (
                    <small>
                      {order.status === 'COMPLETED' ? '实际' : '预计'}到账 RM{' '}
                      {rm(order.netCents)}
                      {order.feeCents !== '0'
                        ? ` · 手续费 RM ${rm(order.feeCents)}`
                        : ' · 免手续费'}
                    </small>
                  )}
                  {order.status === 'REJECTED' && order.rejectReason && (
                    <small className="reject-reason">驳回原因：{order.rejectReason}</small>
                  )}
                  {order.kind === '提现' && order.status === 'REJECTED' && (
                    <small>提现金额已退回可用余额</small>
                  )}
                </div>
                <span className={`status ${order.status.toLowerCase()}`}>
                  {{ PENDING: '待处理', COMPLETED: '已完成', REJECTED: '已驳回' }[order.status] ??
                    order.status}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
