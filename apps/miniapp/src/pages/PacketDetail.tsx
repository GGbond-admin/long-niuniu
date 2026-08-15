import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, rm, type RoomState } from '../api';
import { goBack } from '../lib/nav';

export default function PacketDetail() {
  const { roomId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [state, setState] = useState<RoomState | null>(null);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    const load = () =>
      api
        .roomState(roomId)
        .then((next) => {
          if (cancelled) return;
          setState(next);
          setError('');
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
  }, [roomId, retryKey]);

  const claims = state?.round?.claims ?? [];
  const total = state?.round?.packetTotalCents ?? '0';
  const count = state?.round?.participantCount ?? 0;
  const bankerName = state?.round?.banker?.nickname ?? '庄家';
  const bankerAvatar = state?.round?.banker?.avatarUrl;
  const phase = state?.round?.phase ?? '';
  const inProgress = phase === 'CLAIMING';
  const statusText = inProgress
    ? '抢包进行中'
    : phase === 'FINISHED'
      ? '本局已完成'
      : phase === 'CANCELLED'
        ? '本局已取消'
        : phase === 'SETTLING'
          ? '结算中'
          : '认额核对中';
  const luckyKey = claims.length
    ? claims.reduce((best, c) =>
        Number(c.amountCents) > Number(best.amountCents) ? c : best,
      )
    : null;

  return (
    <div className="page packet-detail wx-rp-detail-page">
      <header className="game-room-header">
        <button className="chat-back" type="button" onClick={() => goBack(navigate, location, roomId ? `/game/${roomId}/play` : '/')} aria-label="返回">
          ‹
        </button>
        <div className="game-room-title">
          <strong>牛牛红包</strong>
          <small>{bankerName} 发出的红包</small>
        </div>
        <span />
      </header>

      {/* 首屏失败给重试入口；已有数据时仅提示刷新失败，轮询成功后自动消除 */}
      {error && !state && (
        <div className="wx-rp-detail-error">
          <div className="chat-error-bar">{error}</div>
          <button
            className="primary-action"
            type="button"
            style={{ margin: '12px 16px 0' }}
            onClick={() => {
              setError('');
              setRetryKey((k) => k + 1);
            }}
          >
            重试
          </button>
        </div>
      )}
      {error && state && <div className="chat-error-bar">刷新失败，正在自动重试…</div>}
      {!error && !state && <div className="empty-inline">加载中…</div>}

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
          {statusText}
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
