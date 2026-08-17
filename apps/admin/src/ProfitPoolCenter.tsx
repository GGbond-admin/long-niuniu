/**
 * 利润池与称桶分配中心 — 对应《利润池与称桶分配模式说明文档》
 * 链路可视化：抽水（玩家3%/庄家5%）→ 毛利 → 扣支出 → 净利润池 → 按流水贡献 × 占成/130 分配
 */
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { del, patch, post, put, request, rm } from './api';

type Row = Record<string, any>;

const todayKL = () =>
  new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kuala_Lumpur' });

function rmSigned(cents: string | number | bigint): string {
  const value = BigInt(cents ?? 0);
  return `${value < 0n ? '−' : ''}RM ${rm(value < 0n ? -value : value)}`;
}

function pct(bp: number): string {
  return `${(bp / 100).toFixed(2)}%`;
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试';
}

type PoolTab = 'overview' | 'agents' | 'history' | 'config';

export default function ProfitPoolCenter() {
  const [tab, setTab] = useState<PoolTab>('overview');
  const [date, setDate] = useState(todayKL());
  const [overview, setOverview] = useState<Row | null>(null);
  const [agents, setAgents] = useState<Row[]>([]);
  const [history, setHistory] = useState<Row[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function load(target = date) {
    setError('');
    try {
      const [ov, agentList, his] = await Promise.all([
        request<Row>(`/api/admin/profit-pool/overview?date=${target}`),
        request<{ items: Row[] }>('/api/admin/profit-pool/agents'),
        request<{ items: Row[] }>('/api/admin/profit-pool/history?limit=30'),
      ]);
      setOverview(ov);
      setAgents(agentList.items);
      setHistory(his.items);
    } catch (err) {
      setError(errText(err));
    }
  }

  useEffect(() => {
    void load(date);
  }, [date]);

  const pool = overview?.pool as Row | undefined;
  const config = overview?.config as Row | undefined;
  const today = (overview?.today as string) ?? todayKL();
  const poolStatus = (pool?.status as string) ?? 'ESTIMATED';
  const canGenerate = Boolean(pool && poolStatus === 'ESTIMATED' && date < today);
  const canConfirm = poolStatus === 'PENDING';

  /** 第一阶段：生成报表（PENDING，不转账） */
  async function generate() {
    if (!pool) return;
    setBusy(true);
    setError('');
    try {
      await post('/api/admin/profit-pool/generate', { date });
      setNotice(`${date} 称桶报表已生成，核对无误后请点击「确认发放」`);
      await load(date);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  /** 第二阶段：确认发放（转账入代理余额，不可撤销） */
  async function confirmPayout() {
    if (!pool) return;
    const netRm = rmSigned(pool.netPoolCents);
    const distRm = rmSigned(pool.distributedCents);
    if (
      !confirm(
        `确认发放 ${date} 称桶分成？\n净利润池 ${netRm}，将向代理发放合计 ${distRm}。\n确认后立即入账，不可撤销。`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await post('/api/admin/profit-pool/confirm', { date });
      setNotice(`${date} 称桶分成已发放到各代理可用余额`);
      await load(date);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  /** 作废待确认报表（未转账，可安全重算） */
  async function discard() {
    if (!confirm(`作废 ${date} 的待确认报表？\n未发生转账，作废后可修改代理/配置再重新生成。`)) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await post('/api/admin/profit-pool/discard', { date });
      setNotice(`${date} 待确认报表已作废，可重新生成`);
      await load(date);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const pendingCount = history.filter((row) => row.status === 'PENDING').length;
  const tabs: Array<{ id: PoolTab; label: string }> = [
    { id: 'overview', label: '① 结算总览' },
    { id: 'agents', label: `② 代理管理（${agents.length}）` },
    { id: 'history', label: pendingCount ? `分配历史 · ${pendingCount} 待确认` : '分配历史' },
    { id: 'config', label: '参数配置' },
  ];

  return (
    <div className="hub-page">
      <div className="hub-tabs" role="tablist">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'active' : ''}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error && <div className="error-box">{error}</div>}
      {notice && (
        <div className="pp-notice" onClick={() => setNotice('')}>
          {notice}（点击关闭）
        </div>
      )}

      <div className="hub-body">
        {tab === 'overview' && (
          <>
            <div className="toolbar standalone">
              <div className="toolbar-hint">
                <small>业务日（马来西亚时区）</small>
                <span>每天只需两步：核对昨日数据 → 确认发放</span>
              </div>
              <input
                type="date"
                value={date}
                max={today}
                onChange={(e) => setDate(e.target.value)}
              />
              {canGenerate && (
                <button className="primary small" disabled={busy} onClick={() => void generate()}>
                  {busy ? '处理中…' : '生成报表'}
                </button>
              )}
              {canConfirm && (
                <>
                  <button
                    className="primary small"
                    disabled={busy}
                    onClick={() => void confirmPayout()}
                  >
                    {busy ? '处理中…' : '确认发放'}
                  </button>
                  <button className="small" disabled={busy} onClick={() => void discard()}>
                    作废重算
                  </button>
                </>
              )}
              <button className="small" onClick={() => void load(date)}>
                刷新
              </button>
            </div>

            <SettleSteps status={poolStatus} isToday={date >= today} date={date} />

            {pool && (
              <>
                <PoolMetrics pool={pool} status={poolStatus} />
                <FormulaStrip pool={pool} />
              </>
            )}

            <div className="pp-grid">
              <section className="panel">
                <div className="panel-title">
                  <div>
                    <small>近 14 日</small>
                    <h2>利润池趋势</h2>
                  </div>
                </div>
                {overview?.trend ? (
                  <TrendChart trend={overview.trend as Row[]} />
                ) : (
                  <p className="pp-empty">加载中…</p>
                )}
              </section>

              <section className="panel">
                <div className="panel-title">
                  <div>
                    <small>{date} 贡献占比</small>
                    <h2>代理流水贡献</h2>
                  </div>
                </div>
                {pool ? <ContributionBars agents={(pool.agents as Row[]) ?? []} /> : null}
              </section>
            </div>
          </>
        )}

        {tab === 'agents' && (
          <>
            <div className="toolbar standalone">
              <div className="toolbar-hint">
                <small>数据日期</small>
                <span>
                  表中流水/分成为 {date}（{POOL_STATUS_LABEL[poolStatus] ?? poolStatus}）的数据
                </span>
              </div>
              <input
                type="date"
                value={date}
                max={today}
                onChange={(e) => setDate(e.target.value)}
              />
              <button className="small" onClick={() => void load(date)}>
                刷新
              </button>
            </div>
            <AgentManager
              agents={agents}
              poolAgents={(pool?.agents as Row[]) ?? []}
              houseInvite={(overview?.houseInvite as Row | undefined) ?? null}
              bucketBase={Number(config?.bucketBase ?? 130)}
              minReservePoints={Number(config?.minReservePoints ?? 5)}
              tierPresets={(config?.tierPresets as Array<{ label: string; points: number }>) ?? []}
              settled={Boolean(pool?.settled)}
              onChanged={() => void load(date)}
              onError={(message) => setError(message)}
            />
          </>
        )}

        {tab === 'history' && <HistoryPanel items={history} />}

        {tab === 'config' &&
          (config ? (
            <ConfigPanel config={config} onSaved={() => void load(date)} onError={setError} />
          ) : (
            <p className="pp-empty">加载中…</p>
          ))}
      </div>
    </div>
  );
}

/* ——— 结算流程步骤条：让管理员一眼知道当前该做什么 ——— */
function SettleSteps({
  status,
  isToday,
  date,
}: {
  status: string;
  isToday: boolean;
  date: string;
}) {
  const steps = [
    { title: '数据累计', hint: '当日流水与抽水实时累计' },
    { title: '生成报表', hint: '次日自动生成（也可手动）' },
    { title: '核对数据', hint: '检查各代理分成明细' },
    { title: '确认发放', hint: '入账代理余额，不可撤销' },
  ];
  // 当前进行到第几步
  const active =
    status === 'SETTLED' || status === 'NO_DISTRIBUTION'
      ? 4
      : status === 'PENDING'
        ? 2
        : isToday
          ? 0
          : 1;
  return (
    <div className="pp-steps">
      {steps.map((step, index) => (
        <div
          key={step.title}
          className={`pp-step ${index < active ? 'done' : index === active ? 'now' : ''}`}
        >
          <i>{index < active ? '✓' : index + 1}</i>
          <div>
            <strong>{step.title}</strong>
            <small>{step.hint}</small>
          </div>
        </div>
      ))}
      <div className={`pp-step-result ${status === 'SETTLED' ? 'ok' : status === 'NO_DISTRIBUTION' ? 'off' : ''}`}>
        {status === 'SETTLED'
          ? `${date} 已发放完成`
          : status === 'NO_DISTRIBUTION'
            ? `${date} 负池不分配（结转次日）`
            : status === 'PENDING'
              ? '→ 请核对下方数据后点「确认发放」'
              : isToday
                ? '当日进行中，次日生成报表'
                : '→ 请点「生成报表」'}
      </div>
    </div>
  );
}

const POOL_STATUS_LABEL: Record<string, string> = {
  ESTIMATED: '实时预估',
  PENDING: '已生成 · 待确认发放',
  SETTLED: '已发放',
  NO_DISTRIBUTION: '不分配（负池结转）',
};

/* ——— 指标卡 ——— */
function PoolMetrics({ pool, status }: { pool: Row; status: string }) {
  const cards: Array<{ label: string; value: string; hint?: string; tone?: string }> = [
    { label: '玩家赢抽水（3%）', value: rmSigned(pool.rakePlayerCents) },
    { label: '庄家赢抽水（5%）', value: rmSigned(pool.rakeBankerCents) },
    { label: '抽水合计（毛利润）', value: rmSigned(pool.rakeTotalCents), tone: 'gold' },
    { label: '公司总流水', value: rmSigned(pool.turnoverCents) },
    {
      label: `公司支出（流水×${(Number(pool.expenseRatio) * 100).toFixed(2)}%）`,
      value: rmSigned(pool.expenseCents),
      tone: 'red',
    },
    { label: '昨日负结转', value: rmSigned(pool.carryInCents) },
    {
      label: `净利润池（${POOL_STATUS_LABEL[status] ?? status}）`,
      value: rmSigned(pool.netPoolCents),
      tone: BigInt(pool.netPoolCents) >= 0n ? 'jade' : 'red',
    },
    { label: '代理分配合计', value: rmSigned(pool.distributedCents), tone: 'blue' },
    { label: '公司留存', value: rmSigned(pool.residualCents) },
  ];
  return (
    <div className="pp-metrics">
      {cards.map((card) => (
        <article key={card.label} className={`pp-card tone-${card.tone ?? 'plain'}`}>
          <small>{card.label}</small>
          <strong>{card.value}</strong>
        </article>
      ))}
    </div>
  );
}

/* ——— 计算过程条 ——— */
function FormulaStrip({ pool }: { pool: Row }) {
  return (
    <section className="panel pp-formula">
      <span>
        抽水 <b>{rmSigned(pool.rakeTotalCents)}</b>
      </span>
      <i>−</i>
      <span>
        支出 <b>{rmSigned(pool.expenseCents)}</b>
      </span>
      <i>{BigInt(pool.carryInCents) < 0n ? '−' : '+'}</i>
      <span>
        结转 <b>RM {rm(BigInt(pool.carryInCents) < 0n ? -BigInt(pool.carryInCents) : BigInt(pool.carryInCents))}</b>
      </span>
      <i>=</i>
      <span className="pp-formula-net">
        净利润池 <b>{rmSigned(pool.netPoolCents)}</b>
      </span>
      <em>
        自身利润 = 净池 × (直属玩家流水 ÷ 公司流水) × (占成 ÷ {pool.bucketBase})；
        差额利润 = 净池 × (下级团队流水 ÷ 公司流水) × (占成差 ÷ {pool.bucketBase})
      </em>
    </section>
  );
}

/* ——— 趋势图（SVG 柱状 + 折线） ——— */
function TrendChart({ trend }: { trend: Row[] }) {
  const width = 640;
  const height = 220;
  const padding = { top: 16, right: 12, bottom: 34, left: 12 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const values = trend.map((day) => ({
    date: day.date as string,
    settled: Boolean(day.settled),
    rake: Number(BigInt(day.rakeTotalCents)) / 100,
    net: Number(BigInt(day.netPoolCents)) / 100,
    dist: Number(BigInt(day.distributedCents)) / 100,
  }));
  const maxAbs = Math.max(1, ...values.flatMap((v) => [Math.abs(v.rake), Math.abs(v.net), v.dist]));
  const zeroY = padding.top + chartH * (maxAbs / (maxAbs * 2));
  const scale = (value: number) => (value / maxAbs) * (chartH / 2);
  const slot = chartW / Math.max(1, values.length);
  const barW = Math.min(18, slot * 0.32);

  return (
    <div className="pp-chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} className="pp-chart" role="img">
        <line x1={padding.left} x2={width - padding.right} y1={zeroY} y2={zeroY} className="pp-axis" />
        {values.map((v, i) => {
          const cx = padding.left + slot * i + slot / 2;
          return (
            <g key={v.date}>
              {/* 净池柱（正绿负红） */}
              <rect
                x={cx - barW - 1}
                y={v.net >= 0 ? zeroY - scale(v.net) : zeroY}
                width={barW}
                height={Math.max(1, Math.abs(scale(v.net)))}
                className={v.net >= 0 ? 'pp-bar-net' : 'pp-bar-net negative'}
                opacity={v.settled ? 1 : 0.45}
              >
                <title>{`${v.date} 净池 RM${v.net.toFixed(2)}${v.settled ? '' : '（预估）'}`}</title>
              </rect>
              {/* 分配柱 */}
              <rect
                x={cx + 1}
                y={zeroY - scale(Math.max(0, v.dist))}
                width={barW}
                height={Math.max(1, scale(Math.max(0, v.dist)))}
                className="pp-bar-dist"
                opacity={v.settled ? 1 : 0.45}
              >
                <title>{`${v.date} 代理分配 RM${v.dist.toFixed(2)}`}</title>
              </rect>
              <text x={cx} y={height - 18} className="pp-tick">
                {v.date.slice(5)}
              </text>
              {!v.settled && (
                <text x={cx} y={height - 6} className="pp-tick pp-tick-est">
                  预估
                </text>
              )}
            </g>
          );
        })}
        {/* 抽水折线 */}
        <polyline
          className="pp-line-rake"
          points={values
            .map((v, i) => {
              const cx = padding.left + slot * i + slot / 2;
              return `${cx},${zeroY - scale(v.rake)}`;
            })
            .join(' ')}
        />
      </svg>
      <div className="pp-legend">
        <span><i className="dot net" /> 净利润池</span>
        <span><i className="dot dist" /> 代理分配</span>
        <span><i className="dot rake" /> 抽水毛利</span>
      </div>
    </div>
  );
}

/* ——— 代理贡献横向条形图 ——— */
function ContributionBars({ agents }: { agents: Row[] }) {
  const rows = [...agents].sort((a, b) => b.contributionBp - a.contributionBp);
  if (rows.length === 0) {
    return <p className="pp-empty">尚未配置代理。在下方「代理管理」新增代理并绑定玩家后，此处展示贡献占比。</p>;
  }
  const maxBp = Math.max(1, ...rows.map((r) => Number(r.contributionBp)));
  return (
    <div className="pp-bars">
      {rows.map((agent) => (
        <div className="pp-bar-row" key={agent.agentId}>
          <div className="pp-bar-meta">
            <strong>{agent.label}</strong>
            <small>
              团队流水 RM {rm(agent.teamTurnoverCents ?? agent.turnoverCents ?? 0)} · 占比{' '}
              {pct(Number(agent.contributionBp))} · 占成 {agent.sharePoints}
            </small>
          </div>
          <div className="pp-bar-track">
            <i style={{ width: `${(Number(agent.contributionBp) / maxBp) * 100}%` }} />
          </div>
          <b className="pp-bar-amount">RM {rm(agent.amountCents)}</b>
        </div>
      ))}
    </div>
  );
}

type UserOption = {
  id: string;
  uid: string;
  nickname: string | null;
  tgUsername: string | null;
  tgDisplayName: string | null;
  status: 'ACTIVE' | 'BANNED';
  availableCents: string;
  agent: { id: string; label: string; status: string } | null;
  binding: { agentId: string; agentLabel: string } | null;
};

type UserPickerMode = 'agent' | 'player';

function userOptionName(user: UserOption): string {
  return (
    user.nickname?.trim() ||
    user.tgDisplayName?.trim() ||
    (user.tgUsername ? `@${user.tgUsername}` : '') ||
    `UID ${user.uid}`
  );
}

function userOptionAvailability(
  user: UserOption,
  mode: UserPickerMode,
  currentAgentId?: string,
): { allowed: boolean; reason: string } {
  if (user.status !== 'ACTIVE') return { allowed: false, reason: '账号已封禁' };
  if (user.agent) {
    return {
      allowed: false,
      reason: mode === 'agent' ? `已是代理：${user.agent.label}` : '该用户已经是代理',
    };
  }
  if (user.binding) {
    return {
      allowed: false,
      reason:
        user.binding.agentId === currentAgentId
          ? '已归属当前代理'
          : `已归属：${user.binding.agentLabel}`,
    };
  }
  return { allowed: true, reason: mode === 'agent' ? '可设为第一层代理' : '可绑定' };
}

function UserPicker({
  value,
  mode,
  currentAgentId,
  placeholder,
  inlineResults = false,
  onChange,
}: {
  value: UserOption | null;
  mode: UserPickerMode;
  currentAgentId?: string;
  placeholder: string;
  inlineResults?: boolean;
  onChange: (user: UserOption | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<UserOption[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    setQuery(value ? userOptionName(value) : '');
  }, [value?.id]);

  useEffect(() => {
    function closeOnOutsideClick(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, []);

  useEffect(() => {
    if (!open) {
      setLoading(false);
      return;
    }
    let controller: AbortController | undefined;
    const timer = window.setTimeout(
      async () => {
        controller = new AbortController();
        setLoading(true);
        setLoadError('');
        try {
          const params = new URLSearchParams({ limit: '8' });
          if (query.trim()) params.set('q', query.trim());
          const result = await request<{ items: UserOption[] }>(
            `/api/admin/profit-pool/user-options?${params}`,
            { signal: controller.signal },
          );
          setItems(result.items);
          setActiveIndex(
            result.items.findIndex(
              (user) => userOptionAvailability(user, mode, currentAgentId).allowed,
            ),
          );
        } catch (error) {
          if ((error as Error).name !== 'AbortError') {
            setItems([]);
            setLoadError('用户读取失败，请重新搜索');
          }
        } finally {
          if (!controller.signal.aborted) setLoading(false);
        }
      },
      query.trim() ? 220 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller?.abort();
    };
  }, [currentAgentId, mode, open, query]);

  function select(user: UserOption) {
    if (!userOptionAvailability(user, mode, currentAgentId).allowed) return;
    onChange(user);
    setQuery(userOptionName(user));
    setOpen(false);
  }

  function moveActive(delta: number) {
    const eligible = items
      .map((user, index) =>
        userOptionAvailability(user, mode, currentAgentId).allowed ? index : -1,
      )
      .filter((index) => index >= 0);
    if (!eligible.length) return;
    const position = eligible.indexOf(activeIndex);
    const next =
      position < 0
        ? delta > 0
          ? 0
          : eligible.length - 1
        : (position + delta + eligible.length) % eligible.length;
    setActiveIndex(eligible[next]);
  }

  return (
    <div className={`pp-user-picker ${inlineResults ? 'inline-results' : ''}`} ref={rootRef}>
      <div className={`pp-user-search ${value ? 'selected' : ''}`}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>
        <input
          value={query}
          role="combobox"
          aria-label={placeholder}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          autoComplete="off"
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            if (value) onChange(null);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setOpen(true);
              moveActive(1);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              moveActive(-1);
            } else if (event.key === 'Enter' && open && activeIndex >= 0) {
              event.preventDefault();
              select(items[activeIndex]);
            } else if (event.key === 'Escape') {
              setOpen(false);
            }
          }}
        />
        {loading && <span className="pp-user-spinner" aria-label="正在读取用户" />}
        {value && !loading && (
          <button
            type="button"
            className="pp-user-clear"
            aria-label="清除已选用户"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onChange(null);
              setQuery('');
              setOpen(true);
            }}
          >
            ×
          </button>
        )}
      </div>

      {value && (
        <div className="pp-user-selected">
          <span>{userOptionName(value).slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{userOptionName(value)}</strong>
            <small>
              UID {value.uid}
              {value.tgUsername ? ` · @${value.tgUsername}` : ''}
            </small>
          </div>
          <em>余额 RM {rm(value.availableCents)}</em>
          <b>已选择</b>
        </div>
      )}

      {open && (
        <div className="pp-user-options" id={listId} role="listbox">
          <header>
            <span>{query.trim() ? '搜索结果' : '最近注册用户'}</span>
            <small>可搜索 UID、昵称或 Telegram</small>
          </header>
          {loadError ? (
            <div className="pp-user-empty error">{loadError}</div>
          ) : !loading && items.length === 0 ? (
            <div className="pp-user-empty">没有找到匹配用户，请换关键词</div>
          ) : (
            items.map((user, index) => {
              const availability = userOptionAvailability(user, mode, currentAgentId);
              return (
                <button
                  type="button"
                  role="option"
                  id={`${listId}-${index}`}
                  key={user.id}
                  aria-selected={value?.id === user.id}
                  disabled={!availability.allowed}
                  className={activeIndex === index ? 'active' : ''}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => availability.allowed && setActiveIndex(index)}
                  onClick={() => select(user)}
                >
                  <span className="pp-user-avatar">
                    {userOptionName(user).slice(0, 1).toUpperCase()}
                  </span>
                  <span className="pp-user-identity">
                    <strong>{userOptionName(user)}</strong>
                    <small>
                      UID {user.uid}
                      {user.tgUsername ? ` · @${user.tgUsername}` : ''}
                    </small>
                  </span>
                  <span className="pp-user-option-meta">
                    <strong>RM {rm(user.availableCents)}</strong>
                    <small className={availability.allowed ? 'available' : ''}>
                      {availability.reason}
                    </small>
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function HouseInviteCard({ invite }: { invite: Row | null }) {
  const [copied, setCopied] = useState('');
  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied(''), 1600);
    } catch {
      setCopied('');
    }
  }
  if (!invite?.uid) {
    return (
      <div className="pp-house-card">
        <p>官方邀请码尚未生成。重启后端后会自动设为 8888888888。</p>
      </div>
    );
  }
  return (
    <div className="pp-house-card">
      <div className="pp-house-head">
        <div>
          <small>总后台邀请码</small>
          <strong>{invite.uid}</strong>
          <p>
            邀请关系走返水：谁分享二维码，下级流水就给谁返水。称桶是另一套，要在后台单独搜索用户并绑定 / 加成代理。
          </p>
        </div>
        <em>官方入口</em>
      </div>
      <div className="pp-house-actions">
        <button type="button" className="primary small" onClick={() => void copy(String(invite.uid), 'uid')}>
          {copied === 'uid' ? '已复制邀请码' : '复制邀请码'}
        </button>
        {invite.deepLink && (
          <button type="button" className="small" onClick={() => void copy(String(invite.deepLink), 'link')}>
            {copied === 'link' ? '已复制邀请链接' : '复制 Telegram 邀请链接'}
          </button>
        )}
      </div>
      <ol className="pp-house-steps">
        <li>
          <b>1</b>
          <span>把 8888888888 或官方二维码发出去。新玩家绑定后进场，邀请关系生效，分享二维码的人拿推广返水。</span>
        </li>
        <li>
          <b>2</b>
          <span>称桶不自动产生。要在下方搜索用户，加成第一层代理或点「管理玩家」手动绑定，才会进入利润池分成。</span>
        </li>
        <li>
          <b>3</b>
          <span>加成代理后，他再用自己的二维码拉人：返水按邀请关系算，称桶按你在后台绑的代理线算，两套同时有效。</span>
        </li>
      </ol>
    </div>
  );
}

/* ——— 代理管理（树形：第一层后台建，下级由代理前台升级产生） ——— */
function AgentManager({
  agents,
  poolAgents,
  houseInvite,
  bucketBase,
  minReservePoints,
  tierPresets,
  settled,
  onChanged,
  onError,
}: {
  agents: Row[];
  poolAgents: Row[];
  houseInvite: Row | null;
  bucketBase: number;
  minReservePoints: number;
  tierPresets: Array<{ label: string; points: number }>;
  settled: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [agentUser, setAgentUser] = useState<UserOption | null>(null);
  const [label, setLabel] = useState('');
  const [points, setPoints] = useState('65');
  const [creating, setCreating] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [players, setPlayers] = useState<Row[]>([]);
  const [bindUser, setBindUser] = useState<UserOption | null>(null);
  const [binding, setBinding] = useState(false);
  const poolByAgent = useMemo(
    () => new Map(poolAgents.map((agent) => [agent.agentId, agent])),
    [poolAgents],
  );
  /** 树形排序：根（第一层）按创建顺序，子级紧跟父级并记录缩进深度 */
  const treeRows = useMemo(() => {
    const byParent = new Map<string | null, Row[]>();
    const ids = new Set(agents.map((agent) => agent.id));
    for (const agent of agents) {
      const parentKey =
        agent.parentAgentId && ids.has(agent.parentAgentId) ? agent.parentAgentId : null;
      const list = byParent.get(parentKey) ?? [];
      list.push(agent);
      byParent.set(parentKey, list);
    }
    const rows: Array<{ agent: Row; depth: number }> = [];
    const walk = (parentKey: string | null, depth: number) => {
      for (const agent of byParent.get(parentKey) ?? []) {
        rows.push({ agent, depth });
        walk(agent.id, depth + 1);
      }
    };
    walk(null, 0);
    return rows;
  }, [agents]);

  async function create() {
    if (!agentUser) return;
    setCreating(true);
    try {
      await post('/api/admin/profit-pool/agents', {
        uid: agentUser.uid,
        label: label.trim(),
        sharePoints: Number(points),
      });
      setAgentUser(null);
      setLabel('');
      onChanged();
    } catch (err) {
      onError(errText(err));
    } finally {
      setCreating(false);
    }
  }

  async function loadPlayers(agentId: string) {
    try {
      const result = await request<{ items: Row[] }>(
        `/api/admin/profit-pool/agents/${agentId}/players`,
      );
      setPlayers(result.items);
    } catch (err) {
      onError(errText(err));
    }
  }

  async function toggleExpand(agentId: string) {
    if (expandedId === agentId) {
      setExpandedId(null);
      setBindUser(null);
      return;
    }
    setExpandedId(agentId);
    setPlayers([]);
    setBindUser(null);
    await loadPlayers(agentId);
  }

  async function editPoints(agent: Row) {
    // 树内合法区间：≤ 上级 − 预留；≥ 最大直属下级 + 预留
    const maxByParent = agent.parent
      ? Number(agent.parent.sharePoints) - minReservePoints
      : bucketBase;
    const childPoints = agents
      .filter((row) => row.parentAgentId === agent.id)
      .map((row) => Number(row.sharePoints));
    const minByChildren = childPoints.length
      ? Math.max(...childPoints) + minReservePoints
      : 0;
    const input = prompt(
      `设置「${agent.label}」的称桶占成点数\n` +
        `允许范围：${minByChildren}–${maxByParent}（上级须预留 ${minReservePoints} 点差额）\n` +
        `实得比例 = 点数 ÷ ${bucketBase}\n预设：${tierPresets.map((t) => `${t.label}=${t.points}`).join(' / ')}`,
      String(agent.sharePoints),
    );
    if (input == null) return;
    const value = Number(input);
    if (!Number.isInteger(value) || value < minByChildren || value > maxByParent) {
      onError(`占成点数必须是 ${minByChildren}–${maxByParent} 的整数（受上下级与预留限制）`);
      return;
    }
    try {
      await patch(`/api/admin/profit-pool/agents/${agent.id}`, { sharePoints: value });
      onChanged();
    } catch (err) {
      onError(errText(err));
    }
  }

  async function toggleStatus(agent: Row) {
    try {
      await patch(`/api/admin/profit-pool/agents/${agent.id}`, {
        status: agent.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE',
      });
      onChanged();
    } catch (err) {
      onError(errText(err));
    }
  }

  async function bind(agentId: string) {
    if (!bindUser) return;
    setBinding(true);
    try {
      await post(`/api/admin/profit-pool/agents/${agentId}/players`, { uid: bindUser.uid });
      setBindUser(null);
      await loadPlayers(agentId);
      onChanged();
    } catch (err) {
      onError(errText(err));
    } finally {
      setBinding(false);
    }
  }

  async function unbind(agentId: string, userId: string) {
    try {
      await del(`/api/admin/profit-pool/agents/${agentId}/players/${userId}`);
      await loadPlayers(agentId);
      onChanged();
    } catch (err) {
      onError(errText(err));
    }
  }

  return (
    <section className="panel">
      <div className="panel-title">
        <div>
          <small>代理管理</small>
          <h2>代理 / 股东与占成</h2>
        </div>
        <span>{agents.length} 位代理 · {agents.filter((agent) => agent.status === 'ACTIVE').length} 位启用</span>
      </div>

      <HouseInviteCard invite={houseInvite} />

      <div className="pp-agent-create">
        <header>
          <div>
            <strong>新增第一层代理</strong>
            <small>先从系统用户中选择，不需要再复制或记住 UID</small>
          </div>
          <span>仅后台可建立</span>
        </header>
        <div className="pp-agent-create-grid">
          <div className="pp-form-field pp-form-field-user">
            <div className="pp-field-label">
              <i>1</i>
              <span>选择用户</span>
              <em>必选</em>
            </div>
            <UserPicker
              value={agentUser}
              mode="agent"
              placeholder="搜索 UID、昵称或 Telegram"
              onChange={(user) => {
                setAgentUser(user);
                if (user) setLabel(userOptionName(user));
              }}
            />
          </div>

          <label className="pp-form-field">
            <span className="pp-field-label">
              <i>2</i>
              <span>代理显示名称</span>
            </span>
            <input
              value={label}
              maxLength={30}
              disabled={!agentUser}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="选择用户后自动填写，可修改"
            />
            <small>报表和代理树中显示的名称</small>
          </label>

          <label className="pp-form-field">
            <span className="pp-field-label">
              <i>3</i>
              <span>初始占成</span>
            </span>
            <select value={points} onChange={(event) => setPoints(event.target.value)}>
              {tierPresets.map((tier) => (
                <option key={tier.label} value={tier.points}>
                  {tier.label} · {tier.points}/{bucketBase} ·{' '}
                  {((tier.points / bucketBase) * 100).toFixed(1)}%
                </option>
              ))}
            </select>
            <small>
              当前实得比例约 {((Number(points) / bucketBase) * 100).toFixed(1)}%
            </small>
          </label>

          <div className="pp-agent-create-action">
            <button
              type="button"
              className="primary"
              disabled={!agentUser || !label.trim() || creating}
              onClick={() => void create()}
            >
              <strong>{creating ? '正在建立…' : '建立第一层代理'}</strong>
              <small>{agentUser ? `绑定 UID ${agentUser.uid}` : '请先选择用户'}</small>
            </button>
          </div>
        </div>
      </div>

      <div className="pp-agent-guide">
        <strong>下级怎么来？</strong>
        <span>
          第一层代理由后台建立。他邀请的新玩家会自动归到他名下；他再在玩家端「玩家列表 → 升级代理」发展下级，须预留至少 {minReservePoints} 点差额。
        </span>
      </div>

      <div className="table-wrap">
        <table className="pp-agent-table">
          <thead>
            <tr>
              <th>代理资料</th>
              <th>占成</th>
              <th>直属成员</th>
              <th>流水（自身 / 团队）</th>
              <th>团队贡献</th>
              <th>{settled ? '实发分成' : '预估分成'}</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {treeRows.map(({ agent, depth }) => {
              const stat = poolByAgent.get(agent.id);
              return (
                <Fragment key={agent.id}>
                  <tr key={agent.id}>
                    <td>
                      <span className="pp-tree" style={{ paddingLeft: depth * 18 }}>
                        {depth > 0 && <i className="pp-tree-branch">└</i>}
                        <span className="pp-agent-identity">
                          <span>
                            <strong>{agent.label}</strong>
                            {depth === 0 && <em className="pp-tree-tag">第一层</em>}
                          </span>
                          <small>
                            {agent.user?.nickname ?? '未设置昵称'} · UID {agent.user?.uid}
                          </small>
                        </span>
                      </span>
                    </td>
                    <td>
                      <button className="pp-points" onClick={() => void editPoints(agent)}>
                        {agent.sharePoints}/{bucketBase}
                      </button>
                      <small className="pp-cell-note">
                        ≈ {((Number(agent.sharePoints) / bucketBase) * 100).toFixed(1)}%
                      </small>
                    </td>
                    <td className="pp-member-cell">
                      <strong>{agent._count?.players ?? 0} 位玩家</strong>
                      <small>{agent._count?.children ?? 0} 位直属下级</small>
                    </td>
                    <td className="pp-value-stack">
                      <span>
                        <small>自身</small>
                        <strong>RM {rm(stat?.selfTurnoverCents ?? stat?.turnoverCents ?? 0)}</strong>
                      </span>
                      <span>
                        <small>团队</small>
                        <strong>RM {rm(stat?.teamTurnoverCents ?? 0)}</strong>
                      </span>
                    </td>
                    <td className="pp-contribution-cell">
                      <strong>{pct(Number(stat?.contributionBp ?? 0))}</strong>
                      <small>公司总流水占比</small>
                    </td>
                    <td className="pp-share-cell">
                      <strong className="money">RM {rm(stat?.amountCents ?? 0)}</strong>
                      <small>
                        自身 RM {rm(stat?.selfAmountCents ?? 0)} · 差额 RM{' '}
                        {rm(stat?.overrideAmountCents ?? 0)}
                      </small>
                    </td>
                    <td>
                      <span className={`pp-status ${agent.status === 'ACTIVE' ? 'on' : 'off'}`}>
                        {agent.status === 'ACTIVE' ? '启用' : '停用'}
                      </span>
                    </td>
                    <td className="pp-actions">
                      <button onClick={() => void toggleExpand(agent.id)}>
                        {expandedId === agent.id ? '收起玩家' : '管理玩家'}
                      </button>
                      <button onClick={() => void toggleStatus(agent)}>
                        {agent.status === 'ACTIVE' ? '停用' : '启用'}
                      </button>
                    </td>
                  </tr>
                  {expandedId === agent.id && (
                    <tr className="pp-expand" key={`${agent.id}-players`}>
                      <td colSpan={8}>
                        <div className="pp-player-manager">
                          <header>
                            <div>
                              <strong>{agent.label} · 归属玩家管理</strong>
                              <small>从系统用户中搜索并选择，已是代理或已有归属的用户不可重复绑定</small>
                            </div>
                            <span>{players.length} 位直属玩家</span>
                          </header>
                          <div className="pp-player-bind-row">
                            <UserPicker
                              value={bindUser}
                              mode="player"
                              currentAgentId={agent.id}
                              placeholder="搜索要绑定的玩家"
                              inlineResults
                              onChange={setBindUser}
                            />
                            <button
                              className="primary small"
                              disabled={!bindUser || binding}
                              onClick={() => void bind(agent.id)}
                            >
                              {binding ? '绑定中…' : '确认绑定'}
                            </button>
                          </div>
                          <div className="pp-players">
                            {players.length === 0 && (
                              <small className="pp-player-empty">
                                暂无直属玩家，可在上方搜索用户后绑定
                              </small>
                            )}
                            {players.map((binding) => (
                              <span className="pp-player-chip" key={binding.userId}>
                                {binding.user?.nickname ?? 'UID'} · {binding.user?.uid}
                                {binding.source === 'REFERRAL' && (
                                  <i className="pp-ref-tag">推荐</i>
                                )}
                                <button
                                  title="解绑"
                                  onClick={() => void unbind(agent.id, binding.userId)}
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {agents.length === 0 && (
          <p className="pp-empty">
            尚无代理。请在上方搜索并选择一个系统用户，然后建立第一层代理。
          </p>
        )}
      </div>
    </section>
  );
}

/* ——— 配置 ——— */
function ConfigPanel({
  config,
  onSaved,
  onError,
}: {
  config: Row;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [expense, setExpense] = useState(String((Number(config.expenseRatio) * 100).toFixed(2)));
  const [base, setBase] = useState(String(config.bucketBase));
  const [reserve, setReserve] = useState(String(config.minReservePoints ?? 5));
  const [autoSettle, setAutoSettle] = useState(Boolean(config.autoSettle));

  useEffect(() => {
    setExpense(String((Number(config.expenseRatio) * 100).toFixed(2)));
    setBase(String(config.bucketBase));
    setReserve(String(config.minReservePoints ?? 5));
    setAutoSettle(Boolean(config.autoSettle));
  }, [config]);

  async function save() {
    const ratio = Number(expense) / 100;
    const bucketBase = Number(base);
    const minReservePoints = Number(reserve);
    if (!(ratio >= 0 && ratio <= 1)) {
      onError('支出比例必须在 0–100 之间');
      return;
    }
    if (!Number.isInteger(minReservePoints) || minReservePoints < 0) {
      onError('最低预留点数必须是不小于 0 的整数');
      return;
    }
    try {
      await put('/api/admin/profit-pool/config', {
        expenseRatio: ratio,
        bucketBase,
        minReservePoints,
        autoSettle,
      });
      onSaved();
    } catch (err) {
      onError(errText(err));
    }
  }

  return (
    <section className="panel">
      <div className="panel-title">
        <div>
          <small>全局参数</small>
          <h2>利润池配置</h2>
        </div>
      </div>
      <div className="inline-form pp-config-form">
        <label>
          公司支出比例（% 流水）
          <input value={expense} onChange={(e) => setExpense(e.target.value)} />
        </label>
        <label>
          称桶基准
          <input value={base} onChange={(e) => setBase(e.target.value)} />
        </label>
        <label>
          最低预留点数（上级给下级）
          <input value={reserve} onChange={(e) => setReserve(e.target.value)} />
        </label>
        <label className="pp-check">
          <input
            type="checkbox"
            checked={autoSettle}
            onChange={(e) => setAutoSettle(e.target.checked)}
          />
          每日自动生成前一日报表（发放始终需手动确认）
        </label>
        <button className="primary small" onClick={() => void save()}>
          保存配置
        </button>
      </div>
      <p className="pp-hint">
        抽水比例（玩家赢 3% / 庄家赢 5%）在「游戏运营中心 → 游戏配置 → 费用与抽水」中调整；
        净利润池为负时当日不分配，负额自动结转次日冲抵；
        分配采用占成差额制：上级赚取与直属下级的占成差额，同一笔利润不重复分配。
      </p>
    </section>
  );
}

/* ——— 历史 ——— */
function HistoryPanel({ items }: { items: Row[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <section className="panel">
      <div className="panel-title">
        <div>
          <small>近 30 个已结算业务日</small>
          <h2>分配历史</h2>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>日期</th>
              <th>抽水毛利</th>
              <th>总流水</th>
              <th>支出</th>
              <th>结转</th>
              <th>净利润池</th>
              <th>已分配</th>
              <th>公司留存</th>
              <th>状态</th>
              <th>明细</th>
            </tr>
          </thead>
          <tbody>
            {items.map((pool) => (
              <>
                <tr key={pool.id}>
                  <td>{pool.date}</td>
                  <td>RM {rm(pool.rakeTotalCents)}</td>
                  <td>RM {rm(pool.turnoverCents)}</td>
                  <td>RM {rm(pool.expenseCents)}</td>
                  <td>{rmSigned(pool.carryInCents)}</td>
                  <td className="money">{rmSigned(pool.netPoolCents)}</td>
                  <td>RM {rm(pool.distributedCents)}</td>
                  <td>RM {rm(pool.residualCents)}</td>
                  <td>
                    <span
                      className={`pp-status ${
                        pool.status === 'SETTLED' ? 'on' : pool.status === 'PENDING' ? 'pending' : 'off'
                      }`}
                    >
                      {pool.status === 'SETTLED'
                        ? '已发放'
                        : pool.status === 'PENDING'
                          ? '待确认发放'
                          : '不分配（负池结转）'}
                    </span>
                  </td>
                  <td>
                    {(pool.shares?.length ?? 0) > 0 ? (
                      <button onClick={() => setOpenId(openId === pool.id ? null : pool.id)}>
                        {openId === pool.id ? '收起' : `${pool.shares.length} 个代理`}
                      </button>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
                {openId === pool.id && (
                  <tr className="pp-expand" key={`${pool.id}-shares`}>
                    <td colSpan={10}>
                      <div className="pp-share-list">
                        {pool.shares.map((share: Row) => (
                          <span className="pp-player-chip" key={share.id}>
                            {share.agent?.label}（UID {share.agent?.user?.uid}） 占成{' '}
                            {share.sharePointsSnapshot}/{share.bucketBaseSnapshot} · 自身 RM{' '}
                            {rm(share.selfAmountCents ?? 0)} + 差额 RM{' '}
                            {rm(share.overrideAmountCents ?? 0)} → <b>RM {rm(share.amountCents)}</b>
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
        {items.length === 0 && <p className="pp-empty">尚无已结算的利润池记录</p>}
      </div>
    </section>
  );
}
