import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import BrandLogo from '../components/BrandLogo';
import PageHeader from '../components/PageHeader';

const phaseLabel: Record<string, string> = {
  WAITING: '等待开局',
  BANKER_BID: '庄家竞标',
  BETTING: '正在下注',
  SENDING_PACKET: '等待发包',
  CLAIMING: '正在抢包',
  CLAIM_EXPIRED: '认额核对中',
  SETTLING: '结算中',
};

function formatClock(value?: string) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleTimeString('zh-MY', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export default function ChatHub({ active = true }: { active?: boolean }) {
  const navigate = useNavigate();
  const [lobby, setLobby] = useState<Awaited<ReturnType<typeof api.lobby>> | null>(null);
  const [chatPreview, setChatPreview] = useState<Awaited<ReturnType<typeof api.chatPreview>> | null>(
    null,
  );
  const [noticePreview, setNoticePreview] = useState<Awaited<
    ReturnType<typeof api.noticesPreview>
  > | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const load = () =>
      void Promise.all([
        api.lobby(),
        api.chatPreview().catch(() => null),
        api.noticesPreview().catch(() => null),
      ]).then(([roomData, chat, notices]) => {
        if (cancelled) return;
        setLobby(roomData);
        setChatPreview(chat);
        setNoticePreview(notices);
      });
    void load();
    const timer = window.setInterval(load, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active]);

  const last = chatPreview?.latest;
  const supportUnread = chatPreview?.unread ?? 0;
  const noticeUnread = noticePreview?.unread ?? 0;
  const games = lobby?.games ?? [];
  const latestNotice = noticePreview?.latest;
  const noticePreviewText = latestNotice
    ? latestNotice.body
    : '实名、奖励与资金状态会同步到这里';
  const supportPreviewText = last
    ? last.type === 'STICKER'
      ? '[动画表情]'
      : (last.content ?? '充值提现、换设备或牌局争议')
    : '充值提现、换设备或牌局争议';
  return (
    <div className="page chat-hub-page">
      <PageHeader title="消息" subtitle="Inbox" />

      <section className="inbox-panel" aria-label="会话列表">
        {games.map((game, index) => {
          const gamePreview = game.round
            ? `第 ${game.round.seqNo} 局 · ${phaseLabel[game.round.phase] ?? game.round.phase}`
            : `${game.title} · 竞庄、下注、抢包`;
          const gameLive =
            !!game.round &&
            !['WAITING', 'FINISHED', 'CANCELLED'].includes(game.round.phase);
          return (
            <button
              className={`inbox-row inbox-row-live${gameLive ? ' is-live' : ''}`}
              type="button"
              key={game.id}
              style={{ animationDelay: `${40 + index * 35}ms` }}
              onClick={() => {
                if (game.kycRequired) navigate('/kyc');
                else navigate(`/game/${game.id}/play`);
              }}
            >
              <span className="inbox-avatar game" aria-hidden>
                {game.gameCode === 'SUPREME_NIUNIU' ? (
                  <BrandLogo size={44} />
                ) : (
                  game.title.slice(0, 1)
                )}
              </span>
              <span className="inbox-body">
                <span className="inbox-line">
                  <strong>{game.interactionGroupTitle}</strong>
                  <time className={gameLive ? 'live' : ''}>
                    {gameLive ? (
                      <>
                        <i />
                        LIVE
                      </>
                    ) : (
                      '互动群'
                    )}
                  </time>
                </span>
                <span className="inbox-preview">{gamePreview}</span>
              </span>
            </button>
          );
        })}

        <button
          className={`inbox-row${supportUnread > 0 ? ' has-unread' : ''}`}
          type="button"
          style={{ animationDelay: '100ms' }}
          onClick={() => navigate('/support')}
        >
          <span className="inbox-avatar support" aria-hidden>
            客
          </span>
          <span className="inbox-body">
            <span className="inbox-line">
              <strong>在线客服</strong>
              <time>{formatClock(last?.createdAt)}</time>
            </span>
            <span className="inbox-preview">{supportPreviewText}</span>
          </span>
          {supportUnread > 0 ? <b className="inbox-badge">{supportUnread}</b> : null}
        </button>

        <button
          className={`inbox-row${noticeUnread > 0 ? ' has-unread' : ''}`}
          type="button"
          style={{ animationDelay: '160ms' }}
          onClick={() => navigate('/notices')}
        >
          <span className="inbox-avatar notice" aria-hidden>
            通
          </span>
          <span className="inbox-body">
            <span className="inbox-line">
              <strong>系统通知</strong>
              <time>{formatClock(latestNotice?.publishedAt)}</time>
            </span>
            <span className="inbox-preview">{noticePreviewText}</span>
          </span>
          {noticeUnread > 0 ? <b className="inbox-badge">{noticeUnread}</b> : null}
        </button>
      </section>
    </div>
  );
}
