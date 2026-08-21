import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, rmPacket } from '../api';
import { formatClaimTime } from '../lib/datetime';
import { goBack } from '../lib/nav';
import { getCachedSession } from '../sessionStore';

type PacketKind = 'game' | 'group';

type ClaimRow = {
  uid: string;
  nickname: string | null;
  avatarUrl: string | null;
  amountCents: string;
  at: string;
  isBanker?: boolean;
  isTail?: boolean;
};

type PacketLocationState = {
  kind?: PacketKind;
  greeting?: string;
  sender?: { name: string; avatar?: string | null };
  amountCents?: string;
  gone?: boolean;
};

const ASSISTANT_AVATAR = '/avatars/assistant.jpg';
const ASSISTANT_NAME = '至尊牛牛小助手';
const DEFAULT_GREETING = '恭喜发财，大吉大利';

export default function PacketDetail({ overlay = false }: { overlay?: boolean } = {}) {
  const { roomId = '', packetId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const preset = (location.state as PacketLocationState | null) ?? null;
  const kindHint = (searchParams.get('kind') as PacketKind | null) ?? preset?.kind ?? null;
  const myUid = getCachedSession()?.uid ?? '';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const [kind, setKind] = useState<PacketKind>(kindHint ?? 'group');
  const [greeting, setGreeting] = useState(preset?.greeting || DEFAULT_GREETING);
  const [sender, setSender] = useState(
    preset?.sender ?? { name: ASSISTANT_NAME, avatar: ASSISTANT_AVATAR },
  );
  const [amountCents, setAmountCents] = useState(preset?.amountCents);
  const [gone, setGone] = useState(preset?.gone === true);
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [totalCents, setTotalCents] = useState('0');
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function loadSpecifiedPacket(id: string) {
      const tryGroup = async () => {
        const detail = await api.groupPacket(id);
        if (cancelled) return;
        const mine = detail.claims.find((claim) => claim.uid === myUid);
        setKind('group');
        setSender({
          name: detail.sender.nickname || '玩家',
          avatar: detail.sender.avatarUrl,
        });
        setClaims(detail.claims);
        setTotalCents(detail.totalCents);
        setCount(detail.count);
        if (mine?.amountCents) setAmountCents(mine.amountCents);
        if (detail.remainingCount <= 0 && !mine) setGone(true);
      };
      const tryGame = async () => {
        const detail = await api.gamePacket(id);
        if (cancelled) return;
        const mine = detail.claims.find((claim) => claim.uid === myUid);
        setKind('game');
        setSender(
          detail.banker
            ? { name: detail.banker.nickname, avatar: detail.banker.avatarUrl }
            : preset?.sender ?? { name: ASSISTANT_NAME, avatar: ASSISTANT_AVATAR },
        );
        setGreeting(DEFAULT_GREETING);
        setClaims(detail.claims);
        setTotalCents(detail.totalCents);
        setCount(detail.participantCount);
        if (mine?.amountCents) setAmountCents(mine.amountCents);
      };

      if (kindHint === 'game') {
        await tryGame();
        return;
      }
      if (kindHint === 'group') {
        await tryGroup();
        return;
      }
      try {
        await tryGroup();
      } catch {
        await tryGame();
      }
    }

    async function loadCurrentRoundPacket() {
      const state = await api.roomState(roomId);
      if (cancelled) return;
      const round = state.round;
      if (!round?.packetId) throw new Error('当前没有可查看的红包');
      setKind('game');
      setSender(
        round.banker
          ? { name: round.banker.nickname, avatar: round.banker.avatarUrl }
          : { name: ASSISTANT_NAME, avatar: ASSISTANT_AVATAR },
      );
      setGreeting(DEFAULT_GREETING);
      setClaims(round.claims ?? []);
      setTotalCents(round.packetTotalCents ?? '0');
      setCount(round.participantCount ?? 0);
      if (state.me.claimedAmountCents) setAmountCents(state.me.claimedAmountCents);
    }

    setLoading(true);
    const task = packetId ? loadSpecifiedPacket(packetId) : loadCurrentRoundPacket();
    void task
      .then(() => {
        if (cancelled) return;
        setError('');
      })
      .catch((cause) => {
        if (!cancelled) setError((cause as Error).message || '红包详情加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [roomId, packetId, kindHint, myUid, retryKey]);

  const sortedClaims = useMemo(() => {
    return [...claims].sort((a, b) => {
      const diff = Number(b.amountCents) - Number(a.amountCents);
      if (diff) return diff;
      return Date.parse(a.at) - Date.parse(b.at);
    });
  }, [claims]);

  const luckyUid = sortedClaims.length > 1 ? sortedClaims[0].uid : null;

  const fallback = roomId ? `/game/${roomId}/play` : '/';
  const grabbedOut = count > 0 && claims.length >= count;
  const title = kind === 'game' ? '牛牛红包' : '红包';

  return (
    <div
      className={`wx-rp-result-page${overlay ? ' is-overlay' : ''}`}
      role={overlay ? 'dialog' : undefined}
      aria-modal={overlay || undefined}
    >
      <div className="wx-rp-result-top">
        <header className="wx-rp-result-nav">
          <button
            className="wx-rp-result-back"
            type="button"
            onClick={() => goBack(navigate, location, fallback)}
            aria-label="返回"
          >
            ‹
          </button>
          <strong>{title}</strong>
          <span aria-hidden />
        </header>

        <section className="wx-rp-result-hero">
          <div className="wx-rp-result-sender">
            {sender.avatar ? (
              <img src={sender.avatar} alt="" />
            ) : (
              <em>{(sender.name || '?').slice(0, 1)}</em>
            )}
            <span>{sender.name} 发出的红包</span>
          </div>
          <p className="wx-rp-result-greet">{greeting}</p>
          {gone && !amountCents ? (
            <div className="wx-rp-result-miss">手慢了，红包已被领完</div>
          ) : amountCents ? (
            <div className="wx-rp-result-amount">
              <span className="wx-rp-result-amount-unit">RM</span>
              <b>{rmPacket(amountCents)}</b>
              <i>已存入零钱余额</i>
            </div>
          ) : null}
        </section>
      </div>

      <section className="wx-rp-result-sheet" aria-label="领取名单">
        <div className="wx-rp-result-sheet-head">
          {count > 0
            ? `已领取 ${claims.length}/${count} 个，共 RM ${rmPacket(totalCents)}`
            : `已领取 ${claims.length} 个，共 RM ${rmPacket(totalCents)}`}
          {grabbedOut ? '，已抢光' : ''}
        </div>

        {error && (
          <div className="wx-rp-result-error" role="alert">
            <p>{error}</p>
            <button
              type="button"
              onClick={() => {
                setError('');
                setRetryKey((key) => key + 1);
              }}
            >
              重试
            </button>
          </div>
        )}

        {loading && !claims.length && !error && (
          <div className="wx-rp-result-empty">正在加载领取记录…</div>
        )}

        <div className="wx-rp-result-rows">
          {sortedClaims.map((claim) => {
            const name = claim.nickname || '玩家';
            const isLucky = claim.uid === luckyUid;
            const isMine = claim.uid === myUid;
            const roles = [claim.isBanker ? '庄' : '', claim.isTail ? '认尾' : '']
              .filter(Boolean)
              .join(' · ');
            return (
              <div
                className={`wx-rp-result-row${isMine ? ' mine' : ''}`}
                key={`${claim.uid}-${claim.at}`}
              >
                {claim.avatarUrl ? (
                  <img className="wx-rp-result-avatar" src={claim.avatarUrl} alt="" />
                ) : (
                  <span className="wx-rp-result-avatar ph">{name.slice(0, 1)}</span>
                )}
                <div className="wx-rp-result-row-main">
                  <div className="wx-rp-result-row-name">
                    <strong>{name}</strong>
                    {roles && <span className="wx-rp-result-role">{roles}</span>}
                  </div>
                  <small>{formatClaimTime(claim.at)}</small>
                </div>
                <div className="wx-rp-result-row-amt">
                  <b>RM {rmPacket(claim.amountCents)}</b>
                  {isLucky && <span className="wx-rp-result-lucky">手气最佳</span>}
                </div>
              </div>
            );
          })}
        </div>

        {!loading && !error && !claims.length && (
          <div className="wx-rp-result-empty">还没有人领取</div>
        )}
      </section>
    </div>
  );
}
