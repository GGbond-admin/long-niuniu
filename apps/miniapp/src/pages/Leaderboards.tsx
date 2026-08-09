import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, rm } from '../api';
import BrandLogo from '../components/BrandLogo';

type Period = 'daily' | 'weekly' | 'monthly';
type Board = 'points' | 'hands' | 'banker';
type RankItem = {
  rank: number;
  uid: string;
  nickname: string;
  avatarUrl: string | null;
  score: string;
};

const LEADERBOARD_EMBLEM = '/game-ui/leaderboard-emblem.png';

const PERIODS: Array<[Period, string]> = [
  ['daily', '日榜'],
  ['weekly', '周榜'],
  ['monthly', '月榜'],
];

const BOARDS: Array<[Board, string, string]> = [
  ['points', '积分榜', '有效流水'],
  ['hands', '棋牌榜', '牌型达成'],
  ['banker', '打桩榜', '做庄次数'],
];

function hasScore(item: RankItem) {
  try {
    return BigInt(item.score) > 0n;
  } catch {
    return Number(item.score) > 0;
  }
}

function initialOf(nickname: string) {
  return nickname?.trim()?.[0] || '牛';
}

function formatUpdatedAt(value?: string) {
  if (!value) return '等待更新';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '等待更新';
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export default function Leaderboards() {
  const navigate = useNavigate();
  const { roomId = '' } = useParams();
  const [period, setPeriod] = useState<Period>('daily');
  const [board, setBoard] = useState<Board>('points');
  const [data, setData] = useState<Awaited<ReturnType<typeof api.leaderboards>> | null>(null);
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
        return api.leaderboards(game.gameCode, period);
      })
      .then((result) => {
        if (alive) setData(result);
      })
      .catch(() => {
        if (alive) setError('榜单暂时加载失败，请检查网络后重试。');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [period, retryKey, roomId]);

  useEffect(() => {
    if (!data?.enabledTypes?.length) return;
    if (!data.enabledTypes.includes(board)) {
      setBoard(data.enabledTypes[0]);
    }
  }, [board, data?.enabledTypes]);

  const ranks = useMemo(() => {
    const raw = data?.boards[board]?.ranks ?? [];
    return raw.filter(hasScore);
  }, [data, board]);

  const topThree = [ranks[0], ranks[1], ranks[2]] as Array<RankItem | undefined>;
  const rest = ranks.slice(3);
  const availableBoards = BOARDS.filter(
    ([key]) => !data?.enabledTypes || data.enabledTypes.includes(key),
  );
  const boardMeta = BOARDS.find(([key]) => key === board);
  const boardLabel = data?.labels?.[board] ?? boardMeta?.[1] ?? '积分榜';
  const periodLabel = PERIODS.find(([key]) => key === period)?.[1] ?? '日榜';
  const updatedAt = formatUpdatedAt(data?.boards[board]?.generatedAt);

  const score = (value: string) =>
    board === 'points' ? `RM ${rm(value)}` : `${value}${board === 'banker' ? ' 局' : ' 次'}`;

  return (
    <div className="page subpage lb-page">
      <header className="subpage-header">
        <button type="button" onClick={() => navigate(-1)} aria-label="返回">
          ‹
        </button>
        <div>
          <h1>{gameTitle} · 排行榜</h1>
        </div>
        <span />
      </header>

      <section className="lb-hero" aria-labelledby="lb-hero-title">
        <div className="lb-hero-copy">
          <span className="lb-hero-eyebrow">HONOR BOARD · {periodLabel}</span>
          <h2 id="lb-hero-title">{boardLabel}</h2>
          <p>每一次下注与做庄都在累积荣耀，前三名将在领奖台高亮展示。</p>
          <div className="lb-hero-meta" aria-label="榜单概况">
            <span>
              <small>上榜人数</small>
              <b>{loading || error ? '—' : ranks.length}</b>
            </span>
            <span>
              <small>最近更新</small>
              <b>{updatedAt}</b>
            </span>
          </div>
        </div>
        <div className="lb-hero-art">
          <i className="lb-hero-halo" aria-hidden="true" />
          <img
            src={LEADERBOARD_EMBLEM}
            width="512"
            height="512"
            alt="金色冠军奖杯徽章"
            decoding="async"
          />
        </div>
      </section>

      <div className="lb-period" role="group" aria-label="榜单周期">
        {PERIODS.map(([key, label]) => (
          <button
            className={period === key ? 'active' : ''}
            key={key}
            type="button"
            aria-pressed={period === key}
            onClick={() => setPeriod(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="lb-boards" role="group" aria-label="榜单类型">
        {availableBoards.map(([key, label, hint]) => (
          <button
            className={board === key ? 'active' : ''}
            key={key}
            type="button"
            aria-pressed={board === key}
            onClick={() => setBoard(key)}
          >
            <strong>{data?.labels?.[key] ?? label}</strong>
            <span>{hint}</span>
          </button>
        ))}
      </div>

      {error && (
        <section className="feature-load-error" role="alert">
          <img src={LEADERBOARD_EMBLEM} width="64" height="64" alt="" aria-hidden="true" />
          <strong>排行榜没有加载成功</strong>
          <p>{error}</p>
          <button type="button" onClick={() => setRetryKey((key) => key + 1)}>
            重新加载
          </button>
        </section>
      )}

      {!error && <section className="lb-stage" aria-label="前三名">
        <div className="lb-stage-glow" aria-hidden />
        <div className="lb-stage-head">
          <div>
            <small>TOP THREE</small>
            <strong>荣耀席位</strong>
          </div>
          <span>{boardMeta?.[2]}</span>
        </div>
        <div className="lb-podium">
          {[1, 0, 2].map((index) => {
            const item = topThree[index];
            const place = index + 1;
            return (
              <article className={`lb-podium-card place-${place}`} key={place}>
                {place === 1 && (
                  <div className="lb-crown" aria-hidden>
                    <svg viewBox="0 0 32 24" focusable="false">
                      <path d="M3 7.5 10.5 13 16 3l5.5 10L29 7.5 26.5 21h-21L3 7.5Z" />
                      <path d="M7 17h18" />
                    </svg>
                  </div>
                )}
                <div className="lb-avatar-ring">
                  {item ? (
                    <div className="lb-avatar">
                      {item.avatarUrl ? (
                        <img src={item.avatarUrl} alt="" loading="lazy" />
                      ) : (
                        initialOf(item.nickname)
                      )}
                    </div>
                  ) : (
                    <BrandLogo size={place === 1 ? 68 : 54} className="lb-avatar lb-avatar-logo" />
                  )}
                  <em className="lb-badge">{place}</em>
                </div>
                <strong className="lb-name">{item?.nickname ?? '虚位以待'}</strong>
                <b className="lb-score">{item ? score(item.score) : '—'}</b>
                <div className="lb-plinth" aria-hidden>
                  <span>{place === 1 ? '冠军' : place === 2 ? '亚军' : '季军'}</span>
                </div>
              </article>
            );
          })}
        </div>
      </section>}

      {!error && <section className="lb-list-panel">
        <div className="lb-list-head">
          <div>
            <small>{periodLabel} · {boardLabel}</small>
            <h2>排名明细</h2>
          </div>
          <span>{ranks.length > 0 ? `Top ${ranks.length}` : '暂无'}</span>
        </div>

        {loading && (
          <div className="lb-skeleton" aria-hidden>
            {Array.from({ length: 4 }).map((_, i) => (
              <div className="lb-skeleton-row" key={i} />
            ))}
          </div>
        )}

        {!loading && rest.length > 0 && (
          <div className="lb-list">
            {rest.map((item, index) => (
              <div
                className="lb-row"
                key={`${item.rank}-${item.uid}`}
                style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
              >
                <b className="lb-row-rank">{item.rank}</b>
                <div className="lb-row-avatar">
                  {item.avatarUrl ? (
                    <img src={item.avatarUrl} alt="" loading="lazy" />
                  ) : (
                    initialOf(item.nickname)
                  )}
                </div>
                <div className="lb-row-copy">
                  <strong>{item.nickname}</strong>
                  <small>第 {item.rank} 名</small>
                </div>
                <em>{score(item.score)}</em>
              </div>
            ))}
          </div>
        )}

        {!loading && ranks.length === 0 && (
          <div className="lb-empty">
            <BrandLogo size={48} className="lb-empty-logo" />
            <strong>本周期暂无上榜</strong>
            <p>去牌桌打几局，冲上{boardLabel}</p>
            <button
              type="button"
              className="lb-empty-cta"
              onClick={() => navigate(roomId ? `/game/${roomId}/play` : '/')}
            >
              前往大厅
            </button>
          </div>
        )}

        {!loading && ranks.length > 0 && ranks.length <= 3 && (
          <div className="lb-empty soft">
            <p>目前只有前 {ranks.length} 名有数据，继续冲刺可上榜</p>
          </div>
        )}
      </section>}

      {!error && <p className="lb-note">榜单每 5 分钟更新 · {data?.periodKey ?? '—'}</p>}
    </div>
  );
}
