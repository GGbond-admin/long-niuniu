import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import {
  LEDGER_FILTERS,
  formatLedgerAmount,
  type LedgerCategory,
  ledgerLabel,
} from '../lib/ledger';

type Entry = Awaited<ReturnType<typeof api.wallet>>['entries'][number];

export default function FundDetails() {
  const navigate = useNavigate();
  const [category, setCategory] = useState<LedgerCategory>('all');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const requestIdRef = useRef(0);

  const load = useCallback(
    async (nextCategory: LedgerCategory, nextCursor?: string | null) => {
      const requestId = ++requestIdRef.current;
      const appending = Boolean(nextCursor);
      if (appending) setLoadingMore(true);
      else setLoading(true);
      setError('');
      try {
        const result = await api.wallet({
          category: nextCategory,
          scope: 'available',
          limit: 30,
          cursor: nextCursor || undefined,
        });
        if (requestId !== requestIdRef.current) return;
        setEntries((prev) => (appending ? [...prev, ...result.entries] : result.entries));
        setCursor(result.nextCursor ?? null);
      } catch (reason) {
        if (requestId !== requestIdRef.current) return;
        const code = (reason as { code?: string }).code;
        if (code === 'KYC_REQUIRED' || code === 'KYC_PENDING') {
          navigate('/kyc', { replace: true });
          return;
        }
        setError((reason as Error).message || '加载失败');
      } finally {
        if (requestId !== requestIdRef.current) return;
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [navigate],
  );

  useEffect(() => {
    void load(category);
  }, [category, load]);

  return (
    <div className="page subpage fd-page">
      <header className="subpage-header">
        <button type="button" onClick={() => navigate(-1)} aria-label="返回">
          ‹
        </button>
        <div>
          <h1>资金明细</h1>
        </div>
        <span />
      </header>

      <section className="fd-intro">
        <strong>可用余额变动记录</strong>
        <p>含充值、提现、佣金、奖励、对局结算、费用、退款与调账</p>
      </section>

      <div className="fd-filters" role="tablist" aria-label="资金类型">
        {LEDGER_FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={category === item.key}
            className={category === item.key ? 'active' : ''}
            onClick={() => setCategory(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error && <div className="inline-alert error">{error}</div>}

      <section className="fd-list-panel">
        {loading && (
          <div className="fd-skeleton" aria-hidden>
            {Array.from({ length: 5 }).map((_, i) => (
              <div className="fd-skeleton-row" key={i} />
            ))}
          </div>
        )}

        {!loading && entries.length > 0 && (
          <div className="fd-list">
            {entries.map((entry) => {
              const credit = entry.direction === 'CREDIT';
              return (
                <article className="fd-row" key={entry.id}>
                  <div className={`fd-icon ${credit ? 'in' : 'out'}`}>{credit ? '+' : '−'}</div>
                  <div className="fd-copy">
                    <strong>{ledgerLabel(entry.refType)}</strong>
                    <small>
                      {new Date(entry.createdAt).toLocaleString('zh-MY')}
                      {entry.memo ? ` · ${entry.memo}` : ''}
                    </small>
                  </div>
                  <b className={credit ? 'positive' : 'negative'}>
                    {formatLedgerAmount(entry.direction, entry.amountCents)}
                  </b>
                </article>
              );
            })}
          </div>
        )}

        {!loading && entries.length === 0 && !error && (
          <div className="fd-empty">
            <strong>暂无相关记录</strong>
            <p>切换上方筛选，或完成充值 / 对局后查看</p>
          </div>
        )}

        {!loading && cursor && (
          <button
            type="button"
            className="fd-more"
            disabled={loadingMore}
            onClick={() => void load(category, cursor)}
          >
            {loadingMore ? '加载中…' : '加载更多'}
          </button>
        )}
      </section>
    </div>
  );
}
