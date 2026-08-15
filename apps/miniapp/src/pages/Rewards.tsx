import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, rm } from '../api';
import { goBack } from '../lib/nav';

type RewardData = Awaited<ReturnType<typeof api.rewards>>;
type RewardItem = RewardData['items'][number];
type Tab = 'CHESS' | 'BANKER' | 'SPECIAL';

const REWARDS_EMBLEM = '/game-ui/rewards-emblem.png';

const TABS: Array<[Tab, string, string]> = [
  ['CHESS', '棋牌奖励', '牌型挑战'],
  ['BANKER', '庄家奖励', '做庄阶梯'],
  ['SPECIAL', '特别奖励', '限时活动'],
];

const EMPTY_COPY: Record<Tab, { title: string; body: string }> = {
  CHESS: { title: '暂无棋牌奖励', body: '新牌型挑战上线后将在这里展示' },
  BANKER: { title: '暂无庄家奖励', body: '新做庄任务上线后将在这里展示' },
  SPECIAL: { title: '暂无特别活动', body: '运营活动上线后将在这里展示' },
};

function progressOf(item: RewardItem, counts: Record<string, number>) {
  const condition = item.conditions;
  if (condition.kind === 'hand_count') {
    const current = counts[String(condition.handType)] ?? 0;
    const target = Number(condition.count ?? 1);
    return { current, target, label: `${current} / ${target}` };
  }
  if (condition.kind === 'banker_rounds') {
    const current = counts.BANKER_ROUNDS ?? 0;
    const target = Number(condition.count ?? 1);
    return { current, target, label: `${current} / ${target} 局` };
  }
  if (condition.kind === 'banker_instant') {
    const current = counts.BANKER_INSTANT ?? 0;
    const target = Number(condition.count ?? 1);
    return { current, target, label: `${current} / ${target} 次` };
  }
  if (condition.kind === 'hand_combo' && condition.required && typeof condition.required === 'object') {
    const entries = Object.entries(condition.required as Record<string, number>);
    const current = entries.filter(([hand, target]) => (counts[hand] ?? 0) >= target).length;
    return { current, target: entries.length, label: `${current} / ${entries.length} 种` };
  }
  return { current: item.achieved ? 1 : 0, target: 1, label: item.achieved ? '已达成' : '未达成' };
}

function medalGlyph(item: RewardItem) {
  const code = item.code.toLowerCase();
  const title = item.title;
  if (item.granted) return '✓';
  if (code.includes('weird') || title.includes('怪牌')) return '✦';
  if (code.includes('baozi') || title.includes('豹子')) return '豹';
  if (code.includes('manniu') || title.includes('满牛')) return '满';
  if (code.includes('fanshun') || title.includes('反顺')) return '反';
  if (code.includes('shunzi') || title.includes('顺子')) return '顺';
  if (code.includes('instant') || title.includes('秒杀')) return '⚡';
  if (code.includes('banker') || title.includes('做庄')) return '庄';
  if (item.tab === 'SPECIAL') return '★';
  return '奖';
}

function statusOf(item: RewardItem) {
  if (item.granted) return { key: 'done', label: '已入账' };
  if (item.achieved) return { key: 'ready', label: '待发放' };
  if (item.remaining === 0) return { key: 'soldout', label: '已抢完' };
  return { key: 'active', label: '进行中' };
}

export default function Rewards() {
  const navigate = useNavigate();
  const location = useLocation();
  const { roomId = '' } = useParams();
  const [tab, setTab] = useState<Tab>('CHESS');
  const [data, setData] = useState<RewardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const [gameTitle, setGameTitle] = useState('当前游戏');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    setData(null);
    api
      .lobby()
      .then((lobby) => {
        const game = lobby.games.find((item) => item.id === roomId);
        if (!game) throw new Error('GAME_NOT_FOUND');
        if (alive) setGameTitle(game.title);
        return api.rewards(game.gameCode);
      })
      .then((result) => {
        if (alive) setData(result);
      })
      .catch(() => {
        if (alive) setError('每日奖励暂时加载失败，请检查网络后重试。');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [retryKey, roomId]);

  const tabItems = useMemo(
    () => data?.items.filter((item) => item.tab === tab) ?? [],
    [data, tab],
  );

  const summary = useMemo(() => {
    const items = data?.items ?? [];
    const counts = data?.counts ?? {};
    const total = items.length;
    const done = items.filter((item) => item.granted).length;
    const completed = items.filter((item) => item.granted || item.achieved).length;
    const active = items.filter((item) => !item.granted && item.remaining !== 0).length;
    const purse = items
      .filter((item) => item.granted)
      .reduce((sum, item) => sum + Number(item.amountCents || 0), 0);
    const progress = items.reduce((sum, item) => {
      if (item.granted || item.achieved) return sum + 1;
      const { current, target } = progressOf(item, counts);
      const ratio = current / Math.max(target, 1);
      return sum + Math.min(1, Math.max(0, ratio));
    }, 0);
    const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
    return { total, done, completed, active, purse, pct };
  }, [data]);

  const winners = data?.winners ?? [];
  const tabMeta = TABS.find(([key]) => key === tab);
  const emptyCopy = EMPTY_COPY[tab];

  return (
    <div className="page subpage rw-page">
      <header className="subpage-header">
        <button type="button" onClick={() => goBack(navigate, location, roomId ? `/game/${roomId}` : '/')} aria-label="返回">
          ‹
        </button>
        <div>
          <h1>{gameTitle} · 每日奖励</h1>
        </div>
        <span />
      </header>

      <section className="rw-hero">
        <div className="rw-hero-glow" aria-hidden />
        <div className="rw-hero-top">
          <div className="rw-hero-copy">
            <div className="rw-completion">
              <div className="rw-completion-head">
                <span>今日完成度</span>
                <small>
                  {error
                    ? '统计暂不可用'
                    : loading
                      ? '正在统计'
                      : `${summary.completed}/${summary.total} 项达成`}
                </small>
                <strong>{error ? '—' : loading ? '…' : `${summary.pct}%`}</strong>
              </div>
              <div
                className="rw-completion-track"
                role="progressbar"
                aria-label="今日奖励任务完成度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={error || loading ? undefined : summary.pct}
                aria-valuetext={
                  error
                    ? '统计暂不可用'
                    : loading
                      ? '正在统计'
                      : `${summary.pct}%，${summary.completed}/${summary.total} 项达成`
                }
              >
                <i
                  style={{
                    width: error || loading ? '0%' : `${summary.pct}%`,
                  }}
                />
              </div>
            </div>
            <h2>完成任务，自动入账</h2>
            <p>马来西亚时间每日 00:00 重置</p>
            <time className="rw-date">{error ? '—' : (data?.date ?? '—')}</time>
            <span className="rw-auto-credit">
              <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                <path d="m5 10 3 3 7-7" />
              </svg>
              达成后无需手动领取
            </span>
          </div>
          <div className="rw-hero-art">
            <i aria-hidden="true" />
            <img
              src={REWARDS_EMBLEM}
              width="512"
              height="512"
              alt="红金每日奖励宝箱徽章"
              decoding="async"
            />
          </div>
        </div>
        <div className="rw-hero-stats">
          <div>
            <small>已领</small>
            <b>{error ? '—' : summary.done}</b>
          </div>
          <div>
            <small>可冲</small>
            <b>{error ? '—' : summary.active}</b>
          </div>
          <div>
            <small>今日入账</small>
            <b className="gold">{error ? '—' : `RM ${rm(String(summary.purse))}`}</b>
          </div>
        </div>
      </section>

      <div className="rw-tabs" role="group" aria-label="奖励分类">
        {TABS.map(([key, label, hint]) => (
          <button
            className={tab === key ? 'active' : ''}
            key={key}
            type="button"
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
          >
            <strong>{label}</strong>
            <span>{hint}</span>
          </button>
        ))}
      </div>

      {error && (
        <section className="feature-load-error" role="alert">
          <img src={REWARDS_EMBLEM} width="64" height="64" alt="" aria-hidden="true" />
          <strong>每日奖励没有加载成功</strong>
          <p>{error}</p>
          <button type="button" onClick={() => setRetryKey((key) => key + 1)}>
            重新加载
          </button>
        </section>
      )}

      {!error && <section className="rw-list-panel">
        <div className="rw-list-head">
          <div>
            <small>{tabMeta?.[2]}</small>
            <h2>{tabMeta?.[1]}</h2>
          </div>
          <span>{tabItems.length} 项</span>
        </div>

        {loading && (
          <div className="rw-skeleton" aria-hidden>
            {Array.from({ length: 4 }).map((_, i) => (
              <div className="rw-skeleton-row" key={i} />
            ))}
          </div>
        )}

        {!loading && tabItems.length > 0 && (
          <div className="rw-list">
            {tabItems.map((item, index) => {
              const progress = progressOf(item, data?.counts ?? {});
              const percentage = Math.min(100, (progress.current / Math.max(1, progress.target)) * 100);
              const status = statusOf(item);
              return (
                <article
                  className={`rw-card status-${status.key}`}
                  key={item.id}
                  style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
                >
                  <div className={`rw-medal tone-${item.tab.toLowerCase()}`}>
                    <span>{medalGlyph(item)}</span>
                  </div>
                  <div className="rw-body">
                    <div className="rw-title">
                      <div className="rw-title-main">
                        <strong>{item.title}</strong>
                        <em className={`rw-status ${status.key}`}>{status.label}</em>
                      </div>
                      <b className="rw-amount">RM {rm(item.amountCents)}</b>
                    </div>
                    <div className="rw-track">
                      <i style={{ width: `${percentage}%` }} />
                    </div>
                    <div className="rw-meta">
                      <span>{progress.label}</span>
                      <span>
                        {item.remaining === null
                          ? '不限量'
                          : item.remaining === 0
                            ? '今日已满'
                            : `剩余 ${item.remaining} 份`}
                      </span>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {!loading && tabItems.length === 0 && (
          <div className="rw-empty">
            <img
              className="rw-empty-emblem"
              src={REWARDS_EMBLEM}
              width="64"
              height="64"
              alt=""
              aria-hidden="true"
            />
            <strong>{emptyCopy.title}</strong>
            <p>{emptyCopy.body}</p>
          </div>
        )}
      </section>}

      {!error && <section className="rw-winners">
        <div className="rw-list-head">
          <div>
            <small>实时播报</small>
            <h2>今日得奖名单</h2>
          </div>
          <span>{winners.length} 人次</span>
        </div>

        {winners.length > 0 ? (
          <div className="rw-winner-list">
            {winners.map((winner, index) => (
              <div className="rw-winner-row" key={`${winner.uid}-${index}`}>
                <div className="rw-winner-avatar">
                  {winner.avatarUrl ? (
                    <img src={winner.avatarUrl} alt="" loading="lazy" />
                  ) : (
                    winner.nickname?.[0] || '奖'
                  )}
                </div>
                <div className="rw-winner-copy">
                  <strong>{winner.nickname}</strong>
                  <small>{winner.title}</small>
                </div>
                <b>+RM {rm(winner.amountCents)}</b>
              </div>
            ))}
          </div>
        ) : (
          <div className="rw-winner-empty">
            <div>
              <strong>还没有人领到奖励</strong>
              <p>今日第一份奖励，等你来拿</p>
            </div>
            <button
              type="button"
              className="rw-cta"
              onClick={() => navigate(roomId ? `/game/${roomId}/play` : '/')}
            >
              去牌桌冲一波
            </button>
          </div>
        )}
      </section>}
    </div>
  );
}
