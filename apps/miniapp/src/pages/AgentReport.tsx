/**
 * 代理专属看板：按正式称桶利润池批次展示不可变快照。
 */
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, rm } from '../api';
import { goBack } from '../lib/nav';

const STATUS_LABEL = {
  PENDING: { text: '待分配', tone: 'pending' },
  DISTRIBUTED: { text: '已分配', tone: 'paid' },
  NO_DISTRIBUTION: { text: '无需分配', tone: 'none' },
} as const;

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

export default function AgentReport() {
  const [poolId, setPoolId] = useState<string | undefined>();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.agentReport>> | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMorePeriods, setLoadingMorePeriods] = useState(false);
  const [loadingMorePlayers, setLoadingMorePlayers] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();

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
          <div><h1>代理专属看板</h1></div>
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

  return (
    <div className="page subpage ag2-page">
      <header className="subpage-header ag2-header">
        <button type="button" onClick={() => goBack(navigate, location)} aria-label="返回">‹</button>
        <div>
          <small>AGENT PROFIT</small>
          <h1>代理专属看板</h1>
        </div>
        <button
          type="button"
          className="ag2-refresh"
          aria-label="刷新看板"
          disabled={loading}
          onClick={() => setReloadKey((value) => value + 1)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 6v5h-5M4 18v-5h5" />
            <path d="M18.5 9A7 7 0 0 0 6 6.5L4 9m16 6-2 2.5A7 7 0 0 1 5.5 15" />
          </svg>
        </button>
      </header>

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
          <span>点</span>
        </div>
      </section>

      <section className="ag2-lifetime">
        <div>
          <small>累计已发称桶利润</small>
          <strong>RM {rm(data.profile.lifetimeProfitCents)}</strong>
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

      <section className="ag2-period-selector">
        <div className="ag2-section-title">
          <div>
            <small>SETTLEMENT PERIOD</small>
            <h2>选择利润池批次</h2>
          </div>
          {status && <span className={`ag2-status ${status.tone}`}>{status.text}</span>}
        </div>
        {data.periods.length > 0 ? (
          <>
            <label>
              <span className="sr-only">利润池批次</span>
              <select
                value={selected?.pool.id ?? ''}
                onChange={(event) => setPoolId(event.target.value)}
              >
                {data.periods.map((period) => (
                  <option value={period.poolId} key={period.poolId}>
                    {period.poolCode} · 第 {period.startSeqNo}–{period.endSeqNo} 局 · RM {rm(period.amountCents)}
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
            <span>公司生成第一批局数报表后，这里会自动显示。</span>
          </div>
        )}
      </section>

      {selected && (
        <>
          <section className="ag2-period-hero">
            <header>
              <div>
                <small>{selected.pool.room.title}</small>
                <h2>{selected.pool.poolCode}</h2>
              </div>
              <span>第 {selected.pool.startSeqNo}–{selected.pool.endSeqNo} 局</span>
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

          <section className="ag2-metrics">
            <article>
              <span><Icon name="network" /> 团队代理</span>
              <strong>{selected.mine.teamAgentCount}</strong>
              <small>直属 {selected.mine.directAgentCount}</small>
            </article>
            <article>
              <span><Icon name="players" /> 团队玩家</span>
              <strong>{selected.mine.teamPlayerCount}</strong>
              <small>直属 {selected.mine.directPlayerCount}</small>
            </article>
            <article>
              <span><Icon name="profit" /> 团队流水</span>
              <strong>RM {rm(selected.mine.teamTurnoverCents)}</strong>
              <small>贡献 {(selected.mine.contributionBp / 100).toFixed(2)}%</small>
            </article>
            <article>
              <span><Icon name="history" /> 本期占成</span>
              <strong>{selected.mine.sharePoints}/{selected.mine.bucketBase}</strong>
              <small>历史快照不随当前配置变化</small>
            </article>
          </section>

          <section className="ag2-list-section">
            <div className="ag2-section-title">
              <div>
                <small>MY NETWORK</small>
                <h2>我的直属代理</h2>
              </div>
              <button type="button" onClick={() => navigate('/agent/sharing')}>分成管理</button>
            </div>
            <div className="ag2-agent-list">
              {selected.subagents.map((agent) => (
                <article key={agent.agentId}>
                  <span className="ag2-list-avatar">{agent.label.slice(0, 1)}</span>
                  <div>
                    <strong>{agent.label}</strong>
                    <small>{agent.uidMasked} · {agent.teamAgentCount} 代理 / {agent.teamPlayerCount} 玩家</small>
                  </div>
                  <span>
                    <strong>差额贡献 RM {rm(agent.contributionAmountCents)}</strong>
                    <small>
                      下级本期 RM {rm(agent.ownAmountCents)} · 差额 {agent.diffPoints} 点
                    </small>
                  </span>
                </article>
              ))}
              {selected.subagents.length === 0 && (
                <div className="ag2-empty compact">
                  <strong>暂无直属代理</strong>
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
                    <strong>{player.nickname ?? '玩家'}</strong>
                    <small>{player.uidMasked}</small>
                  </div>
                  <span>
                    <strong>RM {rm(player.turnoverCents)}</strong>
                    <small>利润 RM {rm(player.profitCents)}</small>
                  </span>
                </article>
              ))}
              {selected.players.length === 0 && (
                <div className="ag2-empty compact">
                  <strong>本期暂无直属玩家流水</strong>
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
        历史代理关系、占成、流水与利润均按利润池生成时保存，不受之后调整影响。
      </footer>
    </div>
  );
}
