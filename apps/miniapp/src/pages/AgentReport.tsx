/**
 * 代理专属：看板看整体，称桶报表看某一批名下完整快照。
 */
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, rm } from '../api';
import { goBack } from '../lib/nav';
import { markAgentReportSeen } from '../sessionStore';

const STATUS_LABEL = {
  PENDING: { text: '待分配', tone: 'pending' },
  DISTRIBUTED: { text: '已分配', tone: 'paid' },
  NO_DISTRIBUTION: { text: '无需分配', tone: 'none' },
} as const;

const TODAY_PENDING = '报表准备中 请在下午2点后查看';

function malaysiaDayOf(iso: string) {
  return new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Kuala_Lumpur' });
}

function formatReportDay(day: string) {
  const [year, month, date] = day.split('-');
  if (!year || !month || !date) return day;
  return `${Number(year)}年${Number(month)}月${Number(date)}日`;
}

function periodDay(period: { generatedDate?: string; generatedAt: string }) {
  return period.generatedDate || malaysiaDayOf(period.generatedAt);
}

function selectedDateLabel(generatedDate: string | undefined, today: string, isLatest: boolean) {
  if (generatedDate === today) return formatReportDay(generatedDate);
  if (isLatest || !generatedDate) return TODAY_PENDING;
  return formatReportDay(generatedDate);
}

type ReportData = Awaited<ReturnType<typeof api.agentReport>>;
type DownlineAgent = NonNullable<ReportData['selected']>['downline'][number];
type PeriodRoom = ReportData['periods'][number]['room'];

function gameLabel(room?: { title?: string; gameCode?: string } | null) {
  return room?.title?.trim() || room?.gameCode || '未知游戏';
}

function uniqueGames(periods: ReportData['periods']): PeriodRoom[] {
  const seen = new Map<string, PeriodRoom>();
  for (const period of periods) {
    if (!seen.has(period.room.gameCode)) seen.set(period.room.gameCode, period.room);
  }
  return [...seen.values()];
}

function Icon({
  name,
}: {
  name: 'network' | 'players' | 'profit' | 'history' | 'chevron';
}) {
  const paths = {
    network: <><circle cx="12" cy="5" r="2.5" /><circle cx="5" cy="18" r="2.5" /><circle cx="19" cy="18" r="2.5" /><path d="M12 7.5v4M5 15.5v-3h14v3" /></>,
    players: <><circle cx="9" cy="8" r="3" /><path d="M3.5 19c.4-4 2.2-6 5.5-6s5.1 2 5.5 6M16 5.5a2.5 2.5 0 0 1 0 5M16.5 13c2.5.4 3.8 2.4 4 5" /></>,
    profit: <><path d="M5 7h14v11H5zM8 4h8v3" /><path d="M8 12h8M12 9v6" /></>,
    history: <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2M4 4v5h5" /></>,
    chevron: <path d="m9 5 7 7-7 7" />,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function visibleDownline(
  items: DownlineAgent[],
  rootId: string,
  expanded: Set<string>,
) {
  const byParent = new Map<string, DownlineAgent[]>();
  for (const item of items) {
    const parent = item.parentAgentId ?? '';
    const list = byParent.get(parent) ?? [];
    list.push(item);
    byParent.set(parent, list);
  }
  const result: Array<{ item: DownlineAgent; depth: number; childCount: number }> = [];
  const visit = (parentId: string, depth: number) => {
    for (const item of byParent.get(parentId) ?? []) {
      const childCount = byParent.get(item.agentId)?.length ?? 0;
      result.push({ item, depth, childCount });
      if (childCount > 0 && expanded.has(item.agentId)) visit(item.agentId, depth + 1);
    }
  };
  visit(rootId, 0);
  return result;
}

export default function AgentReport() {
  const navigate = useNavigate();
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const reportOnly = searchParams.get('tab') === 'report';
  const requestedPoolId = searchParams.get('poolId') || undefined;
  const [poolId, setPoolId] = useState<string | undefined>(requestedPoolId);
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMorePeriods, setLoadingMorePeriods] = useState(false);
  const [loadingMorePlayers, setLoadingMorePlayers] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [gameFilter, setGameFilter] = useState<string>('all');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api
      .agentReport(poolId)
      .then((result) => {
        if (active) {
          setData((current) =>
            poolId && current
              ? {
                  ...result,
                  periods: [
                    ...current.periods,
                    ...result.periods.filter(
                      (item) =>
                        !current.periods.some((period) => period.poolId === item.poolId),
                    ),
                  ],
                  periodsNextCursor: current.periodsNextCursor,
                }
              : result,
          );
          const latestPoolId = result.periods[0]?.poolId;
          if (latestPoolId) markAgentReportSeen(result.profile.id, latestPoolId);
        }
      })
      .catch((reason) => {
        if (active) setError((reason as Error).message || '加载失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [poolId, reloadKey]);

  useEffect(() => {
    setExpanded(new Set());
  }, [poolId, data?.selected?.pool.id]);

  useEffect(() => {
    if (requestedPoolId) setPoolId(requestedPoolId);
  }, [requestedPoolId]);

  async function loadMorePeriods() {
    const cursor = data?.periodsNextCursor;
    if (!cursor || loadingMorePeriods) return;
    setLoadingMorePeriods(true);
    try {
      const result = await api.agentReportHistory(cursor);
      setData((current) =>
        current
          ? {
              ...current,
              periods: [
                ...current.periods,
                ...result.items.filter(
                  (item) => !current.periods.some((period) => period.poolId === item.poolId),
                ),
              ],
              periodsNextCursor: result.nextCursor,
            }
          : current,
      );
    } catch (reason) {
      setError((reason as Error).message || '加载历史批次失败');
    } finally {
      setLoadingMorePeriods(false);
    }
  }

  async function loadMorePlayers() {
    const selected = data?.selected;
    const cursor = selected?.playersNextCursor;
    if (!selected || !cursor || loadingMorePlayers) return;
    setLoadingMorePlayers(true);
    try {
      const result = await api.agentReportPlayers(selected.pool.id, cursor);
      setData((current) =>
        current?.selected && current.selected.pool.id === selected.pool.id
          ? {
              ...current,
              selected: {
                ...current.selected,
                players: [
                  ...current.selected.players,
                  ...result.items.filter(
                    (item) =>
                      !current.selected?.players.some(
                        (player) => player.userId === item.userId,
                      ),
                  ),
                ],
                playersNextCursor: result.nextCursor,
              },
            }
          : current,
      );
    } catch (reason) {
      setError((reason as Error).message || '加载直属玩家失败');
    } finally {
      setLoadingMorePlayers(false);
    }
  }

  if (!data && loading) return <div className="loading">加载中…</div>;
  if (!data) {
    return (
      <div className="page subpage ag2-page">
        <header className="subpage-header">
          <button type="button" onClick={() => goBack(navigate, location)} aria-label="返回">‹</button>
          <div><h1>{reportOnly ? '称桶报表' : '代理专属看板'}</h1></div>
          <span />
        </header>
        <div className="inline-alert error">{error}</div>
      </div>
    );
  }

  const selected = data.selected;
  const status = selected
    ? STATUS_LABEL[selected.pool.status] ?? { text: selected.pool.status, tone: 'none' }
    : null;
  const activePickerPeriod =
    data.periods.find((period) => period.poolId === (poolId ?? selected?.pool.id)) ??
    data.periods[0] ??
    null;
  const downlineRows = selected
    ? visibleDownline(selected.downline ?? [], data.profile.id, expanded)
    : [];
  const games = uniqueGames(data.periods);
  const visiblePeriods =
    gameFilter === 'all'
      ? data.periods
      : data.periods.filter((period) => period.room.gameCode === gameFilter);
  const recentPeriods = visiblePeriods.slice(0, 6);
  const recentMaxCents = recentPeriods.reduce(
    (max, item) => (BigInt(item.amountCents) > max ? BigInt(item.amountCents) : max),
    0n,
  );
  const today =
    data.profile.today
    || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kuala_Lumpur' });
  const hasTodayReport =
    data.periods.some((period) => periodDay(period) === today)
    || (selected ? periodDay(selected.pool) === today : false);
  const isLatestSelected = Boolean(
    selected && (data.periods[0]?.poolId ?? selected.pool.id) === selected.pool.id,
  );
  const selectedDate = selected
    ? selectedDateLabel(periodDay(selected.pool), today, isLatestSelected)
    : TODAY_PENDING;

  function toggleAgent(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="page subpage ag2-page">
      <header className="subpage-header ag2-header">
        <button type="button" onClick={() => goBack(navigate, location)} aria-label="返回">‹</button>
        <div>
          <small>{reportOnly ? 'BUCKET REPORT' : 'AGENT PROFIT'}</small>
          <h1>{reportOnly ? '称桶报表' : '代理专属看板'}</h1>
        </div>
        <button
          type="button"
          className="ag2-refresh"
          aria-label="刷新"
          disabled={loading}
          onClick={() => setReloadKey((value) => value + 1)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 6v5h-5M4 18v-5h5" />
            <path d="M18.5 9A7 7 0 0 0 6 6.5L4 9m16 6-2 2.5A7 7 0 0 1 5.5 15" />
          </svg>
        </button>
      </header>

      {!reportOnly && (
        <>
          <section className="ag2-profile">
            <div className="ag2-profile-orbit" aria-hidden="true" />
            <div className="ag2-avatar">
              {(data.profile.nickname ?? data.profile.label).slice(0, 1).toUpperCase()}
            </div>
            <div className="ag2-profile-copy">
              <small>专属代理账户 · {data.profile.online ? '当前在线' : '当前离线'}</small>
              <h2>{data.profile.label}</h2>
              <p>{data.profile.nickname ?? '未设置昵称'} · {data.profile.uidMasked}</p>
            </div>
            <div className="ag2-points">
              <small>当前占成</small>
              <strong>{data.profile.sharePoints}</strong>
              <span>/{data.profile.bucketBase ?? selected?.mine.bucketBase ?? 130} 点</span>
            </div>
          </section>

          <section className="ag2-lifetime">
            <div>
              <small>累计已发称桶利润</small>
              <strong>RM {rm(data.profile.lifetimeProfitCents)}</strong>
              <small>
                直属 RM {rm(data.profile.lifetimeSelfAmountCents ?? '0')} · 点差 RM{' '}
                {rm(data.profile.lifetimeOverrideAmountCents ?? '0')}
              </small>
            </div>
            <div>
              <span><Icon name="network" /> 团队代理</span>
              <b>{data.profile.teamAgentCount}</b>
              <small>
                直属 {data.profile.directAgentCount} · 在线 {data.profile.onlineTeamCount}
              </small>
            </div>
            <div>
              <span><Icon name="players" /> 团队玩家</span>
              <b>{data.profile.teamPlayerCount}</b>
              <small>直属 {data.profile.directPlayerCount}</small>
            </div>
          </section>

          {selected && !hasTodayReport && (
            <p className="ag2-today-wait">{TODAY_PENDING}</p>
          )}

          {selected && (
            <section className="ag2-period-hero">
              <header>
                <div>
                  <small>{gameLabel(selected.pool.room)} · 最近一批</small>
                  <h2>{selected.pool.poolCode}</h2>
                </div>
                <span className={selectedDate === TODAY_PENDING ? 'is-wait' : ''}>
                  {selectedDate}
                </span>
              </header>
              <div className="ag2-profit-main">
                <small>本期我的称桶利润</small>
                <strong>RM {rm(selected.mine.totalAmountCents)}</strong>
                <span>
                  {new Date(selected.pool.generatedAt).toLocaleString('zh-MY', {
                    hour12: false,
                  })}
                  {status ? ` · ${status.text}` : ''}
                  {selected.pool.status === 'PENDING' ? ' · 尚未计入累计' : ''}
                </span>
              </div>
              <div className="ag2-profit-split">
                <article>
                  <span>直属玩家利润</span>
                  <strong>RM {rm(selected.mine.selfAmountCents)}</strong>
                </article>
                <i>+</i>
                <article>
                  <span>下级占成差额</span>
                  <strong>RM {rm(selected.mine.overrideAmountCents)}</strong>
                </article>
              </div>
              <div className="ag2-dash-flow">
                <article>
                  <span>团队流水</span>
                  <strong>RM {rm(selected.mine.teamTurnoverCents)}</strong>
                </article>
                <article>
                  <span>自身流水</span>
                  <strong>RM {rm(selected.mine.selfTurnoverCents)}</strong>
                </article>
              </div>
              <button
                type="button"
                className="ag2-open-report"
                onClick={() => navigate(`/agent/report?tab=report&poolId=${selected.pool.id}`)}
              >
                查看完整称桶报表
              </button>
            </section>
          )}

          {data.periods.length > 0 && (
            <section className="ag2-trend">
              <div className="ag2-section-title">
                <div>
                  <small>RECENT BATCHES</small>
                  <h2>近几批利润</h2>
                </div>
                <button
                  type="button"
                  onClick={() => navigate('/agent/report?tab=report')}
                >
                  全部报表
                </button>
              </div>
              {games.length > 1 && (
                <div className="ag2-game-filter" role="tablist" aria-label="按游戏筛选批次">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={gameFilter === 'all'}
                    className={gameFilter === 'all' ? 'is-active' : ''}
                    onClick={() => setGameFilter('all')}
                  >
                    全部游戏
                  </button>
                  {games.map((game) => (
                    <button
                      type="button"
                      role="tab"
                      key={game.gameCode}
                      aria-selected={gameFilter === game.gameCode}
                      className={gameFilter === game.gameCode ? 'is-active' : ''}
                      onClick={() => setGameFilter(game.gameCode)}
                    >
                      {gameLabel(game)}
                    </button>
                  ))}
                </div>
              )}
              <div className="ag2-trend-list">
                {recentPeriods.map((period) => {
                  const width =
                    recentMaxCents > 0n
                      ? Number((BigInt(period.amountCents) * 100n) / recentMaxCents)
                      : 0;
                  const tone =
                    STATUS_LABEL[period.status] ?? { text: period.status, tone: 'none' };
                  return (
                    <button
                      type="button"
                      key={period.poolId}
                      className="ag2-trend-row"
                      onClick={() =>
                        navigate(`/agent/report?tab=report&poolId=${period.poolId}`)
                      }
                    >
                      <div>
                        <strong>{period.poolCode}</strong>
                        <small>
                          {gameLabel(period.room)} · {formatReportDay(periodDay(period))} · {tone.text}
                        </small>
                      </div>
                      <span className="ag2-trend-bar" aria-hidden="true">
                        <i
                          style={{
                            transform: `scaleX(${width > 0 ? Math.max(0.04, width / 100) : 0})`,
                          }}
                        />
                      </span>
                      <b>RM {rm(period.amountCents)}</b>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {!selected && (
            <div className="ag2-empty">
              <Icon name="history" />
              <strong>{TODAY_PENDING}</strong>
              <span>今日报表生成后，这里会显示利润拆分和近几批走势。</span>
            </div>
          )}
        </>
      )}

      {reportOnly && (
        <section
          id="ag2-period"
          className="ag2-period-selector is-report-focus"
        >
          <div className="ag2-section-title">
            <div>
              <small>SETTLEMENT PERIOD</small>
              <h2>选择利润池批次</h2>
            </div>
            {status && <span className={`ag2-status ${status.tone}`}>{status.text}</span>}
          </div>
          {!hasTodayReport && (
            <p className="ag2-today-wait">{TODAY_PENDING}</p>
          )}
          {data.periods.length > 0 ? (
            <>
              {games.length > 1 && (
                <div className="ag2-game-filter" role="tablist" aria-label="按游戏筛选批次">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={gameFilter === 'all'}
                    className={gameFilter === 'all' ? 'is-active' : ''}
                    onClick={() => setGameFilter('all')}
                  >
                    全部游戏
                  </button>
                  {games.map((game) => (
                    <button
                      type="button"
                      role="tab"
                      key={game.gameCode}
                      aria-selected={gameFilter === game.gameCode}
                      className={gameFilter === game.gameCode ? 'is-active' : ''}
                      onClick={() => {
                        setGameFilter(game.gameCode);
                        const latest = data.periods.find((period) => period.room.gameCode === game.gameCode);
                        if (latest) {
                          setPoolId(latest.poolId);
                          navigate(
                            `/agent/report?tab=report&poolId=${encodeURIComponent(latest.poolId)}`,
                            { replace: true },
                          );
                        }
                      }}
                    >
                      {gameLabel(game)}
                    </button>
                  ))}
                </div>
              )}
              <label className="ag2-period-picker">
                <div className="ag2-period-picker-value" aria-hidden="true">
                  {activePickerPeriod ? (
                    <>
                      <strong>
                        {gameLabel(activePickerPeriod.room)} · {activePickerPeriod.poolCode}
                      </strong>
                      <span>
                        {selectedDate} · RM {rm(activePickerPeriod.amountCents)}
                      </span>
                    </>
                  ) : (
                    <span>请选择批次</span>
                  )}
                </div>
                <select
                  className="ag2-period-picker-native"
                  aria-label="利润池批次"
                  value={selected?.pool.id ?? activePickerPeriod?.poolId ?? ''}
                  onChange={(event) => {
                    const next = event.target.value;
                    setPoolId(next);
                    navigate(
                      `/agent/report?tab=report&poolId=${encodeURIComponent(next)}`,
                      { replace: true },
                    );
                  }}
                >
                  {visiblePeriods.map((period) => (
                    <option value={period.poolId} key={period.poolId}>
                      {gameLabel(period.room)} · {period.poolCode} ·{' '}
                      {formatReportDay(periodDay(period))} · RM {rm(period.amountCents)}
                    </option>
                  ))}
                </select>
                <Icon name="chevron" />
              </label>
              {data.periodsNextCursor && (
                <button
                  type="button"
                  className="ag2-load-more"
                  disabled={loadingMorePeriods}
                  onClick={() => void loadMorePeriods()}
                >
                  {loadingMorePeriods ? '正在加载…' : '加载更早批次'}
                </button>
              )}
            </>
          ) : (
            <div className="ag2-empty">
              <Icon name="history" />
              <strong>尚无称桶利润池</strong>
              <span>{TODAY_PENDING}</span>
            </div>
          )}
        </section>
      )}

      {reportOnly && selected && (
        <>
          <section className="ag2-period-hero">
            <header>
              <div>
                  <small>{gameLabel(selected.pool.room)}</small>
                <h2>{selected.pool.poolCode}</h2>
              </div>
              <span className={selectedDate === TODAY_PENDING ? 'is-wait' : ''}>
                {selectedDate}
              </span>
            </header>
            <div className="ag2-profit-main">
              <small>本期我的称桶利润</small>
              <strong>RM {rm(selected.mine.totalAmountCents)}</strong>
              <span>
                {new Date(selected.pool.generatedAt).toLocaleString('zh-MY', {
                  hour12: false,
                })}
              </span>
            </div>
            <div className="ag2-profit-split">
              <article>
                <span>直属玩家利润</span>
                <strong>RM {rm(selected.mine.selfAmountCents)}</strong>
              </article>
              <i>+</i>
              <article>
                <span>下级占成差额</span>
                <strong>RM {rm(selected.mine.overrideAmountCents)}</strong>
              </article>
            </div>
          </section>

          <section className="ag2-metrics ag2-metrics-company">
            <article>
              <span><Icon name="profit" /> 公司总流水</span>
              <strong>RM {rm(selected.pool.turnoverCents)}</strong>
              <small>本批房间全部有效流水</small>
            </article>
            <article>
              <span><Icon name="history" /> 公司支出</span>
              <strong>RM {rm(selected.pool.expenseCents)}</strong>
              <small>按本批支出比例计算</small>
            </article>
            <article>
              <span><Icon name="network" /> 利润池</span>
              <strong>RM {rm(selected.pool.netPoolCents)}</strong>
              <small>抽水减去支出后的可分配池</small>
            </article>
          </section>

          <section className="ag2-list-section">
            <div className="ag2-section-title">
              <div>
                <small>MY NETWORK</small>
                <h2>名下全部代理</h2>
              </div>
              <button type="button" onClick={() => navigate('/agent/sharing')}>分成管理</button>
            </div>
            <p className="ag2-tree-hint">
              只显示你这棵线下的代理。有下级的可点开查看占成、流水和利润。
            </p>
            <div className="ag2-agent-list">
              {downlineRows.map(({ item, depth, childCount }) => (
                <article
                  key={item.agentId}
                  className={childCount > 0 ? 'ag2-tree-row is-expandable' : 'ag2-tree-row'}
                  style={{ paddingLeft: 10 + depth * 16 }}
                >
                  {childCount > 0 ? (
                    <button
                      type="button"
                      className={`ag2-tree-toggle ${expanded.has(item.agentId) ? 'open' : ''}`}
                      aria-expanded={expanded.has(item.agentId)}
                      aria-label={expanded.has(item.agentId) ? `收起 ${item.label}` : `展开 ${item.label}`}
                      onClick={() => toggleAgent(item.agentId)}
                    >
                      <Icon name="chevron" />
                    </button>
                  ) : (
                    <span className="ag2-tree-toggle-spacer" aria-hidden="true" />
                  )}
                  <span className="ag2-list-avatar">{item.label.slice(0, 1)}</span>
                  <div>
                    <strong>{item.label}</strong>
                    <small>
                      {item.uidMasked} · {item.sharePoints} 点 · {item.teamAgentCount} 代理 / {item.teamPlayerCount} 玩家
                    </small>
                    <small>
                      自身流水 RM {rm(item.selfTurnoverCents)} · 团队 RM {rm(item.teamTurnoverCents)}
                    </small>
                  </div>
                  <span>
                    <strong>合计 RM {rm(item.amountCents)}</strong>
                    <small>
                      自身 {rm(item.selfAmountCents)} + 差额 {rm(item.overrideAmountCents)}
                    </small>
                    {item.parentAgentId === data.profile.id && (
                      <small>给你的差额 RM {rm(item.contributionAmountCents)}</small>
                    )}
                  </span>
                </article>
              ))}
              {downlineRows.length === 0 && (
                <div className="ag2-empty compact">
                  <strong>本期名下没有下级代理</strong>
                  <span>可在玩家列表将符合条件的直属玩家升级为代理。</span>
                </div>
              )}
            </div>
          </section>

          <section className="ag2-list-section">
            <div className="ag2-section-title">
              <div>
                <small>DIRECT PLAYERS</small>
                <h2>我的直属玩家</h2>
                <small className="ag2-direct-sum">
                  含自己 · 合计流水 RM {rm(selected.mine.directTurnoverCents ?? selected.mine.selfTurnoverCents)}
                </small>
              </div>
              <button type="button" onClick={() => navigate('/agent/players')}>玩家管理</button>
            </div>
            <div className="ag2-player-list">
              {selected.players.map((player) => (
                <article key={player.userId}>
                  <span className="ag2-list-avatar">
                    {(player.nickname ?? player.uidMasked).slice(0, 1)}
                  </span>
                  <div>
                    <strong>
                      {player.isSelf ? '自己' : (player.nickname ?? '玩家')}
                      {player.isSelf && player.nickname ? ` · ${player.nickname}` : ''}
                    </strong>
                    <small>{player.isSelf ? `${player.uidMasked} · 自身流水` : player.uidMasked}</small>
                  </div>
                  <span>
                    <strong>RM {rm(player.turnoverCents)}</strong>
                    <small>利润 RM {rm(player.profitCents)}</small>
                  </span>
                </article>
              ))}
              {selected.players.length === 0 && (
                <div className="ag2-empty compact">
                  <strong>本期暂无自己或直属玩家流水</strong>
                  <span>玩家归属和金额以该利润池生成时的快照为准。</span>
                </div>
              )}
              {selected.playersNextCursor && (
                <button
                  type="button"
                  className="ag2-load-more"
                  disabled={loadingMorePlayers}
                  onClick={() => void loadMorePlayers()}
                >
                  {loadingMorePlayers ? '正在加载…' : '加载更多直属玩家'}
                </button>
              )}
            </div>
          </section>
        </>
      )}

      {error && <div className="inline-alert error">{error}</div>}
      <footer className="ag2-footnote">
        {reportOnly
          ? '历史代理关系、占成、流水与利润均按利润池生成时保存，不受之后调整影响。公司三项为本批房间总账。'
          : data.profile.lifetimeLegacyCents && data.profile.lifetimeLegacyCents !== '0'
            ? `累计只统计已发放批次，含切换前旧日结 RM ${rm(data.profile.lifetimeLegacyCents)}。分成与玩家请从「我的」进入。`
            : '累计只统计已发放批次；待分配利润不会计入。分成与玩家请从「我的」进入。'}
      </footer>
    </div>
  );
}
