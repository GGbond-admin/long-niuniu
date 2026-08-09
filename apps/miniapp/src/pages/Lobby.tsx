import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import BrandLogo from '../components/BrandLogo';

type LobbyData = Awaited<ReturnType<typeof api.lobby>>;

const LOBBY_BANNERS = [
  { id: 'banner-01', src: '/banners/banner-01.jpg', alt: '至尊牛牛 · 互动群对局' },
  { id: 'banner-02', src: '/banners/banner-02.jpg', alt: '至尊牛牛 · 公平结算' },
] as const;

export default function Lobby({ active = true }: { active?: boolean }) {
  const navigate = useNavigate();
  const [data, setData] = useState<LobbyData | null>(null);
  const [error, setError] = useState('');
  const [bannerIndex, setBannerIndex] = useState(0);

  useEffect(() => {
    if (!active) return;
    api.lobby().then(setData).catch((reason) => setError(reason.message));
    const timer = window.setInterval(() => api.lobby().then(setData).catch(() => undefined), 10_000);
    return () => window.clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (!active || LOBBY_BANNERS.length <= 1) return;
    const timer = window.setInterval(() => {
      setBannerIndex((current) => (current + 1) % LOBBY_BANNERS.length);
    }, 4_500);
    return () => window.clearInterval(timer);
  }, [active]);

  const announcement = data?.announcements[0];
  const games = data?.games ?? [];
  const noticeTitle = announcement?.title ?? '公平牌局 · 实时结算 · 全天候服务';
  const noticeBody = announcement?.body ?? '请认准官方机器人；进入互动群参与对局。';

  return (
    <div className="page lobby-page">
      <section className="arena-ticker" aria-label="平台公告">
        <span className="arena-ticker-tag">公告</span>
        <div className="arena-ticker-track">
          <p>
            <span>
              {noticeTitle}
              <em> · </em>
              {noticeBody}
            </span>
            <span aria-hidden>
              {noticeTitle}
              <em> · </em>
              {noticeBody}
            </span>
          </p>
        </div>
      </section>

      <section className="arena-hero" aria-label="活动海报">
        <div className="arena-hero-frame">
          <div
            className="lobby-banner-track"
            style={{ transform: `translateX(-${bannerIndex * 100}%)` }}
          >
            {LOBBY_BANNERS.map((banner) => (
              <div className="lobby-banner-slide" key={banner.id}>
                <img src={banner.src} alt={banner.alt} draggable={false} />
              </div>
            ))}
          </div>
          {LOBBY_BANNERS.length > 1 && (
            <div className="lobby-banner-dots" role="tablist" aria-label="海报分页">
              {LOBBY_BANNERS.map((banner, index) => (
                <button
                  key={banner.id}
                  type="button"
                  role="tab"
                  aria-selected={bannerIndex === index}
                  className={bannerIndex === index ? 'active' : ''}
                  onClick={() => setBannerIndex(index)}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      {error && <div className="inline-alert error">{error}</div>}

      <section className="arena-section">
        <div className="arena-section-head">
          <strong>热门游戏</strong>
          <span>GAMES</span>
        </div>

        {!data ? (
          <div className="skeleton lobby-hero-skeleton" />
        ) : !games.length ? (
          <div className="arena-empty">
            <BrandLogo size={68} />
            <strong>牌桌暂未开放</strong>
            <p>运营开启互动群后即可入场，请留意顶部公告。</p>
          </div>
        ) : (
          <div className="game-card-list">
            {games.map((game) => (
              <button
                className={`game-card${game.gameCode === 'SUPREME_NIUNIU' ? ' game-card-niuniu' : ''}`}
                type="button"
                key={game.id}
                onClick={() => navigate(`/game/${game.id}`)}
              >
                <span className="game-card-shine" aria-hidden />
                <div className="game-card-avatar">
                  {game.gameCode === 'SUPREME_NIUNIU' ? (
                    <BrandLogo size={60} />
                  ) : (
                    <span className="game-card-letter">{game.title.slice(0, 1)}</span>
                  )}
                  <span className="game-card-live">
                    <i /> {game.round ? 'LIVE' : 'READY'}
                  </span>
                </div>
                <div className="game-card-copy">
                  <h2>{game.title}</h2>
                  <p>{game.interactionGroupTitle} · 独立规则与榜单</p>
                </div>
                <span className="game-card-go">进入</span>
              </button>
            ))}
          </div>
        )}

        <div className="game-soon" aria-label="更多游戏待更新">
          <div className="game-soon-rail" aria-hidden>
            <div className="game-soon-cover c1">
              <span>?</span>
            </div>
            <div className="game-soon-cover c2">
              <span>?</span>
            </div>
            <div className="game-soon-cover c3">
              <span>?</span>
            </div>
          </div>
          <div className="game-soon-body">
            <span className="game-soon-badge">COMING SOON</span>
            <strong>更多游戏即将上线</strong>
            <p>新玩法筹备中，敬请期待</p>
          </div>
          <div className="game-soon-lock" aria-hidden>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
              <rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.8" />
              <path
                d="M8 11V8a4 4 0 0 1 8 0v3"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </div>
        </div>
      </section>
    </div>
  );
}
