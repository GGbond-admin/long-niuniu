import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { request, rm } from '../api';
import AgentDashboardPanel from './AgentDashboardPanel';
import type { AgentNetwork, BatchSummary, NetworkAgent } from './types';

function errorText(error: unknown) {
  return error instanceof Error ? error.message : '代理网络加载失败';
}

function NetworkBranch({
  node,
  childrenByParent,
  collapsed,
  visible,
  onToggle,
  onOpen,
}: {
  node: NetworkAgent;
  childrenByParent: Map<string | null, NetworkAgent[]>;
  collapsed: Set<string>;
  visible: Set<string> | null;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  if (visible && !visible.has(node.id)) return null;
  const children = childrenByParent.get(node.id) ?? [];
  const isCollapsed = collapsed.has(node.id);
  return (
    <li className="ppx-network-branch">
      <article className={`ppx-network-node ${node.online ? 'is-online' : ''}`}>
        <header>
          <span className="ppx-network-avatar">
            {(node.nickname ?? node.label).slice(0, 1).toUpperCase()}
            <i />
          </span>
          <div>
            <span className="ppx-node-level">L{node.level}</span>
            <button type="button" onClick={() => onOpen(node.id)}>
              {node.label}
            </button>
            <small>UID {node.uid}</small>
          </div>
          <span className={`ppx-node-presence ${node.online ? 'online' : ''}`}>
            {node.online ? '在线' : '离线'}
          </span>
        </header>
        <div className="ppx-node-profit">
          <small>本期利润</small>
          <strong>RM {rm(node.profitCents)}</strong>
          <span>
            {node.lifetimeProfitCents === null
              ? '历史批次快照'
              : `累计 RM ${rm(node.lifetimeProfitCents)}`}
          </span>
        </div>
        <dl>
          <div><dt>占成</dt><dd>{node.sharePoints}/{node.bucketBase}</dd></div>
          <div><dt>代理数</dt><dd>{node.directAgentCount} 直属 · {node.teamAgentCount} 团队</dd></div>
          <div><dt>玩家数</dt><dd>{node.directPlayerCount} 直属 · {node.teamPlayerCount} 团队</dd></div>
          <div><dt>团队在线</dt><dd>{node.onlineTeamCount}</dd></div>
          <div><dt>团队流水</dt><dd>RM {rm(node.teamTurnoverCents)}</dd></div>
        </dl>
        <footer>
          <button type="button" onClick={() => onOpen(node.id)}>
            打开专属看板
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
          </button>
          {children.length > 0 && (
            <button
              type="button"
              className="ppx-collapse-button"
              aria-expanded={!isCollapsed}
              onClick={() => onToggle(node.id)}
            >
              {isCollapsed ? `展开 ${children.length}` : '收起下级'}
            </button>
          )}
        </footer>
      </article>
      {children.length > 0 && !isCollapsed && (
        <ol>
          {children.map((child) => (
            <NetworkBranch
              key={child.id}
              node={child}
              childrenByParent={childrenByParent}
              collapsed={collapsed}
              visible={visible}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))}
        </ol>
      )}
    </li>
  );
}

export default function AgentNetworkScreen({
  onError,
}: {
  onError: (message: string) => void;
}) {
  const [network, setNetwork] = useState<AgentNetwork | null>(null);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [batchCursor, setBatchCursor] = useState<string | null>(null);
  const [loadingBatchOptions, setLoadingBatchOptions] = useState(false);
  const [poolId, setPoolId] = useState('');
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const loadVersion = useRef(0);

  const load = useCallback(async (silent = false) => {
    const version = ++loadVersion.current;
    if (!silent) setLoading(true);
    try {
      const query = poolId ? `?poolId=${encodeURIComponent(poolId)}` : '';
      const result = await request<AgentNetwork>(
        `/api/admin/profit-pool/network${query}`,
      );
      if (version === loadVersion.current) {
        setNetwork(result);
        setLastUpdated(new Date());
      }
    } catch (error) {
      if (version === loadVersion.current) onError(errorText(error));
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [poolId, onError]);

  useEffect(() => {
    const controller = new AbortController();
    void request<{ items: BatchSummary[]; nextCursor: string | null }>(
      '/api/admin/profit-pool/history?limit=100',
      { signal: controller.signal },
    )
      .then((result) => {
        setBatches(result.items);
        setBatchCursor(result.nextCursor);
      })
      .catch((error) => {
        if ((error as Error).name !== 'AbortError') onError(errorText(error));
      });
    return () => controller.abort();
  }, [onError]);

  useEffect(() => {
    void load();
    if (poolId) {
      return () => {
        loadVersion.current += 1;
      };
    }
    const timer = window.setInterval(() => void load(true), 15_000);
    return () => {
      window.clearInterval(timer);
      loadVersion.current += 1;
    };
  }, [load, poolId]);

  useEffect(() => {
    if (!fullscreen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [fullscreen]);

  const childrenByParent = useMemo(() => {
    const result = new Map<string | null, NetworkAgent[]>();
    const ids = new Set(network?.nodes.map((node) => node.id) ?? []);
    for (const node of network?.nodes ?? []) {
      const parent = node.parentId && ids.has(node.parentId) ? node.parentId : null;
      const list = result.get(parent) ?? [];
      list.push(node);
      result.set(parent, list);
    }
    for (const list of result.values()) {
      list.sort((a, b) => {
        const left = BigInt(a.teamProfitCents);
        const right = BigInt(b.teamProfitCents);
        return left === right ? a.label.localeCompare(b.label) : right > left ? 1 : -1;
      });
    }
    return result;
  }, [network?.nodes]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query || !network) return null;
    const byId = new Map(network.nodes.map((node) => [node.id, node]));
    const result = new Set<string>();
    for (const node of network.nodes) {
      if (
        !`${node.label} ${node.nickname ?? ''} ${node.uid}`
          .toLowerCase()
          .includes(query)
      ) {
        continue;
      }
      result.add(node.id);
      let parentId = node.parentId;
      while (parentId && byId.has(parentId)) {
        result.add(parentId);
        parentId = byId.get(parentId)?.parentId ?? null;
      }
    }
    return result;
  }, [network, search]);
  const displayCollapsed = useMemo(
    () => (search.trim() ? new Set<string>() : collapsed),
    [collapsed, search],
  );

  const remainingRatio = network?.batch
    ? Math.max(
        0,
        Math.min(
          100,
          network.batch.companyRemainingPointsHundredths /
            network.batch.bucketBase,
        ),
      )
    : 100;

  function toggle(id: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function loadMoreBatchOptions() {
    if (!batchCursor || loadingBatchOptions) return;
    setLoadingBatchOptions(true);
    try {
      const result = await request<{
        items: BatchSummary[];
        nextCursor: string | null;
      }>(
        `/api/admin/profit-pool/history?limit=100&cursor=${encodeURIComponent(batchCursor)}`,
      );
      setBatches((current) => [
        ...current,
        ...result.items.filter((item) => !current.some((row) => row.id === item.id)),
      ]);
      setBatchCursor(result.nextCursor);
    } catch (error) {
      onError(errorText(error));
    } finally {
      setLoadingBatchOptions(false);
    }
  }

  return (
    <section className={`ppx-network ${fullscreen ? 'is-fullscreen' : ''}`}>
      <header className="ppx-network-head">
        <div className="ppx-network-brand">
          <span className="ppx-network-mark">
            <i />
            <i />
            <i />
          </span>
          <div>
            <small>AGENT PROFIT COMMAND</small>
            <h2>代理利润网络</h2>
            <p>全层级关系、在线状态、团队规模与利润贡献实时总览</p>
          </div>
        </div>
        <div className="ppx-network-controls">
          <label className="ppx-network-search">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m16 16 4 4" />
            </svg>
            <span className="sr-only">搜索代理</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索代理、昵称或 UID"
            />
          </label>
          <select
            aria-label="选择实时或历史利润池"
            value={poolId}
            onChange={(event) => {
              setPoolId(event.target.value);
              setCollapsed(new Set());
            }}
          >
            <option value="">实时代理网络</option>
            {batches.map((batch) => (
              <option key={batch.id} value={batch.id}>
                {batch.poolCode} · {batch.startSeqNo}-{batch.endSeqNo} 局
              </option>
            ))}
          </select>
          {batchCursor && (
            <button
              type="button"
              disabled={loadingBatchOptions}
              onClick={() => void loadMoreBatchOptions()}
            >
              {loadingBatchOptions ? '加载中…' : '更多历史'}
            </button>
          )}
          <button type="button" onClick={() => void load()}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20 6v5h-5M4 18v-5h5" />
              <path d="M18.5 9A7 7 0 0 0 6 6.5L4 9m16 6-2 2.5A7 7 0 0 1 5.5 15" />
            </svg>
            刷新
          </button>
          <button type="button" className="accent" onClick={() => setFullscreen(!fullscreen)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {fullscreen ? (
                <path d="M9 4v5H4m11-5v5h5M9 20v-5H4m11 5v-5h5" />
              ) : (
                <path d="M4 9V4h5m11 5V4h-5M4 15v5h5m11-5v5h-5" />
              )}
            </svg>
            {fullscreen ? '退出大屏' : '进入大屏'}
          </button>
        </div>
      </header>

      <div className="ppx-network-signal">
        <div
          className="ppx-retention-dial"
          style={{ '--retention': `${remainingRatio * 3.6}deg` } as CSSProperties}
        >
          <span>
            <strong>
              {network?.batch
                ? (network.batch.companyRemainingPointsHundredths / 100).toFixed(2)
                : '130.00'}
            </strong>
            <small>/ {network?.batch?.bucketBase ?? 130} 点</small>
          </span>
        </div>
        <article>
          <small>公司剩余利润</small>
          <strong>RM {rm(network?.batch?.residualCents ?? 0)}</strong>
          <span>{network?.batch ? `${remainingRatio.toFixed(2)}% 实际留存` : '等待首个利润池'}</span>
        </article>
        <article>
          <small>代理总数</small>
          <strong>{network?.summary.agentCount ?? 0}</strong>
          <span>{network?.summary.rootAgentCount ?? 0} 位第一层代理</span>
        </article>
        <article className="online">
          <small>在线代理</small>
          <strong>{network?.summary.onlineAgentCount ?? 0}</strong>
          <span><i /> 90 秒心跳窗口</span>
        </article>
        <article>
          <small>代理体系玩家</small>
          <strong>{network?.summary.teamPlayerCount ?? 0}</strong>
          <span>递归去重团队人数</span>
        </article>
        <div className="ppx-network-clock">
          <small>{network?.mode === 'SNAPSHOT' ? '历史快照' : '实时数据'}</small>
          <strong>
            {lastUpdated?.toLocaleTimeString('en-MY', {
              hour12: false,
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            }) ?? '--:--:--'}
          </strong>
          <span>{poolId ? network?.batch?.poolCode : '每 15 秒自动刷新'}</span>
        </div>
      </div>

      <div className="ppx-network-canvas" aria-busy={loading}>
        {loading && !network && (
          <div className="ppx-network-loading">
            <i /><i /><i />
            <span>正在建立代理关系图…</span>
          </div>
        )}
        {network && (
          <ol className="ppx-network-roots">
            {(childrenByParent.get(null) ?? []).map((root) => (
              <NetworkBranch
                key={root.id}
                node={root}
                childrenByParent={childrenByParent}
                collapsed={displayCollapsed}
                visible={visible}
                onToggle={toggle}
                onOpen={setSelectedAgentId}
              />
            ))}
          </ol>
        )}
        {network?.nodes.length === 0 && (
          <div className="ppx-network-empty">
            <strong>代理网络尚未建立</strong>
            <span>请先在“代理管理”建立第一层代理。</span>
          </div>
        )}
        {visible && visible.size === 0 && (
          <div className="ppx-network-empty">
            <strong>没有匹配的代理</strong>
            <span>请尝试代理名称、昵称或 UID。</span>
          </div>
        )}
      </div>

      {selectedAgentId && (
        <AgentDashboardPanel
          agentId={selectedAgentId}
          poolId={poolId || undefined}
          onClose={() => setSelectedAgentId(null)}
          onError={onError}
        />
      )}
    </section>
  );
}
