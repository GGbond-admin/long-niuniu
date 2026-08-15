/**
 * 利润池与称桶分配中心 — 对应《利润池与称桶分配模式说明文档》
 * 链路可视化：抽水（玩家3%/庄家5%）→ 毛利 → 扣支出 → 净利润池 → 按流水贡献 × 占成/130 分配
 */
import { useEffect, useMemo, useState } from 'react';
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

export default function ProfitPoolCenter() {
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
  const canSettle = Boolean(pool && !pool.settled && date < today);

  async function settle() {
    if (!pool) return;
    const netRm = rmSigned(pool.netPoolCents);
    const distRm = rmSigned(pool.distributedCents);
    if (
      !confirm(
        `确认结算 ${date} 利润池？\n净利润池 ${netRm}，将向代理发放合计 ${distRm}。\n结算后立即入账，不可撤销。`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await post('/api/admin/profit-pool/settle', { date });
      setNotice(`${date} 利润池已结算，代理分成已发放`);
      await load(date);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="toolbar standalone">
        <div className="toolbar-hint">
          <small>业务日（马来西亚时区）</small>
          <span>抽水毛利 → 扣支出 → 净利润池 → 称桶分配</span>
        </div>
        <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
        <button
          className="primary small"
          disabled={!canSettle || busy}
          title={
            pool?.settled
              ? '该日已结算'
              : date >= today
                ? '当日尚未结束，只能结算已结束的日期'
                : ''
          }
          onClick={() => void settle()}
        >
          {pool?.settled ? '已结算' : busy ? '结算中…' : '执行称桶结算'}
        </button>
        <button className="small" onClick={() => void load(date)}>
          刷新
        </button>
      </div>
      {error && <div className="error-box">{error}</div>}
      {notice && (
        <div className="pp-notice" onClick={() => setNotice('')}>
          {notice}（点击关闭）
        </div>
      )}

      {pool && (
        <>
          <PoolMetrics pool={pool} settled={Boolean(pool.settled)} />
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

      <AgentManager
        agents={agents}
        poolAgents={(pool?.agents as Row[]) ?? []}
        bucketBase={Number(config?.bucketBase ?? 130)}
        tierPresets={(config?.tierPresets as Array<{ label: string; points: number }>) ?? []}
        settled={Boolean(pool?.settled)}
        onChanged={() => void load(date)}
        onError={(message) => setError(message)}
      />

      {config && (
        <ConfigPanel config={config} onSaved={() => void load(date)} onError={setError} />
      )}

      <HistoryPanel items={history} />
    </>
  );
}

/* ——— 指标卡 ——— */
function PoolMetrics({ pool, settled }: { pool: Row; settled: boolean }) {
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
      label: settled ? '净利润池（已结算）' : '净利润池（实时预估）',
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
      <em>代理所得 = 净池 × (代理流水 ÷ 公司流水) × (占成点数 ÷ {pool.bucketBase})</em>
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
              流水 RM {rm(agent.turnoverCents)} · 占比 {pct(Number(agent.contributionBp))} · 占成{' '}
              {agent.sharePoints}
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

/* ——— 代理管理 ——— */
function AgentManager({
  agents,
  poolAgents,
  bucketBase,
  tierPresets,
  settled,
  onChanged,
  onError,
}: {
  agents: Row[];
  poolAgents: Row[];
  bucketBase: number;
  tierPresets: Array<{ label: string; points: number }>;
  settled: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [uid, setUid] = useState('');
  const [label, setLabel] = useState('');
  const [points, setPoints] = useState('65');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [players, setPlayers] = useState<Row[]>([]);
  const [bindUid, setBindUid] = useState('');
  const poolByAgent = useMemo(
    () => new Map(poolAgents.map((agent) => [agent.agentId, agent])),
    [poolAgents],
  );

  async function create() {
    try {
      await post('/api/admin/profit-pool/agents', {
        uid: uid.trim(),
        label: label.trim(),
        sharePoints: Number(points),
      });
      setUid('');
      setLabel('');
      onChanged();
    } catch (err) {
      onError(errText(err));
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
      return;
    }
    setExpandedId(agentId);
    setPlayers([]);
    await loadPlayers(agentId);
  }

  async function editPoints(agent: Row) {
    const input = prompt(
      `设置「${agent.label}」的称桶占成点数（0–${bucketBase}）\n实得比例 = 点数 ÷ ${bucketBase}\n预设：${tierPresets.map((t) => `${t.label}=${t.points}`).join(' / ')}`,
      String(agent.sharePoints),
    );
    if (input == null) return;
    const value = Number(input);
    if (!Number.isInteger(value) || value < 0 || value > bucketBase) {
      onError(`占成点数必须是 0–${bucketBase} 的整数`);
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
    try {
      await post(`/api/admin/profit-pool/agents/${agentId}/players`, { uid: bindUid.trim() });
      setBindUid('');
      await loadPlayers(agentId);
      onChanged();
    } catch (err) {
      onError(errText(err));
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
      </div>
      <div className="inline-form pp-agent-form">
        <input value={uid} onChange={(e) => setUid(e.target.value)} placeholder="用户 UID" />
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="代理名称（如 A代理）" />
        <select value={points} onChange={(e) => setPoints(e.target.value)}>
          {tierPresets.map((tier) => (
            <option key={tier.label} value={tier.points}>
              {tier.label}（{tier.points}/{bucketBase} ≈ {((tier.points / bucketBase) * 100).toFixed(1)}%）
            </option>
          ))}
        </select>
        <button className="primary small" disabled={!uid.trim() || !label.trim()} onClick={() => void create()}>
          ＋ 新增代理
        </button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>代理</th>
              <th>绑定账号</th>
              <th>占成点数</th>
              <th>实得比例</th>
              <th>归属玩家</th>
              <th>当日流水</th>
              <th>贡献比</th>
              <th>{settled ? '实发分成' : '预估分成'}</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => {
              const stat = poolByAgent.get(agent.id);
              return (
                <>
                  <tr key={agent.id}>
                    <td>
                      <strong>{agent.label}</strong>
                    </td>
                    <td>
                      {agent.user?.nickname ?? '—'}
                      <small>UID {agent.user?.uid}</small>
                    </td>
                    <td>
                      <button className="pp-points" onClick={() => void editPoints(agent)}>
                        {agent.sharePoints}/{bucketBase}
                      </button>
                    </td>
                    <td>{((agent.sharePoints / bucketBase) * 100).toFixed(1)}%</td>
                    <td>{agent._count?.players ?? 0} 人</td>
                    <td>RM {rm(stat?.turnoverCents ?? 0)}</td>
                    <td>{pct(Number(stat?.contributionBp ?? 0))}</td>
                    <td className="money">RM {rm(stat?.amountCents ?? 0)}</td>
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
                      <td colSpan={10}>
                        <div className="inline-form">
                          <input
                            value={bindUid}
                            onChange={(e) => setBindUid(e.target.value)}
                            placeholder="输入玩家 UID 绑定到该代理"
                          />
                          <button
                            className="primary small"
                            disabled={!bindUid.trim()}
                            onClick={() => void bind(agent.id)}
                          >
                            绑定玩家
                          </button>
                        </div>
                        <div className="pp-players">
                          {players.length === 0 && <small>该代理暂无归属玩家</small>}
                          {players.map((binding) => (
                            <span className="pp-player-chip" key={binding.userId}>
                              {binding.user?.nickname ?? 'UID'} · {binding.user?.uid}
                              <button
                                title="解绑"
                                onClick={() => void unbind(agent.id, binding.userId)}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
        {agents.length === 0 && (
          <p className="pp-empty">尚无代理。输入用户 UID 新增代理后，把玩家绑定到代理名下即可参与称桶分配。</p>
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
  const [autoSettle, setAutoSettle] = useState(Boolean(config.autoSettle));

  useEffect(() => {
    setExpense(String((Number(config.expenseRatio) * 100).toFixed(2)));
    setBase(String(config.bucketBase));
    setAutoSettle(Boolean(config.autoSettle));
  }, [config]);

  async function save() {
    const ratio = Number(expense) / 100;
    const bucketBase = Number(base);
    if (!(ratio >= 0 && ratio <= 1)) {
      onError('支出比例必须在 0–100 之间');
      return;
    }
    try {
      await put('/api/admin/profit-pool/config', {
        expenseRatio: ratio,
        bucketBase,
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
        <label className="pp-check">
          <input
            type="checkbox"
            checked={autoSettle}
            onChange={(e) => setAutoSettle(e.target.checked)}
          />
          每日自动结算前一日（关闭后需手动执行）
        </label>
        <button className="primary small" onClick={() => void save()}>
          保存配置
        </button>
      </div>
      <p className="pp-hint">
        抽水比例（玩家赢 3% / 庄家赢 5%）在「游戏运营中心 → 游戏配置 → 费用与抽水」中调整；
        净利润池为负时当日不分配，负额自动结转次日冲抵。
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
                    <span className={`pp-status ${pool.status === 'SETTLED' ? 'on' : 'off'}`}>
                      {pool.status === 'SETTLED' ? '已分配' : '不分配（负池结转）'}
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
                            {share.agent?.label}（UID {share.agent?.user?.uid}） 流水 RM{' '}
                            {rm(share.turnoverCents)} · 占成 {share.sharePointsSnapshot}/
                            {share.bucketBaseSnapshot} → <b>RM {rm(share.amountCents)}</b>
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
