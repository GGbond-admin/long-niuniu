import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, rm, type RoomState } from '../api';

export default function PacketDetail() {
  const { roomId = '' } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<RoomState | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    const load = () =>
      api
        .roomState(roomId)
        .then((next) => {
          if (!cancelled) setState(next);
        })
        .catch((e) => {
          if (!cancelled) setError((e as Error).message || '加载失败');
        });
    void load();
    const timer = window.setInterval(() => void load(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [roomId]);

  const claims = state?.round?.claims ?? [];
  const total = state?.round?.packetTotalCents ?? '0';
  const count = state?.round?.participantCount ?? 0;
  const bankerName = state?.round?.banker?.nickname ?? '庄家';
  const bankerAvatar = state?.round?.banker?.avatarUrl;
  const inProgress = state?.round?.phase === 'CLAIMING';
  const luckyKey = claims.length
    ? claims.reduce((best, c) =>
        Number(c.amountCents) > Number(best.amountCents) ? c : best,
      )
    : null;

  return (
    <div className="page packet-detail wx-rp-detail-page">
      <header className="game-room-header">
        <button className="chat-back" type="button" onClick={() => navigate(-1)} aria-label="返回">
          ‹
        </button>
        <div className="game-room-title">
          <strong>牛牛红包</strong>
          <small>{bankerName} 发出的红包</small>
        </div>
        <span />
      </header>

      {error && <div className="chat-error-bar">{error}</div>}

      <section className="wx-rp-detail-hero">
        <div className="wx-rp-detail-avatar" aria-hidden>
          {bankerAvatar ? <img src={bankerAvatar} alt="" /> : bankerName.slice(0, 1)}
        </div>
        <p className="wx-rp-detail-sender">{bankerName} 发出的牛牛红包</p>
        <strong className="wx-rp-detail-greet">恭喜发财，大吉大利</strong>
        <p className="wx-rp-detail-meta">
          {count || '—'} 个红包 · 共 RM {rm(total)}
        </p>
        <span className={`wx-rp-detail-status ${inProgress ? 'live' : ''}`}>
          {inProgress ? '抢包进行中' : '认额核对中'}
        </span>
      </section>

      <div className="wx-rp-detail-list">
        <div className="wx-rp-list-head">
          <span>
            已领取 {claims.length}/{count || '—'} 个
          </span>
          {!inProgress && count > 0 && claims.length >= count && <span>已抢光</span>}
        </div>
        {claims.map((claim) => {
          const isLucky = luckyKey && claim === luckyKey && claims.length > 1;
          return (
            <div className="wx-rp-row" key={`${claim.uid}-${claim.at}`}>
              {claim.avatarUrl ? (
                <img src={claim.avatarUrl} alt="" />
              ) : (
                <span className="wx-rp-row-ph">{(claim.nickname || '玩').slice(0, 1)}</span>
              )}
              <div className="wx-rp-row-main">
                <strong>
                  {claim.nickname}
                  {claim.isBanker ? '（庄）' : ''}
                  {claim.isTail ? ' · 认尾' : ''}
                </strong>
                <small>
                  {new Date(claim.at).toLocaleString('zh-MY', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </small>
              </div>
              <div className="wx-rp-row-amt">
                <b>RM {rm(claim.amountCents)}</b>
                {isLucky && <span className="wx-rp-lucky">手气最佳</span>}
              </div>
            </div>
          );
        })}
        {!claims.length && (
          <div className="wx-rp-modal-empty">暂无领取记录，等待认额录入…</div>
        )}
      </div>
    </div>
  );
}
