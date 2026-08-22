import { useEffect, useRef, useState } from 'react';
import { del, post, request, rm } from '../api';
import type { BatchStatus, BatchSummary, ProfitPoolRoom } from './types';

const STATUS: Record<BatchStatus, { label: string; tone: string }> = {
  PENDING: { label: '待分配', tone: 'pending' },
  DISTRIBUTED: { label: '已分配', tone: 'done' },
  NO_DISTRIBUTION: { label: '无需分配', tone: 'none' },
  VOIDED: { label: '已撤回', tone: 'voided' },
};

function errorText(error: unknown) {
  return error instanceof Error ? error.message : '加载失败，请重试';
}

interface LegacyPoolSummary {
  id: string;
  date: string;
  status: 'PENDING' | 'SETTLED' | 'NO_DISTRIBUTION';
  turnoverCents: string;
  netPoolCents: string;
  distributedCents: string;
  shareCount: number;
  createdAt: string;
}

export default function BatchHistory({
  refreshKey,
  onSelect,
  onError,
  onChanged,
  compact = false,
}: {
  refreshKey: number;
  onSelect: (poolId: string) => void;
  onError: (message: string) => void;
  onChanged?: () => void;
  compact?: boolean;
}) {
  const [items, setItems] = useState<BatchSummary[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<BatchStatus | ''>('');
  const [rooms, setRooms] = useState<ProfitPoolRoom[]>([]);
  const [roomId, setRoomId] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [legacyItems, setLegacyItems] = useState<LegacyPoolSummary[]>([]);
  const [legacyCursor, setLegacyCursor] = useState<string | null>(null);
  const [loadingLegacyMore, setLoadingLegacyMore] = useState(false);
  const [voiding, setVoiding] = useState<BatchSummary | null>(null);
  const [deleting, setDeleting] = useState<BatchSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const queryVersion = useRef(0);

  useEffect(() => {
    const version = ++queryVersion.current;
    const controller = new AbortController();
    setLoadingMore(false);
    setLoading(true);
    setItems([]);
    setNextCursor(null);
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ limit: compact ? '8' : '50' });
      if (q.trim()) params.set('q', q.trim());
      if (status) params.set('status', status);
      if (roomId) params.set('roomId', roomId);
      request<{ items: BatchSummary[]; nextCursor: string | null }>(
        `/api/admin/profit-pool/history?${params}`,
        { signal: controller.signal },
      )
        .then((result) => {
          if (version === queryVersion.current) {
            setItems(result.items);
            setNextCursor(result.nextCursor);
          }
        })
        .catch((error) => {
          if (
            version === queryVersion.current
            && (error as Error).name !== 'AbortError'
          ) {
            onError(errorText(error));
          }
        })
        .finally(() => {
          if (version === queryVersion.current) setLoading(false);
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      queryVersion.current += 1;
    };
  }, [q, status, roomId, refreshKey, compact, onError]);

  useEffect(() => {
    if (compact) return;
    const controller = new AbortController();
    request<{ items: ProfitPoolRoom[] }>('/api/admin/profit-pool/rooms', {
      signal: controller.signal,
    })
      .then((result) => setRooms(result.items))
      .catch((error) => {
        if ((error as Error).name !== 'AbortError') onError(errorText(error));
      });
    return () => controller.abort();
  }, [compact, onError]);

  useEffect(() => {
    if (compact) return;
    const controller = new AbortController();
    request<{ items: LegacyPoolSummary[]; nextCursor: string | null }>(
      '/api/admin/profit-pool/legacy/history?limit=50',
      { signal: controller.signal },
    )
      .then((result) => {
        setLegacyItems(result.items);
        setLegacyCursor(result.nextCursor);
      })
      .catch((error) => {
        if ((error as Error).name !== 'AbortError') onError(errorText(error));
      });
    return () => controller.abort();
  }, [compact, refreshKey, onError]);

  async function loadMore() {
    if (!nextCursor || loading || loadingMore) return;
    const version = queryVersion.current;
    const cursor = nextCursor;
    const params = new URLSearchParams({ limit: '50', cursor });
    if (q.trim()) params.set('q', q.trim());
    if (status) params.set('status', status);
    if (roomId) params.set('roomId', roomId);
    setLoadingMore(true);
    try {
      const result = await request<{
        items: BatchSummary[];
        nextCursor: string | null;
      }>(`/api/admin/profit-pool/history?${params}`);
      if (version !== queryVersion.current) return;
      setItems((current) => [
        ...current,
        ...result.items.filter((item) => !current.some((row) => row.id === item.id)),
      ]);
      setNextCursor(result.nextCursor);
    } catch (error) {
      if (version === queryVersion.current) onError(errorText(error));
    } finally {
      if (version === queryVersion.current) setLoadingMore(false);
    }
  }

  async function loadMoreLegacy() {
    if (!legacyCursor || loadingLegacyMore) return;
    setLoadingLegacyMore(true);
    try {
      const result = await request<{
        items: LegacyPoolSummary[];
        nextCursor: string | null;
      }>(
        `/api/admin/profit-pool/legacy/history?limit=50&cursor=${encodeURIComponent(legacyCursor)}`,
      );
      setLegacyItems((current) => [
        ...current,
        ...result.items.filter((item) => !current.some((row) => row.id === item.id)),
      ]);
      setLegacyCursor(result.nextCursor);
    } catch (error) {
      onError(errorText(error));
    } finally {
      setLoadingLegacyMore(false);
    }
  }

  async function discard(item: BatchSummary) {
    setBusy(true);
    onError('');
    try {
      await post(`/api/admin/profit-pool/batches/${item.id}/discard`, {});
      setVoiding(null);
      setItems((current) =>
        current.map((row) => (row.id === item.id ? { ...row, status: 'VOIDED' } : row)),
      );
      onChanged?.();
    } catch (error) {
      onError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: BatchSummary) {
    setBusy(true);
    onError('');
    try {
      await del(`/api/admin/profit-pool/batches/${item.id}`);
      setDeleting(null);
      setItems((current) => current.filter((row) => row.id !== item.id));
      onChanged?.();
    } catch (error) {
      onError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`ppx-history ${compact ? 'compact' : ''}`}>
      <header className="ppx-history-head">
        <div>
          <small>SETTLEMENT ARCHIVE</small>
          <h2>{compact ? '最近利润池' : '利润池历史'}</h2>
        </div>
        {!compact && (
          <div className="ppx-history-filters">
            <label>
              <span className="sr-only">搜索利润池编号</span>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m16 16 4 4" />
              </svg>
              <input
                value={q}
                onChange={(event) => setQ(event.target.value)}
                placeholder="输入利润池编号"
              />
            </label>
            <select
              aria-label="按房间筛选"
              value={roomId}
              onChange={(event) => setRoomId(event.target.value)}
            >
              <option value="">全部房间</option>
              {rooms.map((room) => (
                <option value={room.id} key={room.id}>
                  {room.title}
                </option>
              ))}
            </select>
            <select
              aria-label="按状态筛选"
              value={status}
              onChange={(event) => setStatus(event.target.value as BatchStatus | '')}
            >
              <option value="">全部状态</option>
              <option value="PENDING">待分配</option>
              <option value="DISTRIBUTED">已分配</option>
              <option value="NO_DISTRIBUTION">无需分配</option>
              <option value="VOIDED">已撤回</option>
            </select>
          </div>
        )}
      </header>

      <div className="ppx-history-table-wrap" aria-busy={loading}>
        <table className="ppx-history-table">
          <thead>
            <tr>
              <th>利润池编号</th>
              <th>结算范围（局数）</th>
              <th>总流水</th>
              <th>利润池金额</th>
              <th>代理分配</th>
              <th>状态</th>
              <th>生成时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const state = STATUS[item.status];
              return (
                <tr key={item.id}>
                  <td>
                    <button
                      type="button"
                      className="ppx-code-link"
                      onClick={() => onSelect(item.id)}
                    >
                      {item.poolCode}
                    </button>
                    <small>游戏 · {item.room.title}</small>
                  </td>
                  <td>
                    <strong>{item.startSeqNo} – {item.endSeqNo}</strong>
                    <small>共 {item.roundCount} 局</small>
                  </td>
                  <td>RM {rm(item.turnoverCents)}</td>
                  <td><strong>RM {rm(item.netPoolCents)}</strong></td>
                  <td>RM {rm(item.distributedCents)}</td>
                  <td>
                    <span className={`ppx-batch-status ${state.tone}`}>
                      {state.label}
                    </span>
                  </td>
                  <td>
                    {new Date(item.generatedAt).toLocaleString('zh-MY', {
                      hour12: false,
                    })}
                  </td>
                  <td>
                    <div className="ppx-row-actions">
                      <button
                        type="button"
                        className="ppx-row-action"
                        onClick={() => onSelect(item.id)}
                      >
                        查看报表
                      </button>
                      {item.status !== 'VOIDED' && (
                        <button
                          type="button"
                          className="ppx-row-void"
                          disabled={busy}
                          onClick={() => setVoiding(item)}
                        >
                          {item.status === 'DISTRIBUTED' ? '强制撤回' : '撤回'}
                        </button>
                      )}
                      {item.status === 'VOIDED' && (
                        <button
                          type="button"
                          className="ppx-row-void"
                          disabled={busy}
                          onClick={() => setDeleting(item)}
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!loading && items.length === 0 && (
          <div className="ppx-empty">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 6h16v14H4zM8 3h8v3M8 11h8M8 15h5" />
            </svg>
            <strong>暂无符合条件的利润池</strong>
            <span>完成第一批局数结算后，历史记录会显示在这里。</span>
          </div>
        )}
        {!compact && nextCursor && (
          <div className="ppx-history-more">
            <button
              type="button"
              disabled={loading || loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? '正在加载…' : '加载更多历史批次'}
            </button>
          </div>
        )}
      </div>
      {!compact && legacyItems.length > 0 && (
        <section className="ppx-legacy-archive">
          <header>
            <div>
              <small>LEGACY DAILY ARCHIVE</small>
              <h3>旧版按日结算历史</h3>
            </div>
            <span>永久只读 · 已计入代理累计利润</span>
          </header>
          <div className="ppx-history-table-wrap">
            <table className="ppx-history-table">
              <thead>
                <tr>
                  <th>结算日期</th>
                  <th>总流水</th>
                  <th>利润池金额</th>
                  <th>代理分配</th>
                  <th>代理数</th>
                  <th>状态</th>
                  <th>生成时间</th>
                </tr>
              </thead>
              <tbody>
                {legacyItems.map((item) => (
                  <tr key={item.id}>
                    <td><strong>{item.date}</strong></td>
                    <td>RM {rm(item.turnoverCents)}</td>
                    <td><strong>RM {rm(item.netPoolCents)}</strong></td>
                    <td>RM {rm(item.distributedCents)}</td>
                    <td>{item.shareCount}</td>
                    <td>
                      <span className={`ppx-batch-status ${
                        item.status === 'SETTLED'
                          ? 'done'
                          : item.status === 'PENDING'
                            ? 'pending'
                            : 'none'
                      }`}>
                        {item.status === 'SETTLED'
                          ? '已分配'
                          : item.status === 'PENDING'
                            ? '待迁移处理'
                            : '无需分配'}
                      </span>
                    </td>
                    <td>
                      {new Date(item.createdAt).toLocaleString('zh-MY', {
                        hour12: false,
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {legacyCursor && (
              <div className="ppx-history-more">
                <button
                  type="button"
                  disabled={loadingLegacyMore}
                  onClick={() => void loadMoreLegacy()}
                >
                  {loadingLegacyMore ? '正在加载…' : '加载更多旧版日报'}
                </button>
              </div>
            )}
          </div>
        </section>
      )}

      {voiding && (
        <div className="ppx-modal-backdrop" role="presentation">
          <div
            className="ppx-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ppx-history-void-title"
          >
            <span className="ppx-modal-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3 2.8 20h18.4L12 3Z" />
                <path d="M12 9v5M12 17.5v.1" />
              </svg>
            </span>
            <small>{voiding.status === 'DISTRIBUTED' ? 'FORCE CLAWBACK' : 'RELEASE ROUND LOCKS'}</small>
            <h3 id="ppx-history-void-title">
              {voiding.status === 'DISTRIBUTED'
                ? `强制撤回 ${voiding.poolCode}？`
                : `撤回 ${voiding.poolCode}？`}
            </h3>
            <p>
              {voiding.status === 'DISTRIBUTED'
                ? `将从代理可用余额扣回已发放的 RM ${rm(voiding.distributedCents)}，并释放第 ${voiding.startSeqNo}–${voiding.endSeqNo} 局。若有代理余额不足，整笔撤回会失败、不会部分扣款。`
                : `将释放第 ${voiding.startSeqNo}–${voiding.endSeqNo} 局的局锁，之后可以重新生成。资金尚未入账，代理余额不会变动。`}
            </p>
            <div>
              <button type="button" disabled={busy} onClick={() => setVoiding(null)}>
                取消
              </button>
              <button
                type="button"
                className="primary danger-confirm"
                disabled={busy}
                onClick={() => void discard(voiding)}
              >
                {busy
                  ? '正在撤回…'
                  : voiding.status === 'DISTRIBUTED'
                    ? '确认强制撤回并扣回资金'
                    : '确认撤回'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleting && (
        <div className="ppx-modal-backdrop" role="presentation">
          <div
            className="ppx-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ppx-history-delete-title"
          >
            <span className="ppx-modal-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3 2.8 20h18.4L12 3Z" />
                <path d="M12 9v5M12 17.5v.1" />
              </svg>
            </span>
            <small>PERMANENT DELETE</small>
            <h3 id="ppx-history-delete-title">删除 {deleting.poolCode}？</h3>
            <p>
              将永久删除该已撤回利润池的报表快照，历史列表不再显示。局锁已在撤回时释放，代理余额不会再变动。此操作不可恢复。
            </p>
            <div>
              <button type="button" disabled={busy} onClick={() => setDeleting(null)}>
                取消
              </button>
              <button
                type="button"
                className="primary danger-confirm"
                disabled={busy}
                onClick={() => void remove(deleting)}
              >
                {busy ? '正在删除…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
