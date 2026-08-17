/**
 * 代理专属 · 称桶报表 — 对应《代理称桶制度与上下级分成机制说明文档》第二节
 * 公司数据（昨日）→ 我的称桶利润（自身 + 下级差额）→ 我的代理 → 我的玩家 → 状态条
 */
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, rm } from '../api';
import { goBack } from '../lib/nav';

function shiftDate(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('sv-SE');
}

const STATUS_LABEL: Record<string, { text: string; tone: string }> = {
  ESTIMATED: { text: '实时预估', tone: 'est' },
  PENDING: { text: '待发放', tone: 'pending' },
  SETTLED: { text: '已发放', tone: 'paid' },
  NO_DISTRIBUTION: { text: '不分配（负池结转）', tone: 'none' },
};

export default function AgentReport() {
  const [date, setDate] = useState<string | undefined>(undefined);
  const [data, setData] = useState<Awaited<ReturnType<typeof api.agentReport>> | null>(null);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    setError('');
    api
      .agentReport(date)
      .then(setData)
      .catch((reason) => setError((reason as Error).message || '加载失败'));
  }, [date]);

  if (!data && !error) return <div className="loading">加载中…</div>;
  if (!data) {
    return (
      <div className="page subpage ag-page">
        <header className="subpage-header">
          <button type="button" onClick={() => goBack(navigate, location)} aria-label="返回">
            ‹
          </button>
          <div>
            <h1>称桶报表</h1>
          </div>
          <span />
        </header>
        <div className="inline-alert error">{error}</div>
      </div>
    );
  }

  const status = STATUS_LABEL[data.status] ?? STATUS_LABEL.ESTIMATED;
  const canNext = data.date < data.today;
  const subagentTotal = data.subagents.reduce(
    (sum, row) => sum + BigInt(row.amountCents),
    0n,
  );
  const subagentTurnoverTotal = data.subagents.reduce(
    (sum, row) => sum + BigInt(row.teamTurnoverCents),
    0n,
  );
  const playerTurnoverTotal = data.players.reduce(
    (sum, row) => sum + BigInt(row.turnoverCents),
    0n,
  );

  return (
    <div className="page subpage ag-page">
      <header className="subpage-header">
        <button type="button" onClick={() => goBack(navigate, location)} aria-label="返回">
          ‹
        </button>
        <div>
          <h1>称桶报表</h1>
        </div>
        <span />
      </header>

      <section className="ag-datebar">
        <div>
          <small>报表日期</small>
          <div className="ag-date-nav">
            <button type="button" aria-label="前一天" onClick={() => setDate(shiftDate(data.date, -1))}>
              ‹
            </button>
            <b>{data.date}</b>
            <button
              type="button"
              aria-label="后一天"
              disabled={!canNext}
              onClick={() => canNext && setDate(shiftDate(data.date, 1))}
            >
              ›
            </button>
          </div>
        </div>
        <span className={`ag-status ${status.tone}`}>{status.text}</span>
      </section>

      <section className="ag-panel">
        <div className="ag-panel-head">
          <h2>公司数据</h2>
          <small>{data.date === data.today ? '当日实时' : '当日快照'}</small>
        </div>
        <div className="ag-company-grid">
          <article>
            <small>公司总流水</small>
            <strong>RM {rm(data.company.turnoverCents)}</strong>
          </article>
          <article>
            <small>公司总支出</small>
            <strong>RM {rm(data.company.expenseCents)}</strong>
          </article>
          <article>
            <small>利润池</small>
            <strong className={BigInt(data.company.netPoolCents) < 0n ? 'neg' : 'pos'}>
              RM {rm(data.company.netPoolCents)}
            </strong>
          </article>
        </div>
      </section>

      <section className="ag-panel ag-profit">
        <div className="ag-panel-head">
          <h2>我的称桶利润</h2>
          <small>占成 {data.mine.sharePoints}/{data.mine.bucketBase}</small>
        </div>
        <div className="ag-profit-equation">
          <div className="ag-profit-total">
            <small>我的称桶利润（全部）</small>
            <strong>RM {rm(data.mine.totalAmountCents)}</strong>
          </div>
          <i>=</i>
          <div className="ag-profit-part">
            <small>代理称桶利润</small>
            <b>RM {rm(data.mine.overrideAmountCents)}</b>
          </div>
          <i>+</i>
          <div className="ag-profit-part">
            <small>玩家称桶利润</small>
            <b>RM {rm(data.mine.selfAmountCents)}</b>
          </div>
        </div>
        <div className="ag-profit-meta">
          <span>
            自身流水 <b>RM {rm(data.mine.selfTurnoverCents)}</b>
          </span>
          <span>
            团队流水 <b>RM {rm(data.mine.teamTurnoverCents)}</b>
          </span>
          <span>
            贡献比 <b>{(data.mine.contributionBp / 100).toFixed(2)}%</b>
          </span>
        </div>
      </section>

      <section className="ag-panel">
        <div className="ag-panel-head">
          <h2>我的代理</h2>
          <button type="button" className="ag-more" onClick={() => navigate('/agent/sharing')}>
            分成管理 ›
          </button>
        </div>
        {data.subagents.length === 0 ? (
          <p className="ag-empty">暂无直属下级代理。可在「玩家列表」将符合条件的玩家升级为代理。</p>
        ) : (
          <div className="ag-table">
            <div className="ag-table-row head">
              <span>代理账号</span>
              <span>有效流水</span>
              <span>我的剩余占成</span>
              <span>我的利润</span>
            </div>
            {data.subagents.map((row) => (
              <div className="ag-table-row" key={row.uidMasked + row.label}>
                <span className="ag-cell-name">
                  <strong>{row.label}</strong>
                  <small>{row.uidMasked}</small>
                </span>
                <span>RM {rm(row.teamTurnoverCents)}</span>
                <span className="ag-diff">{row.diffPoints} 点</span>
                <span className="ag-money">RM {rm(row.amountCents)}</span>
              </div>
            ))}
            <div className="ag-table-row total">
              <span>合计</span>
              <span>RM {rm(subagentTurnoverTotal)}</span>
              <span>—</span>
              <span className="ag-money">RM {rm(subagentTotal)}</span>
            </div>
          </div>
        )}
        <p className="ag-note">* 我的剩余占成 = 我的占成 − 给下级的占成，利润按下级团队流水折算</p>
      </section>

      <section className="ag-panel">
        <div className="ag-panel-head">
          <h2>我的玩家</h2>
          <button type="button" className="ag-more" onClick={() => navigate('/agent/players')}>
            查看全部 ›
          </button>
        </div>
        {data.players.length === 0 ? (
          <p className="ag-empty">暂无归属玩家。分享推荐二维码，新玩家注册后自动归属您名下。</p>
        ) : (
          <div className="ag-table cols3">
            <div className="ag-table-row head">
              <span>玩家账号</span>
              <span>有效流水</span>
              <span>我的利润</span>
            </div>
            {data.players.map((row) => (
              <div className="ag-table-row" key={row.uidMasked}>
                <span className="ag-cell-name">
                  <strong>{row.nickname ?? '玩家'}</strong>
                  <small>{row.uidMasked}</small>
                </span>
                <span>RM {rm(row.turnoverCents)}</span>
                <span className="ag-money">RM {rm(row.profitCents)}</span>
              </div>
            ))}
            <div className="ag-table-row total">
              <span>合计</span>
              <span>RM {rm(playerTurnoverTotal)}</span>
              <span className="ag-money">RM {rm(data.mine.selfAmountCents)}</span>
            </div>
          </div>
        )}
        <p className="ag-note">
          * 玩家利润按我的占成 {data.mine.sharePoints}/{data.mine.bucketBase} 计算（玩家无下级分成）
        </p>
      </section>

      <footer className="ag-footbar">
        <span className="ag-foot-points">
          我的当前占成 <b>{data.mine.sharePoints} 点</b>
        </span>
        <small>称桶利润以平台最终审核发放为准，数据更新可能存在延迟</small>
      </footer>
    </div>
  );
}
