import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, rm, type GameAdminAssignmentSummary } from '../api';
import { goBack } from '../lib/nav';
import {
  getCachedGameAdminAssignments,
  setCachedGameAdminAssignments,
} from '../sessionStore';

const permissionLabel = {
  SEND_BUDGET_PACKET: '预算红包',
  MUTE_MEMBERS: '成员禁言',
} as const;

export default function GameAdminHome() {
  const navigate = useNavigate();
  const location = useLocation();
  const [items, setItems] = useState<GameAdminAssignmentSummary[]>(
    () => getCachedGameAdminAssignments() ?? [],
  );
  const [loading, setLoading] = useState(getCachedGameAdminAssignments() === null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setError('');
    void api
      .gameAdminMe()
      .then((result) => {
        if (!active) return;
        setItems(result.items);
        setCachedGameAdminAssignments(result.items);
      })
      .catch((cause) => {
        if (active) setError((cause as Error).message || '管理员资料加载失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="gam-page gam-home">
      <header className="gam-nav">
        <button type="button" onClick={() => goBack(navigate, location, '/')} aria-label="返回">‹</button>
        <span>
          <small>OPERATIONS</small>
          <strong>游戏管理员中心</strong>
        </span>
        <i />
      </header>

      <main>
        <section className="gam-home-hero">
          <span className="gam-shield" aria-hidden>盾</span>
          <div>
            <small>GAME AUTHORITY</small>
            <h1>运营控制台</h1>
            <p>你的权限按游戏独立生效。每项操作都会记录管理员、时间与目标。</p>
          </div>
          <em>{items.length} 个游戏</em>
        </section>

        {error && <div className="gam-alert error">{error}</div>}

        {loading ? (
          <div className="gam-loading"><span /><p>正在校验实时授权…</p></div>
        ) : items.length ? (
          <section className="gam-game-list">
            <header>
              <span><small>ASSIGNED GAMES</small><strong>我的管理范围</strong></span>
              <em>实时权限</em>
            </header>
            {items.map((item, index) => (
              <button
                type="button"
                key={item.id}
                onClick={() => navigate(`/game-admin/${encodeURIComponent(item.gameCode)}`)}
              >
                <span className="gam-game-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="gam-game-copy">
                  <small>{item.gameCode}</small>
                  <strong>{item.room.title}</strong>
                  <span>
                    {item.permissions.map((permission) => (
                      <i key={permission}>{permissionLabel[permission]}</i>
                    ))}
                  </span>
                </span>
                <span className="gam-game-budget">
                  <small>可用预算</small>
                  <strong>RM {rm(item.budget.balanceCents)}</strong>
                  <i>进入管理 ›</i>
                </span>
              </button>
            ))}
          </section>
        ) : (
          <section className="gam-empty">
            <span>盾</span>
            <h2>当前没有有效授权</h2>
            <p>请联系平台超级管理员，在「游戏运行中心 → 群管理员」为你的 Telegram 账号授权。</p>
            <button type="button" onClick={() => navigate('/')}>返回个人中心</button>
          </section>
        )}

        <p className="gam-footnote">
          管理员身份不会授予平台后台权限；停用授权后，下一次操作会立即失效。
        </p>
      </main>
    </div>
  );
}
