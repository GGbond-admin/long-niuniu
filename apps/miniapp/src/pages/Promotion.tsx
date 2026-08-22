import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, rm } from '../api';
import { goBack } from '../lib/nav';

function malaysiaToday() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kuala_Lumpur' });
}

function shiftDay(date: string, days: number) {
  const next = new Date(`${date}T00:00:00+08:00`);
  next.setDate(next.getDate() + days);
  return next.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kuala_Lumpur' });
}

function shortDay(date: string) {
  return date.slice(5);
}

function rangeLabel(from: string, to: string, today: string) {
  if (from === to) return from === today ? '今日' : shortDay(from);
  return `${shortDay(from)} ~ ${shortDay(to)}`;
}

export default function Promotion() {
  const today = useMemo(() => malaysiaToday(), []);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [draftFrom, setDraftFrom] = useState(today);
  const [draftTo, setDraftTo] = useState(today);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [data, setData] = useState<Awaited<ReturnType<typeof api.promotion>> | null>(null);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    setError('');
    api
      .promotion({ from, to })
      .then((result) => {
        setData(result);
        setFrom(result.from);
        setTo(result.to);
      })
      .catch((reason) => setError((reason as Error).message || '加载失败'));
  }, [from, to]);

  function applyRange(nextFrom: string, nextTo: string) {
    const start = nextFrom > nextTo ? nextTo : nextFrom;
    const end = nextFrom > nextTo ? nextFrom : nextTo;
    const cappedEnd = end > today ? today : end;
    const cappedStart = start > today ? today : start;
    setDraftFrom(cappedStart);
    setDraftTo(cappedEnd);
    setFrom(cappedStart);
    setTo(cappedEnd);
    setPickerOpen(false);
  }

  function applyToday() {
    applyRange(today, today);
  }

  if (!data && !error) return <div className="loading">加载中…</div>;
  if (!data) {
    return (
      <div className="page subpage pm-page">
        <header className="subpage-header">
          <button type="button" onClick={() => goBack(navigate, location)} aria-label="返回">
            ‹
          </button>
          <div>
            <h1>我的推广</h1>
          </div>
          <span />
        </header>
        <div className="inline-alert error">{error}</div>
      </div>
    );
  }

  const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
  const settled = data.commissionStatus === 'PAID';
  const singleDay = data.from === data.to;
  const isToday = singleDay && data.from === today;

  return (
    <div className="page subpage pm-page">
      <header className="subpage-header">
        <button type="button" onClick={() => goBack(navigate, location)} aria-label="返回">
          ‹
        </button>
        <div>
          <h1>我的推广</h1>
        </div>
        <button className="pm-invite-link" type="button" onClick={() => navigate('/invite')}>
          邀请
        </button>
      </header>

      <section className="pm-hero">
        <div className="pm-hero-glow" aria-hidden />
        <div className="pm-hero-top">
          <div>
            <span className="pm-eyebrow">{settled ? '已结算佣金' : '预计佣金'}</span>
            <div className="pm-amount">
              <small>RM</small>
              <strong>{rm(data.commissionCents)}</strong>
            </div>
          </div>
          <button
            type="button"
            className={`pm-date${pickerOpen ? ' open' : ''}`}
            aria-expanded={pickerOpen}
            aria-label="选择日期区间"
            onClick={() => {
              setDraftFrom(from);
              setDraftTo(to);
              setPickerOpen((open) => !open);
            }}
          >
            <b>{rangeLabel(data.from, data.to, today)}</b>
            <i aria-hidden>▾</i>
          </button>
        </div>
        {pickerOpen && (
          <div className="pm-date-panel" role="dialog" aria-label="选择推广统计日期">
            <div className="pm-date-presets">
              <button type="button" className={isToday ? 'active' : ''} onClick={applyToday}>
                今日
              </button>
              <button
                type="button"
                className={data.from === shiftDay(today, -6) && data.to === today ? 'active' : ''}
                onClick={() => applyRange(shiftDay(today, -6), today)}
              >
                近7日
              </button>
              <button
                type="button"
                className={data.from === `${today.slice(0, 8)}01` && data.to === today ? 'active' : ''}
                onClick={() => applyRange(`${today.slice(0, 8)}01`, today)}
              >
                本月
              </button>
            </div>
            <div className="pm-date-fields">
              <label>
                <span>开始</span>
                <input
                  type="date"
                  value={draftFrom}
                  max={today}
                  onChange={(event) => setDraftFrom(event.target.value)}
                />
              </label>
              <label>
                <span>结束</span>
                <input
                  type="date"
                  value={draftTo}
                  min={draftFrom}
                  max={today}
                  onChange={(event) => setDraftTo(event.target.value)}
                />
              </label>
            </div>
            <button
              type="button"
              className="pm-date-apply"
              onClick={() => applyRange(draftFrom, draftTo)}
            >
              查看
            </button>
          </div>
        )}
        <div className="pm-hero-stats">
          <div>
            <small>累计邀请</small>
            <b>{data.invitedTotal}</b>
          </div>
          <div>
            <small>本月新增</small>
            <b>{data.invitedThisMonth}</b>
          </div>
          <div>
            <small>直属人数</small>
            <b>{data.downlines.length}</b>
          </div>
        </div>
      </section>

      <section className="pm-rates">
        <div className="pm-panel-head">
          <h2>返水比例</h2>
        </div>
        <div className="pm-rate-grid">
          <article>
            <span>自身</span>
            <strong>{pct(data.rates.self)}</strong>
          </article>
          <article>
            <span>直属</span>
            <strong>{pct(data.rates.l1)}</strong>
          </article>
          <article>
            <span>二级</span>
            <strong>{pct(data.rates.l2)}</strong>
          </article>
        </div>
      </section>

      <section className="pm-turnover">
        <div className="pm-panel-head">
          <h2>{singleDay ? '当日流水' : '区间流水'}</h2>
        </div>
        <div className="pm-turnover-list">
          <div className="pm-turnover-row">
            <span>自身有效流水</span>
            <b>RM {rm(data.turnover.selfCents)}</b>
          </div>
          <div className="pm-turnover-row">
            <span>直属有效流水</span>
            <b>RM {rm(data.turnover.l1Cents)}</b>
          </div>
          <div className="pm-turnover-row">
            <span>二级有效流水</span>
            <b>RM {rm(data.turnover.l2Cents)}</b>
          </div>
        </div>
      </section>

      <section className="pm-network">
        <div className="pm-panel-head">
          <h2>推广记录</h2>
          <span>{data.downlines.length} 人</span>
        </div>

        {data.downlines.length === 0 ? (
          <div className="pm-empty">
            <p>暂无直属贡献</p>
            <button type="button" className="pm-cta" onClick={() => navigate('/invite')}>
              去邀请
            </button>
          </div>
        ) : (
          <div className="pm-network-list">
            {data.downlines.map((d) => (
              <div className="pm-network-row" key={d.uid}>
                <div className="pm-network-avatar">
                  {d.avatarUrl ? (
                    <img src={d.avatarUrl} alt="" loading="lazy" />
                  ) : (
                    d.nickname?.[0] ?? '牛'
                  )}
                </div>
                <div className="pm-network-copy">
                  <strong>{d.nickname}</strong>
                  <small>
                    UID {d.uid} · {new Date(d.boundAt).toLocaleDateString('zh-MY')}
                  </small>
                </div>
                <b>RM {rm(d.contributionCents)}</b>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
