/**
 * 代理专属 · 分成管理 — 上级为直属下级代理调整称桶占成
 * 核心规则（文档第三节）：给下级设占成必须至少预留 minReservePoints（默认 5 点）给自己
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { goBack } from '../lib/nav';

type Subagent = Awaited<ReturnType<typeof api.agentSubagents>>['items'][number];

export default function AgentSubagents() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.agentSubagents>> | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Subagent | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  const load = useCallback(() => {
    setError('');
    api
      .agentSubagents()
      .then(setData)
      .catch((reason) => setError((reason as Error).message || '加载失败'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!data && !error) return <div className="loading">加载中…</div>;

  return (
    <div className="page subpage ag-page">
      <header className="subpage-header">
        <button type="button" onClick={() => goBack(navigate, location)} aria-label="返回">
          ‹
        </button>
        <div>
          <h1>分成管理</h1>
        </div>
        <span />
      </header>

      {error && <div className="inline-alert error">{error}</div>}

      {data && (
        <>
          <section className="ag-panel ag-share-summary">
            <div className="ag-company-grid">
              <article>
                <small>我的占成</small>
                <strong>{data.mine.sharePoints} 点</strong>
              </article>
              <article>
                <small>最低预留</small>
                <strong>{data.mine.minReservePoints} 点</strong>
              </article>
              <article>
                <small>最高可给下级</small>
                <strong>{data.mine.maxChildPoints} 点</strong>
              </article>
            </div>
            <p className="ag-note">
              * 给下级设置占成时必须至少给自己预留 {data.mine.minReservePoints} 点差额；
              您通过与下级的占成差额，赚取其团队产生的对应利润
            </p>
          </section>

          <section className="ag-panel">
            <div className="ag-panel-head">
              <h2>直属下级代理</h2>
              <small>{data.items.length} 人</small>
            </div>
            {data.items.length === 0 ? (
              <p className="ag-empty">
                暂无下级代理。前往「玩家列表」将符合条件的玩家升级为代理。
                <button type="button" className="ag-more" onClick={() => navigate('/agent/players')}>
                  去升级玩家 ›
                </button>
              </p>
            ) : (
              <div className="ag-list">
                {data.items.map((agent) => (
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
                        占成 <b>{agent.sharePoints} 点</b> · 我的剩余{' '}
                        <b>{agent.myDiffPoints} 点</b>
                      </small>
                    </div>
                    <button
                      type="button"
                      className="ag-promote-btn"
                      onClick={() => setEditing(agent)}
                    >
                      调整占成
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {editing && data && (
        <PointsSheet
          agent={editing}
          maxPoints={data.mine.maxChildPoints}
          minReserve={data.mine.minReservePoints}
          bucketBase={data.mine.bucketBase}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function PointsSheet({
  agent,
  maxPoints,
  minReserve,
  bucketBase,
  onClose,
  onDone,
}: {
  agent: Subagent;
  maxPoints: number;
  minReserve: number;
  bucketBase: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [points, setPoints] = useState(String(agent.sharePoints));
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
      await api.agentSetSubagentPoints(agent.agentId, value);
      onDone();
    } catch (reason) {
      setErr((reason as Error).message || '调整失败，请重试');
      setBusy(false);
    }
  }

  return (
    <div className="ag-sheet" role="dialog" aria-modal="true" aria-label="调整占成">
      <button type="button" className="ag-sheet-backdrop" onClick={onClose} />
      <div className="ag-sheet-panel">
        <h2>调整占成</h2>
        <p className="ag-sheet-sub">
          {agent.label}（{agent.uidMasked}）当前占成 {agent.sharePoints} 点
        </p>
        <label className="ag-sheet-label">新的称桶占成</label>
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
          最高可设置 {maxPoints} 点（须给自己预留 {minReserve} 点，基准 {bucketBase}）；
          若其名下已有下级代理，还需高于下级占成至少 {minReserve} 点
        </p>
        {err && <div className="inline-alert error">{err}</div>}
        <div className="ag-sheet-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={!valid || busy || value === agent.sharePoints}
            onClick={() => void submit()}
          >
            {busy ? '保存中…' : '确认调整'}
          </button>
        </div>
      </div>
    </div>
  );
}
