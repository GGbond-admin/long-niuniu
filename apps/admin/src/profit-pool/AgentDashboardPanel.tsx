import { useEffect, useMemo, useRef, useState } from 'react';
import { request, rm } from '../api';
import type { NetworkAgent } from './types';

type AgentDashboardData = {
  mode: 'LIVE' | 'SNAPSHOT';
  batch: {
    id: string;
    poolCode: string;
    startSeqNo: number;
    endSeqNo: number;
    status: string;
  } | null;
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
    avatarUrl: string | null;
    source: string;
    status?: string;
    turnoverCents?: string;
    profitCents?: string;
  }>;
  playersNextCursor: string | null;
};

type DashboardPeriod = AgentDashboardData['periods'][number];
type DashboardPlayer = AgentDashboardData['players'][number];

function errorText(error: unknown) {
  return error instanceof Error ? error.message : '加载代理看板失败';
}

export default function AgentDashboardPanel({
  agentId,
  poolId,
  onClose,
  onError,
}: {
  agentId: string;
  poolId?: string;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [data, setData] = useState<AgentDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMorePeriods, setLoadingMorePeriods] = useState(false);
  const [loadingMorePlayers, setLoadingMorePlayers] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const params = poolId ? `?poolId=${encodeURIComponent(poolId)}` : '';
    setLoading(true);
    setLoadingMorePeriods(false);
    setLoadingMorePlayers(false);
    setData(null);
    request<AgentDashboardData>(
      `/api/admin/profit-pool/agents/${agentId}/dashboard${params}`,
      { signal: controller.signal },
    )
      .then(setData)
      .catch((error) => {
        if ((error as Error).name !== 'AbortError') onError(errorText(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [agentId, poolId, onError]);

  async function loadMorePeriods() {
    const cursor = data?.periodsNextCursor;
    if (!cursor || loadingMorePeriods) return;
    setLoadingMorePeriods(true);
    try {
      const result = await request<{
        items: DashboardPeriod[];
        nextCursor: string | null;
      }>(
        `/api/admin/profit-pool/agents/${agentId}/dashboard/periods?cursor=${encodeURIComponent(cursor)}&limit=20`,
      );
      setData((current) =>
        current
          ? {
              ...current,
              periods: [
                ...current.periods,
                ...result.items.filter(
                  (item) =>
                    !current.periods.some((period) => period.poolId === item.poolId),
                ),
              ],
              periodsNextCursor: result.nextCursor,
            }
          : current,
      );
    } catch (error) {
      onError(errorText(error));
    } finally {
      setLoadingMorePeriods(false);
    }
  }

  async function loadMorePlayers() {
    const cursor = data?.playersNextCursor;
    if (!cursor || loadingMorePlayers) return;
    const params = new URLSearchParams({ cursor, limit: '20' });
    if (poolId) params.set('poolId', poolId);
    setLoadingMorePlayers(true);
    try {
      const result = await request<{
        items: DashboardPlayer[];
        nextCursor: string | null;
      }>(
        `/api/admin/profit-pool/agents/${agentId}/dashboard/players?${params}`,
      );
      setData((current) =>
        current
          ? {
              ...current,
              players: [
                ...current.players,
                ...result.items.filter(
                  (item) =>
                    !current.players.some((player) => player.userId === item.userId),
                ),
              ],
              playersNextCursor: result.nextCursor,
            }
          : current,
      );
    } catch (error) {
      onError(errorText(error));
    } finally {
      setLoadingMorePlayers(false);
    }
  }

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const maxPeriodProfit = useMemo(
    () =>
      data?.periods.reduce(
        (max, period) =>
          BigInt(period.amountCents) > max ? BigInt(period.amountCents) : max,
        0n,
      ) ?? 0n,
    [data?.periods],
  );

  return (
    <div className="ppx-drawer-backdrop" role="presentation" onMouseDown={onClose}>
      <aside
        className="ppx-agent-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ppx-agent-drawer-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          ref={closeRef}
          type="button"
          className="ppx-drawer-close"
          aria-label="关闭代理看板"
          onClick={onClose}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>

        {loading && (
          <div className="ppx-drawer-loading" aria-busy="true">
            <div className="ppx-skeleton avatar" />
            <div className="ppx-skeleton wide" />
            <div className="ppx-skeleton-grid"><i /><i /><i /><i /></div>
          </div>
        )}

        {data && (
          <>
            <header className="ppx-agent-hero">
              <div className="ppx-agent-avatar">
                {(data.agent.nickname ?? data.agent.label).slice(0, 1).toUpperCase()}
                <i className={data.agent.online ? 'online' : ''} />
              </div>
              <div>
                <span className="ppx-agent-eyebrow">
                  L{data.agent.level} AGENT · {data.mode === 'LIVE' ? 'LIVE PROFILE' : 'HISTORICAL SNAPSHOT'}
                </span>
                <h2 id="ppx-agent-drawer-title">{data.agent.label}</h2>
                <p>{data.agent.nickname ?? '未设置昵称'} · UID {data.agent.uid}</p>
              </div>
              <span className={`ppx-live-pill ${data.agent.online ? 'online' : ''}`}>
                <i />
                {data.agent.online ? '在线' : '离线'}
              </span>
            </header>

            <div className="ppx-agent-point-strip">
              <span>当前占成</span>
              <strong>{data.agent.sharePoints}/{data.agent.bucketBase}</strong>
              <em>{((data.agent.sharePoints / data.agent.bucketBase) * 100).toFixed(2)}%</em>
              {data.batch && (
                <small>{data.batch.poolCode} · 第 {data.batch.startSeqNo}–{data.batch.endSeqNo} 局</small>
              )}
            </div>

            <div className="ppx-agent-kpis">
              <article>
                <small>团队代理</small>
                <strong>{data.agent.teamAgentCount}</strong>
                <span>直属 {data.agent.directAgentCount}</span>
              </article>
              <article>
                <small>团队玩家</small>
                <strong>{data.agent.teamPlayerCount}</strong>
                <span>直属 {data.agent.directPlayerCount}</span>
              </article>
              <article>
                <small>本期利润</small>
                <strong>RM {rm(data.agent.profitCents)}</strong>
                <span>团队流水 RM {rm(data.agent.teamTurnoverCents)}</span>
              </article>
              <article>
                <small>累计已发利润</small>
                <strong>
                  {data.agent.lifetimeProfitCents == null
                    ? '历史快照'
                    : `RM ${rm(data.agent.lifetimeProfitCents)}`}
                </strong>
                <span>{data.agent.onlineTeamCount} 位代理当前在线</span>
              </article>
            </div>

            <section className="ppx-drawer-section">
              <header>
                <div>
                  <small>SUB-AGENTS</small>
                  <h3>直属代理</h3>
                </div>
                <span>{data.children.length} 位</span>
              </header>
              <div className="ppx-child-list">
                {data.children.map((child) => (
                  <article key={child.id}>
                    <span className="ppx-mini-avatar">
                      {(child.nickname ?? child.label).slice(0, 1)}
                      <i className={child.online ? 'online' : ''} />
                    </span>
                    <div>
                      <strong>{child.label}</strong>
                      <small>{child.teamAgentCount} 代理 · {child.teamPlayerCount} 玩家</small>
                    </div>
                    <span>
                      <strong>RM {rm(child.profitCents)}</strong>
                      <small>{child.sharePoints}/{child.bucketBase} 点</small>
                    </span>
                  </article>
                ))}
                {data.children.length === 0 && <p>暂无直属下级代理</p>}
              </div>
            </section>

            <section className="ppx-drawer-section">
              <header>
                <div>
                  <small>PROFIT HISTORY</small>
                  <h3>利润历史</h3>
                </div>
                <span>已加载 {data.periods.length} 期</span>
              </header>
              <div className="ppx-period-list">
                {data.periods.map((period) => {
                  const width =
                    maxPeriodProfit > 0n
                      ? Number((BigInt(period.amountCents) * 100n) / maxPeriodProfit)
                      : 0;
                  return (
                    <article key={period.poolId}>
                      <div>
                        <strong>{period.poolCode}</strong>
                        <small>第 {period.startSeqNo}–{period.endSeqNo} 局</small>
                      </div>
                      <span className="ppx-profit-bar">
                        <i
                          style={{
                            transform: `scaleX(${
                              width > 0 ? Math.max(0.02, width / 100) : 0
                            })`,
                          }}
                        />
                      </span>
                      <b>RM {rm(period.amountCents)}</b>
                    </article>
                  );
                })}
                {data.periods.length === 0 && <p>尚无利润池历史</p>}
                {data.periodsNextCursor && (
                  <button
                    type="button"
                    className="ppx-drawer-more"
                    disabled={loadingMorePeriods}
                    onClick={() => void loadMorePeriods()}
                  >
                    {loadingMorePeriods ? '正在加载…' : '加载更多利润历史'}
                  </button>
                )}
              </div>
            </section>

            <section className="ppx-drawer-section">
              <header>
                <div>
                  <small>DIRECT PLAYERS</small>
                  <h3>直属玩家</h3>
                </div>
                <span>已加载 {data.players.length} 位</span>
              </header>
              <div className="ppx-drawer-player-grid">
                {data.players.map((player) => (
                  <article key={player.userId}>
                    <span className="ppx-mini-avatar">
                      {(player.nickname ?? player.uid).slice(0, 1)}
                    </span>
                    <div>
                      <strong>{player.nickname ?? '玩家'}</strong>
                      <small>UID {player.uid}</small>
                    </div>
                    <span>
                      {player.turnoverCents != null ? `RM ${rm(player.turnoverCents)}` : player.status}
                    </span>
                  </article>
                ))}
                {data.players.length === 0 && <p>暂无直属玩家</p>}
                {data.playersNextCursor && (
                  <button
                    type="button"
                    className="ppx-drawer-more"
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
      </aside>
    </div>
  );
}
