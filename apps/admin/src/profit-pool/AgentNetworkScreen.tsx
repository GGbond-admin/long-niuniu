import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { del, patch, post, request, rm } from '../api';
import UserPicker, { userOptionName, type UserOption } from './UserPicker';
import type { AgentNetwork, BatchSummary, NetworkAgent } from './types';

type HouseInvite = { uid?: string; deepLink?: string | null } | null;
type TierPreset = { label: string; points: number };
type ViewMode = 'grid' | 'list';
type DetailTab = 'downline' | 'players' | 'history';

type DashData = {
  mode: 'LIVE' | 'SNAPSHOT';
  agent: NetworkAgent;
  children: NetworkAgent[];
  periods: Array<{
    poolId: string;
    poolCode: string;
    startSeqNo: number;
    endSeqNo: number;
    status: string;
    generatedAt: string;
    turnoverCents: string;
    teamTurnoverCents: string;
    amountCents: string;
  }>;
  periodsNextCursor: string | null;
  players: Array<{
    userId: string;
    uid: string;
    nickname: string | null;
    source: string;
    turnoverCents?: string;
    profitCents?: string;
  }>;
  playersNextCursor: string | null;
};

const GRID_PAGE = 24;
const LIST_PAGE = 40;

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function initials(agent: Pick<NetworkAgent, 'label' | 'nickname'>) {
  return (agent.nickname ?? agent.label).slice(0, 1).toUpperCase();
}

function shareRange(
  node: NetworkAgent,
  nodes: NetworkAgent[],
  minReservePoints: number,
  bucketBase: number,
) {
  const parent = node.parentId ? nodes.find((item) => item.id === node.parentId) : null;
  const children = nodes.filter((item) => item.parentId === node.id);
  return {
    min: children.length
      ? Math.max(...children.map((child) => child.sharePoints)) + minReservePoints
      : 0,
    max: parent ? parent.sharePoints - minReservePoints : bucketBase,
  };
}

function ancestry(agentId: string, nodes: NetworkAgent[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const chain: NetworkAgent[] = [];
  let current: NetworkAgent | undefined = byId.get(agentId);
  while (current) {
    chain.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return chain;
}

function paginate<T>(items: T[], page: number, size: number) {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const safe = Math.min(page, pageCount - 1);
  const start = safe * size;
  return {
    page: safe,
    pageCount,
    total,
    start: total === 0 ? 0 : start + 1,
    end: Math.min(start + size, total),
    slice: items.slice(start, start + size),
  };
}

function StatusDot({ agent }: { agent: NetworkAgent }) {
  const disabled = agent.status !== 'ACTIVE';
  return (
    <em className={`pp-dir-status ${disabled ? 'off' : agent.online ? 'on' : ''}`}>
      {disabled ? '停用' : agent.online ? '在线' : '离线'}
    </em>
  );
}

function AgentCard({
  agent,
  onOpen,
}: {
  agent: NetworkAgent;
  onOpen: (id: string) => void;
}) {
  return (
    <button type="button" className="pp-dir-card" onClick={() => onOpen(agent.id)}>
      <span className="pp-dir-avatar">{initials(agent)}</span>
      <div className="pp-dir-card-id">
        <strong>{agent.label}</strong>
        <small>
          L{agent.level} · UID {agent.uid}
        </small>
      </div>
      <StatusDot agent={agent} />
      <dl>
        <div>
          <dt>本期分成</dt>
          <dd>RM {rm(agent.profitCents)}</dd>
        </div>
        <div>
          <dt>团队流水</dt>
          <dd>RM {rm(agent.teamTurnoverCents)}</dd>
        </div>
        <div>
          <dt>自身 / 差额</dt>
          <dd>
            {rm(agent.selfAmountCents)} / {rm(agent.overrideAmountCents)}
          </dd>
        </div>
        <div>
          <dt>占成</dt>
          <dd>
            {agent.sharePoints}/{agent.bucketBase} · {((agent.sharePoints / agent.bucketBase) * 100).toFixed(0)}%
          </dd>
        </div>
        <div>
          <dt>直属玩家</dt>
          <dd>
            {agent.directPlayerCount} / 团队 {agent.teamPlayerCount}
          </dd>
        </div>
        <div>
          <dt>直属下级</dt>
          <dd>
            {agent.directAgentCount} / 团队 {agent.teamAgentCount}
          </dd>
        </div>
      </dl>
    </button>
  );
}

function DirectoryModal({
  children,
  labelledBy,
  onClose,
}: {
  children: ReactNode;
  labelledBy?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return createPortal(
    <div className="pp-dir-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="pp-dir-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

function Pager({
  page,
  pageCount,
  start,
  end,
  total,
  onPage,
}: {
  page: number;
  pageCount: number;
  start: number;
  end: number;
  total: number;
  onPage: (page: number) => void;
}) {
  if (total === 0 || pageCount <= 1) return null;
  return (
    <div className="pp-dir-pager">
      <span>
        第 {start}–{end} 位 · 共 {total} 人
      </span>
      <div>
        <button type="button" disabled={page <= 0} onClick={() => onPage(page - 1)}>
          上一页
        </button>
        <button type="button" disabled={page >= pageCount - 1} onClick={() => onPage(page + 1)}>
          下一页
        </button>
      </div>
    </div>
  );
}

function clipAgentLabel(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 30);
}

function CreateAgentModal({
  bucketBase,
  minReservePoints,
  tierPresets,
  onClose,
  onCreated,
}: {
  bucketBase: number;
  minReservePoints: number;
  tierPresets: TierPreset[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const presets = useMemo(() => {
    const source = tierPresets.length
      ? tierPresets
      : [{ label: '默认', points: Math.min(65, bucketBase) }];
    const valid = source.filter(
      (tier) => Number.isInteger(tier.points) && tier.points >= 0 && tier.points <= bucketBase,
    );
    return valid.length ? valid : [{ label: '默认', points: Math.min(65, bucketBase) }];
  }, [bucketBase, tierPresets]);
  const [agentUser, setAgentUser] = useState<UserOption | null>(null);
  const [label, setLabel] = useState('');
  const [points, setPoints] = useState(String(presets[0].points));
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  async function create() {
    const sharePoints = Number(points);
    const nextLabel = clipAgentLabel(label);
    if (!agentUser || !nextLabel) return;
    if (!Number.isInteger(sharePoints) || sharePoints < 0 || sharePoints > bucketBase) {
      setFormError(`占成必须是 0–${bucketBase} 的整数`);
      return;
    }
    if (agentUser.binding) {
      const ok = window.confirm(
        `「${userOptionName(agentUser)}」已归属代理「${agentUser.binding.agentLabel}」。\n设为第一层将先解除该归属，确定继续？`,
      );
      if (!ok) return;
    }
    setCreating(true);
    setFormError('');
    try {
      await post('/api/admin/profit-pool/agents', {
        uid: agentUser.uid,
        label: nextLabel,
        sharePoints,
      });
      onCreated();
    } catch (error) {
      setFormError(errorText(error, '建立代理失败'));
    } finally {
      setCreating(false);
    }
  }

  return (
    <DirectoryModal labelledBy="pp-dir-create-title" onClose={onClose}>
      <header>
        <small>仅后台可建第一层</small>
        <h3 id="pp-dir-create-title">新增第一层代理</h3>
        <p>
          先选用户再定名称和占成。已归属其他代理的用户也可以选，提交时会先解绑再建成第一层。下级由他自己升级，须预留{' '}
          {minReservePoints} 点差额。
        </p>
      </header>
      <div className="pp-dir-modal-body">
        <div className="pp-dir-field">
          <span>选择用户</span>
          <UserPicker
            value={agentUser}
            mode="agent"
            placeholder="搜索 UID、昵称或 Telegram"
            onChange={(user) => {
              setAgentUser(user);
              setFormError('');
              if (user) setLabel(clipAgentLabel(userOptionName(user)));
            }}
          />
        </div>
        <label className="pp-dir-field">
          <span>报表显示名称</span>
          <input
            value={label}
            maxLength={30}
            disabled={!agentUser}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="选择用户后自动带出，可改"
          />
        </label>
        <div className="pp-dir-field">
          <span>
            初始占成 · {points}/{bucketBase} · {((Number(points) / bucketBase) * 100).toFixed(1)}%
          </span>
          <div className="pp-dir-presets">
            {presets.map((tier) => (
              <button
                type="button"
                key={`${tier.label}-${tier.points}`}
                className={String(tier.points) === points ? 'active' : ''}
                onClick={() => setPoints(String(tier.points))}
              >
                <strong>{tier.label}</strong>
                <small>
                  {tier.points} 点 · {((tier.points / bucketBase) * 100).toFixed(0)}%
                </small>
              </button>
            ))}
          </div>
        </div>
        {formError ? (
          <div className="form-error" role="alert">
            {formError}
          </div>
        ) : null}
      </div>
      <div className="pp-dir-modal-actions">
        <button type="button" className="small" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="primary small"
          disabled={!agentUser || !clipAgentLabel(label) || creating}
          onClick={() => void create()}
        >
          {creating ? '正在建立…' : '建立第一层代理'}
        </button>
      </div>
    </DirectoryModal>
  );
}

function PointsModal({
  agent,
  range,
  bucketBase,
  minReservePoints,
  tierPresets,
  onClose,
  onSaved,
  onError,
}: {
  agent: NetworkAgent;
  range: { min: number; max: number };
  bucketBase: number;
  minReservePoints: number;
  tierPresets: TierPreset[];
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [value, setValue] = useState(String(agent.sharePoints));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  async function save() {
    const next = Number(value);
    if (!Number.isInteger(next) || next < range.min || next > range.max) {
      onError(`占成必须是 ${range.min}–${range.max} 的整数（上级预留 ${minReservePoints} 点）`);
      return;
    }
    setSaving(true);
    try {
      await patch(`/api/admin/profit-pool/agents/${agent.id}`, { sharePoints: next });
      onSaved();
    } catch (error) {
      onError(errorText(error, '更新占成失败'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <DirectoryModal onClose={onClose}>
      <header>
        <small>SHARE POINTS</small>
        <h3>调整「{agent.label}」占成</h3>
        <p>允许 {range.min}–{range.max} 点。只影响后续新批次，已生成的利润池不会变。</p>
      </header>
      <div className="pp-dir-modal-body">
        <div className="pp-dir-presets">
          {tierPresets.map((tier) => (
            <button
              type="button"
              key={`${tier.label}-${tier.points}`}
              className={String(tier.points) === value ? 'active' : ''}
              disabled={tier.points < range.min || tier.points > range.max}
              onClick={() => setValue(String(tier.points))}
            >
              <strong>{tier.label}</strong>
              <small>{tier.points} 点</small>
            </button>
          ))}
        </div>
        <label className="pp-dir-field">
          <span>点数</span>
          <input inputMode="numeric" value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
      </div>
      <div className="pp-dir-modal-actions">
        <button type="button" className="small" onClick={onClose}>
          取消
        </button>
        <button type="button" className="primary small" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存占成'}
        </button>
      </div>
    </DirectoryModal>
  );
}

export default function AgentNetworkScreen({
  onError,
  houseInvite = null,
  bucketBase = 130,
  minReservePoints = 5,
  tierPresets = [],
  onChanged,
}: {
  onError: (message: string) => void;
  houseInvite?: HouseInvite;
  bucketBase?: number;
  minReservePoints?: number;
  tierPresets?: TierPreset[];
  onChanged?: () => void;
}) {
  const [network, setNetwork] = useState<AgentNetwork | null>(null);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [poolId, setPoolId] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState<ViewMode>('grid');
  const [page, setPage] = useState(0);
  const [path, setPath] = useState<string[]>([]);
  const [detailTab, setDetailTab] = useState<DetailTab>('downline');
  const [creating, setCreating] = useState(false);
  const [editingPoints, setEditingPoints] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dash, setDash] = useState<DashData | null>(null);
  const [dashLoading, setDashLoading] = useState(false);
  const [bindUser, setBindUser] = useState<UserOption | null>(null);
  const [binding, setBinding] = useState(false);
  const [copied, setCopied] = useState('');
  const loadVersion = useRef(0);
  const canManage = !poolId;
  const pageSize = view === 'grid' ? GRID_PAGE : LIST_PAGE;

  const load = useCallback(
    async (silent = false) => {
      const version = ++loadVersion.current;
      if (!silent) setLoading(true);
      try {
        const query = poolId ? `?poolId=${encodeURIComponent(poolId)}` : '';
        const result = await request<AgentNetwork>(`/api/admin/profit-pool/network${query}`);
        if (version === loadVersion.current) setNetwork(result);
      } catch (error) {
        if (version === loadVersion.current) onError(errorText(error, '代理网络加载失败'));
      } finally {
        if (version === loadVersion.current) setLoading(false);
      }
    },
    [poolId, onError],
  );

  useEffect(() => {
    void request<{ items: BatchSummary[] }>('/api/admin/profit-pool/history?limit=50')
      .then((result) => setBatches(result.items))
      .catch((error) => onError(errorText(error, '历史批次加载失败')));
  }, [onError]);

  useEffect(() => {
    void load();
    if (poolId) return;
    const timer = window.setInterval(() => void load(true), 15_000);
    return () => window.clearInterval(timer);
  }, [load, poolId]);

  useEffect(() => {
    setPage(0);
  }, [search, view, path.join('|')]);

  const nodes = network?.nodes ?? [];
  const byParent = useMemo(() => {
    const map = new Map<string | null, NetworkAgent[]>();
    const ids = new Set(nodes.map((node) => node.id));
    for (const node of nodes) {
      const parent = node.parentId && ids.has(node.parentId) ? node.parentId : null;
      const list = map.get(parent) ?? [];
      list.push(node);
      map.set(parent, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => Number(BigInt(b.profitCents) - BigInt(a.profitCents)));
    }
    return map;
  }, [nodes]);

  const currentId = path[path.length - 1] ?? null;
  const current = currentId ? nodes.find((node) => node.id === currentId) ?? null : null;
  const crumbs = current ? ancestry(current.id, nodes) : [];

  const directoryItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query) {
      return nodes.filter((node) =>
        `${node.label} ${node.nickname ?? ''} ${node.uid}`.toLowerCase().includes(query),
      );
    }
    if (currentId) return byParent.get(currentId) ?? [];
    return byParent.get(null) ?? [];
  }, [byParent, currentId, nodes, search]);

  const listing = paginate(directoryItems, page, pageSize);

  useEffect(() => {
    if (!currentId) {
      setDash(null);
      return;
    }
    const controller = new AbortController();
    setDashLoading(true);
    const params = poolId ? `?poolId=${encodeURIComponent(poolId)}` : '';
    void request<DashData>(`/api/admin/profit-pool/agents/${currentId}/dashboard${params}`, {
      signal: controller.signal,
    })
      .then(setDash)
      .catch((error) => {
        if ((error as Error).name !== 'AbortError') onError(errorText(error, '加载代理详情失败'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDashLoading(false);
      });
    return () => controller.abort();
  }, [currentId, poolId, onError, network?.generatedAt]);

  function openAgent(id: string) {
    setSearch('');
    setPath(ancestry(id, nodes).map((node) => node.id));
    setDetailTab('downline');
  }

  async function refreshed() {
    await load(true);
    onChanged?.();
  }

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied(''), 1600);
    } catch {
      setCopied('');
    }
  }

  async function toggleStatus(agent: NetworkAgent) {
    const next = agent.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    if (next === 'DISABLED' && !confirm(`停用「${agent.label}」？停用后不再参与后续利润池。`)) return;
    try {
      await patch(`/api/admin/profit-pool/agents/${agent.id}`, { status: next });
      await refreshed();
    } catch (error) {
      onError(errorText(error, '更新状态失败'));
    }
  }

  async function bindPlayer() {
    if (!bindUser || !currentId) return;
    setBinding(true);
    try {
      await post(`/api/admin/profit-pool/agents/${currentId}/players`, { uid: bindUser.uid });
      setBindUser(null);
      await refreshed();
    } catch (error) {
      onError(errorText(error, '绑定失败'));
    } finally {
      setBinding(false);
    }
  }

  async function unbindPlayer(userId: string) {
    if (!currentId) return;
    try {
      await del(`/api/admin/profit-pool/agents/${currentId}/players/${userId}`);
      await refreshed();
    } catch (error) {
      onError(errorText(error, '解绑失败'));
    }
  }

  async function loadMorePlayers() {
    if (!dash?.playersNextCursor || !currentId) return;
    const params = new URLSearchParams({ cursor: dash.playersNextCursor, limit: '20' });
    if (poolId) params.set('poolId', poolId);
    const result = await request<{ items: DashData['players']; nextCursor: string | null }>(
      `/api/admin/profit-pool/agents/${currentId}/dashboard/players?${params}`,
    );
    setDash((current) =>
      current
        ? {
            ...current,
            players: [
              ...current.players,
              ...result.items.filter((item) => !current.players.some((row) => row.userId === item.userId)),
            ],
            playersNextCursor: result.nextCursor,
          }
        : current,
    );
  }

  async function loadMorePeriods() {
    if (!dash?.periodsNextCursor || !currentId) return;
    const result = await request<{ items: DashData['periods']; nextCursor: string | null }>(
      `/api/admin/profit-pool/agents/${currentId}/dashboard/periods?cursor=${encodeURIComponent(dash.periodsNextCursor)}&limit=20`,
    );
    setDash((current) =>
      current
        ? {
            ...current,
            periods: [
              ...current.periods,
              ...result.items.filter((item) => !current.periods.some((row) => row.poolId === item.poolId)),
            ],
            periodsNextCursor: result.nextCursor,
          }
        : current,
    );
  }

  function renderCollection(items: NetworkAgent[]) {
    if (view === 'list') {
      return (
        <div className="table-wrap">
          <table className="pp-dir-table">
            <thead>
              <tr>
                <th>代理</th>
                <th>占成</th>
                <th>本期分成</th>
                <th>团队流水</th>
                <th>直属玩家</th>
                <th>直属下级</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {items.map((agent) => (
                <tr key={agent.id} onClick={() => openAgent(agent.id)}>
                  <td>
                    <span className="pp-dir-row-id">
                      <span className="pp-dir-avatar sm">{initials(agent)}</span>
                      <span>
                        <strong>{agent.label}</strong>
                        <small>
                          L{agent.level} · UID {agent.uid}
                        </small>
                      </span>
                    </span>
                  </td>
                  <td>
                    {agent.sharePoints}/{agent.bucketBase}
                  </td>
                  <td className="money">RM {rm(agent.profitCents)}</td>
                  <td>RM {rm(agent.teamTurnoverCents)}</td>
                  <td>{agent.directPlayerCount}</td>
                  <td>{agent.directAgentCount}</td>
                  <td>
                    <StatusDot agent={agent} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    return (
      <div className="pp-dir-grid">
        {items.map((agent) => (
          <AgentCard key={agent.id} agent={agent} onOpen={openAgent} />
        ))}
      </div>
    );
  }

  return (
    <section className="panel pp-dir">
      <div className="panel-title">
        <div>
          <small>AGENT DIRECTORY</small>
          <h2>代理网络</h2>
        </div>
        {network && (
          <div className="pp-dir-stats">
            <span>
              <b>{network.summary.rootAgentCount}</b> 第一层
            </span>
            <span>
              <b>{network.summary.agentCount}</b> 代理
            </span>
            <span className="on">
              <b>{network.summary.onlineAgentCount}</b> 在线
            </span>
            <span>
              <b>{network.summary.teamPlayerCount}</b> 玩家
            </span>
          </div>
        )}
      </div>

      <div className="pp-dir-toolbar">
        {current ? (
          <nav className="pp-dir-crumbs" aria-label="代理路径">
            <button type="button" onClick={() => setPath([])}>
              全部第一层
            </button>
            {crumbs.map((node, index) => (
              <button
                type="button"
                key={node.id}
                className={index === crumbs.length - 1 ? 'current' : ''}
                onClick={() => setPath(crumbs.slice(0, index + 1).map((item) => item.id))}
              >
                {node.label}
              </button>
            ))}
          </nav>
        ) : (
          <label className="pp-dir-search">
            <span className="sr-only">搜索代理</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索任意层级：名称、昵称或 UID"
            />
          </label>
        )}

        <div className="pp-dir-tools">
          <div className="pp-dir-toggle" role="group" aria-label="显示方式">
            <button type="button" className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')}>
              卡片
            </button>
            <button type="button" className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>
              列表
            </button>
          </div>
          <select
            aria-label="实时或历史利润池"
            value={poolId}
            onChange={(event) => {
              setPoolId(event.target.value);
              setPath([]);
            }}
          >
            <option value="">实时数据</option>
            {batches.map((batch) => (
              <option key={batch.id} value={batch.id}>
                {batch.poolCode} · {batch.startSeqNo}-{batch.endSeqNo} 局
              </option>
            ))}
          </select>
          {canManage && !current && (
            <button type="button" className="primary small" onClick={() => setCreating(true)}>
              新增第一层
            </button>
          )}
        </div>
      </div>

      {!current && houseInvite?.uid && (
        <div className="pp-dir-invite">
          <span>
            官方邀请码 <strong>{houseInvite.uid}</strong>
            <em>邀请只产生返水</em>
          </span>
          <div>
            <button type="button" className="small" onClick={() => void copy(String(houseInvite.uid), 'uid')}>
              {copied === 'uid' ? '已复制' : '复制邀请码'}
            </button>
            {houseInvite.deepLink && (
              <button
                type="button"
                className="small"
                onClick={() => void copy(String(houseInvite.deepLink), 'link')}
              >
                {copied === 'link' ? '已复制' : '复制链接'}
              </button>
            )}
          </div>
        </div>
      )}

      {loading && !network && <p className="pp-empty">正在读取代理…</p>}

      {!current && network && (
        listing.total === 0 ? (
          <div className="pp-dir-empty">
            <strong>{search.trim() ? '没有匹配的代理' : '还没有第一层代理'}</strong>
            <p>
              {search.trim()
                ? '换个名称、昵称或 UID 再试。'
                : '点右上角「新增第一层」，从系统用户里选人即可。下级不用在这里建。'}
            </p>
            {canManage && !search.trim() && (
              <button type="button" className="primary small" onClick={() => setCreating(true)}>
                新增第一层代理
              </button>
            )}
          </div>
        ) : (
          <>
            {renderCollection(listing.slice)}
            <Pager {...listing} onPage={setPage} />
          </>
        )
      )}

      {current && (
        <div className="pp-dir-detail">
          <header className="pp-dir-hero">
            <span className="pp-dir-avatar lg">{initials(current)}</span>
            <div>
              <small>
                L{current.level}
                {current.level === 1 ? ' · 第一层' : ''}
              </small>
              <h3>{current.label}</h3>
              <p>
                {current.nickname ?? '未设置昵称'} · UID {current.uid}
              </p>
            </div>
            <StatusDot agent={current} />
            {canManage && (
              <div className="pp-dir-hero-actions">
                <button type="button" className="small" onClick={() => setEditingPoints(true)}>
                  改占成
                </button>
                <button type="button" className="small" onClick={() => void toggleStatus(current)}>
                  {current.status === 'ACTIVE' ? '停用' : '启用'}
                </button>
              </div>
            )}
          </header>

          <div className="pp-dir-kpis">
            <span>
              <b>RM {rm(current.profitCents)}</b>
              本期分成
            </span>
            <span>
              <b>
                {rm(current.selfAmountCents)} / {rm(current.overrideAmountCents)}
              </b>
              自身 / 差额
            </span>
            <span>
              <b>
                {current.sharePoints}/{current.bucketBase}
              </b>
              占成 {((current.sharePoints / current.bucketBase) * 100).toFixed(0)}%
            </span>
            <span>
              <b>RM {rm(current.teamTurnoverCents)}</b>
              团队流水
            </span>
            <span>
              <b>
                {current.directPlayerCount} / {current.teamPlayerCount}
              </b>
              直属 / 团队玩家
            </span>
            <span>
              <b>
                {current.directAgentCount} / {current.teamAgentCount}
              </b>
              直属 / 团队代理
            </span>
            <span>
              <b>
                {current.lifetimeProfitCents == null ? '—' : `RM ${rm(current.lifetimeProfitCents)}`}
              </b>
              累计已发
            </span>
          </div>

          <div className="hub-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              className={detailTab === 'downline' ? 'active' : ''}
              onClick={() => setDetailTab('downline')}
            >
              下级代理（{current.directAgentCount}）
            </button>
            <button
              type="button"
              role="tab"
              className={detailTab === 'players' ? 'active' : ''}
              onClick={() => setDetailTab('players')}
            >
              直属玩家（{current.directPlayerCount}）
            </button>
            <button
              type="button"
              role="tab"
              className={detailTab === 'history' ? 'active' : ''}
              onClick={() => setDetailTab('history')}
            >
              利润历史
            </button>
          </div>

          {detailTab === 'downline' && (
            <div className="pp-dir-section">
              {listing.total === 0 ? (
                <p className="pp-empty">没有直属下级。下级由该代理在玩家端升级产生。</p>
              ) : (
                <>
                  {renderCollection(listing.slice)}
                  <Pager {...listing} onPage={setPage} />
                </>
              )}
            </div>
          )}

          {detailTab === 'players' && (
            <div className="pp-dir-section">
              {canManage && (
                <div className="pp-dir-bind">
                  <UserPicker
                    value={bindUser}
                    mode="player"
                    currentAgentId={current.id}
                    inlineResults
                    placeholder="搜索并绑定直属玩家"
                    onChange={setBindUser}
                  />
                  <button
                    type="button"
                    className="primary small"
                    disabled={!bindUser || binding}
                    onClick={() => void bindPlayer()}
                  >
                    {binding ? '绑定中…' : '确认绑定'}
                  </button>
                </div>
              )}
              {dashLoading && <p className="pp-empty">正在读取玩家…</p>}
              <div className="pp-dir-members">
                {(dash?.players ?? []).map((player) => (
                  <article key={player.userId}>
                    <span className="pp-dir-avatar sm">{(player.nickname ?? player.uid).slice(0, 1)}</span>
                    <div>
                      <strong>{player.nickname ?? '玩家'}</strong>
                      <small>
                        UID {player.uid}
                        {player.source === 'REFERRAL' ? ' · 推荐' : ''}
                      </small>
                    </div>
                    <b>{player.turnoverCents != null ? `RM ${rm(player.turnoverCents)}` : '—'}</b>
                    {canManage && (
                      <button type="button" className="small" onClick={() => void unbindPlayer(player.userId)}>
                        解绑
                      </button>
                    )}
                  </article>
                ))}
              </div>
              {!dashLoading && (dash?.players.length ?? 0) === 0 && (
                <p className="pp-empty">暂无直属玩家。</p>
              )}
              {dash?.playersNextCursor && (
                <button type="button" className="small" onClick={() => void loadMorePlayers()}>
                  加载更多玩家
                </button>
              )}
            </div>
          )}

          {detailTab === 'history' && (
            <div className="pp-dir-section">
              {dashLoading && <p className="pp-empty">正在读取利润历史…</p>}
              <div className="table-wrap">
                <table className="pp-dir-table">
                  <thead>
                    <tr>
                      <th>批次</th>
                      <th>局数</th>
                      <th>团队流水</th>
                      <th>分成</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(dash?.periods ?? []).map((period) => (
                      <tr key={period.poolId}>
                        <td>{period.poolCode}</td>
                        <td>
                          {period.startSeqNo}–{period.endSeqNo}
                        </td>
                        <td>RM {rm(period.teamTurnoverCents)}</td>
                        <td className="money">RM {rm(period.amountCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!dashLoading && (dash?.periods.length ?? 0) === 0 && (
                <p className="pp-empty">尚无已发放的利润池历史。</p>
              )}
              {dash?.periodsNextCursor && (
                <button type="button" className="small" onClick={() => void loadMorePeriods()}>
                  加载更多历史
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {creating && (
        <CreateAgentModal
          bucketBase={bucketBase}
          minReservePoints={minReservePoints}
          tierPresets={tierPresets}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void refreshed();
          }}
        />
      )}
      {editingPoints && current && (
        <PointsModal
          agent={current}
          range={shareRange(current, nodes, minReservePoints, bucketBase)}
          bucketBase={bucketBase}
          minReservePoints={minReservePoints}
          tierPresets={tierPresets}
          onClose={() => setEditingPoints(false)}
          onSaved={() => {
            setEditingPoints(false);
            void refreshed();
          }}
          onError={onError}
        />
      )}
    </section>
  );
}
