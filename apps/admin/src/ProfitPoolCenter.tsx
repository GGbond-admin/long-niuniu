/**
 * 按局数称桶利润池后台：四步结算、永久局锁、历史快照、代理网络大屏与专属看板。
 */
import { useEffect, useState } from 'react';
import { post, put, request, rm } from './api';
import AgentNetworkScreen from './profit-pool/AgentNetworkScreen';
import BatchHistory from './profit-pool/BatchHistory';
import BatchReport from './profit-pool/BatchReport';
import SettlementWizard from './profit-pool/SettlementWizard';

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

type PoolTab = 'settlement' | 'network' | 'history' | 'config';

export default function ProfitPoolCenter() {
  const [tab, setTab] = useState<PoolTab>('settlement');
  const [overview, setOverview] = useState<Row | null>(null);
  const [legacyPending, setLegacyPending] = useState<Row[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  async function load() {
    setError('');
    try {
      const [ov, legacy] = await Promise.all([
        request<Row>('/api/admin/profit-pool/overview'),
        request<{ items: Row[] }>('/api/admin/profit-pool/legacy/pending'),
      ]);
      setOverview(ov);
      setLegacyPending(legacy.items);
    } catch (err) {
      setError(errText(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const config = overview?.config as Row | undefined;
  const pendingCount = Number(overview?.statusCounts?.PENDING ?? 0);
  const tabs: Array<{ id: PoolTab; label: string }> = [
    { id: 'settlement', label: '称桶利润池' },
    { id: 'network', label: '代理网络' },
    { id: 'history', label: pendingCount ? `历史报表 · ${pendingCount} 待分配` : '历史报表' },
    { id: 'config', label: '参数配置' },
  ];

  async function changed(message?: string) {
    if (message) setNotice(message);
    setRefreshKey((value) => value + 1);
    await load();
  }

  async function discardLegacy(date: string) {
    if (
      !confirm(
        `删除旧按日报表 ${date}？\n该报表尚未发放。删除后才能使用新的按局数利润池；操作会写入审计日志。`,
      )
    ) {
      return;
    }
    try {
      await post(`/api/admin/profit-pool/legacy/${date}/discard`, {});
      await changed(`${date} 旧按日待发报表已删除`);
    } catch (err) {
      setError(errText(err));
    }
  }

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
        {tab === 'settlement' && (
          <>
            {legacyPending.length > 0 && (
              <section className="ppx-legacy-warning">
                <div>
                  <strong>切换前还有 {legacyPending.length} 份旧按日报表待处理</strong>
                  <span>为防止同一局重复发放，新按局数利润池会暂时禁止生成。请确认这些旧报表未付款后逐份删除。</span>
                </div>
                <div>
                  {legacyPending.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      onClick={() => void discardLegacy(item.date)}
                    >
                      删除 {item.date} 待发日报
                    </button>
                  ))}
                </div>
              </section>
            )}
            {selectedBatchId ? (
              <BatchReport
                poolId={selectedBatchId}
                onClose={() => setSelectedBatchId(null)}
                onChanged={() => void changed('利润池状态已更新')}
                onError={setError}
              />
            ) : (
              <>
                <SettlementWizard
                  defaultExpenseRatio={Number(config?.expenseRatio ?? 0.025)}
                  onGenerated={(poolId, poolCode) => {
                    setSelectedBatchId(poolId);
                    void changed(`${poolCode} 已生成。未发放前仍可撤回重做`);
                  }}
                  onError={setError}
                />
                <BatchHistory
                  compact
                  refreshKey={refreshKey}
                  onSelect={setSelectedBatchId}
                  onError={setError}
                  onChanged={() => void changed('利润池已撤回，局锁已释放')}
                />
              </>
            )}
          </>
        )}

        {tab === 'network' && (
          <AgentNetworkScreen
            onError={setError}
            houseInvite={(overview?.houseInvite as Row | undefined) ?? null}
            bucketBase={Number(config?.bucketBase ?? 130)}
            minReservePoints={Number(config?.minReservePoints ?? 5)}
            tierPresets={(config?.tierPresets as Array<{ label: string; points: number }>) ?? []}
            onChanged={() => void changed('代理资料已更新，下一批将使用新配置')}
          />
        )}

        {tab === 'history' &&
          (selectedBatchId ? (
            <BatchReport
              poolId={selectedBatchId}
              onClose={() => setSelectedBatchId(null)}
              onChanged={() => void changed('利润池状态已更新')}
              onError={setError}
            />
          ) : (
            <BatchHistory
              refreshKey={refreshKey}
              onSelect={setSelectedBatchId}
              onError={setError}
              onChanged={() => void changed('利润池已撤回，局锁已释放')}
            />
          ))}

        {tab === 'config' &&
          (config ? (
            <ConfigPanel config={config} onSaved={() => void changed('参数已保存')} onError={setError} />
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
    { label: '玩家赢抽水', value: rmSigned(pool.rakePlayerCents) },
    { label: '庄家盈利抽水', value: rmSigned(pool.rakeBankerCents) },
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
    return <p className="pp-empty">尚未配置代理。在「代理网络」建立第一层并绑定玩家后，此处展示贡献占比。</p>;
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

  useEffect(() => {
    setExpense(String((Number(config.expenseRatio) * 100).toFixed(2)));
    setBase(String(config.bucketBase));
    setReserve(String(config.minReservePoints ?? 5));
  }, [config]);

  async function save() {
    const ratio = Number(expense) / 100;
    const bucketBase = Number(base);
    const minReservePoints = Number(reserve);
    if (!(ratio >= 0 && ratio <= 1)) {
      onError('支出比例必须在 0–100 之间');
      return;
    }
    if (!Number.isInteger(bucketBase) || bucketBase < 1 || bucketBase > 10_000) {
      onError('称桶基准必须是 1–10000 的整数');
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
        <button className="primary small" onClick={() => void save()}>
          保存配置
        </button>
      </div>
      <p className="pp-hint">
        抽水比例以「游戏运营中心 → 游戏配置 → 费用与抽水」当前设置为准；
        每一批支出比例仍须在生成向导中明确确认，默认值只用于预填；
        新利润池只按房间局号范围生成，不再自动生成日报；
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
