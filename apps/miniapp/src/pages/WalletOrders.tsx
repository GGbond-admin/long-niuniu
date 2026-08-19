import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, rm } from '../api';
import { formatDateTime } from '../lib/datetime';
import { backToTab } from '../lib/nav';
import { openExternalLink } from '../telegram';

type Orders = Awaited<ReturnType<typeof api.walletOrders>>;

function mergeById<T extends { id: string }>(current: T[], older: T[]): T[] {
  return Array.from(
    new Map([...current, ...older].map((item) => [item.id, item])).values(),
  );
}

export default function WalletOrders() {
  const navigate = useNavigate();
  const location = useLocation();
  const [orders, setOrders] = useState<Orders | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState('');

  useEffect(() => {
    api
      .walletOrders()
      .then(setOrders)
      .catch((err) => setError((err as Error).message || '工单加载失败'))
      .finally(() => setLoading(false));
  }, []);

  async function loadOlder() {
    if (!orders || loadingOlder) return;
    if (!orders.nextCursor) return;
    setLoadingOlder(true);
    setOlderError('');
    try {
      const page = await api.walletOrders({ cursor: orders.nextCursor });
      setOrders((current) => {
        if (!current) return current;
        return {
          deposits: mergeById(current.deposits, page.deposits),
          withdrawals: mergeById(current.withdrawals, page.withdrawals),
          nextCursor: page.nextCursor,
        };
      });
    } catch (err) {
      setOlderError((err as Error).message || '更早工单加载失败');
    } finally {
      setLoadingOlder(false);
    }
  }

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
                  <small>{formatDateTime(order.createdAt)}</small>
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
                  {order.kind === '充值' && order.status === 'PENDING' && order.payUrl && (
                    <button
                      type="button"
                      className="text-link-btn"
                      onClick={() => openExternalLink(order.payUrl!)}
                    >
                      继续支付
                    </button>
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
      {olderError && <div className="inline-alert error">{olderError}</div>}
      {!loading &&
        !error &&
        orders?.nextCursor && (
          <button
            type="button"
            className="fd-more"
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
          >
            {loadingOlder ? '加载中…' : '加载更早工单'}
          </button>
        )}
    </div>
  );
}
