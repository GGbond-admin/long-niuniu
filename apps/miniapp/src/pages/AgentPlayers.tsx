/**
 * 代理专属 · 玩家列表 — 直属玩家/下级代理总览，可将玩家升级为下级代理
 * 对应《代理称桶制度与上下级分成机制说明文档》第一节（参考图 1 第 3 屏）
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, rm } from '../api';
import { goBack } from '../lib/nav';

type Tab = 'all' | 'players' | 'agents';

export default function AgentPlayers() {
  const [players, setPlayers] = useState<Awaited<ReturnType<typeof api.agentPlayers>> | null>(null);
  const [subagents, setSubagents] = useState<Awaited<ReturnType<typeof api.agentSubagents>> | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [error, setError] = useState('');
  const [promoteTarget, setPromoteTarget] = useState<{
    playerId: string;
    nickname: string | null;
    uidMasked: string;
  } | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  const load = useCallback(() => {
    setError('');
    Promise.all([api.agentPlayers(), api.agentSubagents()])
      .then(([playerList, subagentList]) => {
        setPlayers(playerList);
        setSubagents(subagentList);
      })
      .catch((reason) => setError((reason as Error).message || '加载失败'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const counts = useMemo(
    () => ({
      players: players?.items.length ?? 0,
      agents: subagents?.items.length ?? 0,
    }),
    [players, subagents],
  );

  if (!players && !error) return <div className="loading">加载中…</div>;

  return (
    <div className="page subpage ag-page">
      <header className="subpage-header">
        <button type="button" onClick={() => goBack(navigate, location)} aria-label="返回">
          ‹
        </button>
        <div>
          <h1>玩家列表</h1>
        </div>
        <button className="pm-invite-link" type="button" onClick={() => navigate('/invite')}>
          邀请
        </button>
      </header>

      {error && <div className="inline-alert error">{error}</div>}

      <div className="ag-tabs">
        {(
          [
            ['all', `全部 ${counts.players + counts.agents}`],
            ['players', `玩家 ${counts.players}`],
            ['agents', `代理 ${counts.agents}`],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? 'active' : ''}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {(tab === 'all' || tab === 'players') && players && (
        <section className="ag-panel">
          <div className="ag-panel-head">
            <h2>直属玩家</h2>
            <small>可升级为下级代理</small>
          </div>
          {players.items.length === 0 ? (
            <p className="ag-empty">
              暂无归属玩家。分享推荐二维码邀请注册，新玩家将自动归属您名下。
            </p>
          ) : (
            <div className="ag-list">
              {players.items.map((player) => (
                <div className="ag-list-row" key={player.playerId}>
                  <div className="ag-list-avatar">
                    {player.avatarUrl ? (
                      <img src={player.avatarUrl} alt="" loading="lazy" />
                    ) : (
                      player.nickname?.[0] ?? '牛'
                    )}
                  </div>
                  <div className="ag-list-copy">
                    <strong>{player.nickname ?? '玩家'}</strong>
                    <small>
                      {player.uidMasked} · 注册 {new Date(player.joinedAt).toLocaleDateString('sv-SE')}
                      {player.source === 'REFERRAL' ? ' · 推荐归属' : ''}
                    </small>
                    <small>累计流水 RM {rm(player.totalTurnoverCents)}</small>
                  </div>
                  <button
                    type="button"
                    className="ag-promote-btn"
                    disabled={players.maxChildPoints <= 0}
                    title={players.maxChildPoints <= 0 ? '您的占成不足以再分给下级（须预留差额）' : ''}
                    onClick={() =>
                      setPromoteTarget({
                        playerId: player.playerId,
                        nickname: player.nickname,
                        uidMasked: player.uidMasked,
                      })
                    }
                  >
                    升级代理
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {(tab === 'all' || tab === 'agents') && subagents && (
        <section className="ag-panel">
          <div className="ag-panel-head">
            <h2>下级代理</h2>
            <button type="button" className="ag-more" onClick={() => navigate('/agent/sharing')}>
              分成管理 ›
            </button>
          </div>
          {subagents.items.length === 0 ? (
            <p className="ag-empty">暂无下级代理</p>
          ) : (
            <div className="ag-list">
              {subagents.items.map((agent) => (
                <div className="ag-list-row" key={agent.agentId}>
                  <div className="ag-list-avatar agent">
                    {agent.avatarUrl ? (
                      <img src={agent.avatarUrl} alt="" loading="lazy" />
                    ) : (
                      agent.label[0]
                    )}
                  </div>
                  <div className="ag-list-copy">
                    <strong>{agent.label}</strong>
                    <small>
                      {agent.uidMasked} · 玩家 {agent.playerCount} · 下级 {agent.subagentCount}
                    </small>
                    <small>
                      占成 {agent.sharePoints} 点 · 我的剩余 {agent.myDiffPoints} 点
                    </small>
                  </div>
                  <span className={`ag-status ${agent.status === 'ACTIVE' ? 'paid' : 'none'}`}>
                    {agent.status === 'ACTIVE' ? '正常' : '停用'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {promoteTarget && players && (
        <PromoteSheet
          target={promoteTarget}
          maxPoints={players.maxChildPoints}
          bucketBase={players.bucketBase}
          onClose={() => setPromoteTarget(null)}
          onDone={() => {
            setPromoteTarget(null);
            load();
          }}
        />
      )}
    </div>
  );
}

/** 升级为代理弹层：设置称桶占成（≤ 我的占成 − 最低预留） */
function PromoteSheet({
  target,
  maxPoints,
  bucketBase,
  onClose,
  onDone,
}: {
  target: { playerId: string; nickname: string | null; uidMasked: string };
  maxPoints: number;
  bucketBase: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [points, setPoints] = useState(String(maxPoints));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const value = Number(points);
  const valid = Number.isInteger(value) && value >= 0 && value <= maxPoints;
  const quickOptions = useMemo(() => {
    const options: number[] = [];
    for (let p = maxPoints; p > 0 && options.length < 6; p -= 5) options.push(p);
    return options;
  }, [maxPoints]);

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setErr('');
    try {
      await api.agentPromote(target.playerId, value);
      onDone();
    } catch (reason) {
      setErr((reason as Error).message || '升级失败，请重试');
      setBusy(false);
    }
  }

  return (
    <div className="ag-sheet" role="dialog" aria-modal="true" aria-label="升级为代理">
      <button type="button" className="ag-sheet-backdrop" onClick={onClose} />
      <div className="ag-sheet-panel">
        <h2>升级为代理</h2>
        <p className="ag-sheet-sub">
          {target.nickname ?? '玩家'}（{target.uidMasked}）升级后可发展自己的玩家与下级代理
        </p>
        <label className="ag-sheet-label">设置称桶占成</label>
        <div className="ag-quick-points">
          {quickOptions.map((option) => (
            <button
              key={option}
              type="button"
              className={value === option ? 'active' : ''}
              onClick={() => setPoints(String(option))}
            >
              {option} 点
            </button>
          ))}
        </div>
        <input
          inputMode="numeric"
          value={points}
          onChange={(event) => setPoints(event.target.value.replace(/\D/g, '').slice(0, 4))}
          placeholder={`0 – ${maxPoints}`}
        />
        <p className="ag-sheet-hint">
          当前最高可设置：{maxPoints} 点（基准 {bucketBase}）。升级后其团队利润按占成归其所有，您赚取占成差额。
        </p>
        {err && <div className="inline-alert error">{err}</div>}
        <div className="ag-sheet-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={!valid || busy}
            onClick={() => void submit()}
          >
            {busy ? '升级中…' : '确认升级'}
          </button>
        </div>
      </div>
    </div>
  );
}
