import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, rm } from '../api';
import BrandLogo from '../components/BrandLogo';

function shiftDate(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('sv-SE');
}

export default function Promotion() {
  const [date, setDate] = useState<string | undefined>(undefined);
  const [data, setData] = useState<Awaited<ReturnType<typeof api.promotion>> | null>(null);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    setError('');
    api
      .promotion(date)
      .then(setData)
      .catch((reason) => setError((reason as Error).message || '加载失败'));
  }, [date]);

  if (!data && !error) return <div className="loading">加载中…</div>;
  if (!data) {
    return (
      <div className="page subpage pm-page">
        <header className="subpage-header">
          <button type="button" onClick={() => navigate(-1)} aria-label="返回">
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

  return (
    <div className="page subpage pm-page">
      <header className="subpage-header">
        <button type="button" onClick={() => navigate(-1)} aria-label="返回">
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
          <div className="pm-date">
            <button type="button" aria-label="前一天" onClick={() => setDate(shiftDate(data.date, -1))}>
              ‹
            </button>
            <b>{data.date}</b>
            <button type="button" aria-label="后一天" onClick={() => setDate(shiftDate(data.date, 1))}>
              ›
            </button>
          </div>
        </div>
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
          <div>
            <small>返水比例</small>
            <h2>三级贡献</h2>
          </div>
        </div>
        <div className="pm-rate-grid">
          <article>
            <span>自身</span>
            <strong>{pct(data.rates.self)}</strong>
            <small>有效下注</small>
          </article>
          <article>
            <span>直属</span>
            <strong>{pct(data.rates.l1)}</strong>
            <small>一级贡献</small>
          </article>
          <article>
            <span>二级</span>
            <strong>{pct(data.rates.l2)}</strong>
            <small>二级贡献</small>
          </article>
        </div>
      </section>

      <section className="pm-turnover">
        <div className="pm-panel-head">
          <div>
            <small>当日流水</small>
            <h2>有效流水</h2>
          </div>
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
          <div>
            <small>团队贡献</small>
            <h2>推广记录</h2>
          </div>
          <span>{data.downlines.length} 人</span>
        </div>

        {data.downlines.length === 0 ? (
          <div className="pm-empty">
            <BrandLogo size={48} className="pm-empty-logo" />
            <strong>暂无推广记录</strong>
            <p>邀请好友绑定后，将在此显示直属贡献</p>
            <button type="button" className="pm-cta" onClick={() => navigate('/invite')}>
              去邀请好友
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
