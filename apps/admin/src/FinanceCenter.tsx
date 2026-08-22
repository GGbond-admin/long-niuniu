import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { openProtectedUpload, post, request, rm } from './api';

type Row = Record<string, any>;
type Tab = 'overview' | 'deposits' | 'withdrawals' | 'ledger' | 'payees';
type OrderKind = 'deposit' | 'withdraw';
type ChartMode = 'cash' | 'pnl';
type StatusKey = 'ALL' | 'PENDING' | 'COMPLETED' | 'REJECTED';

const ACCOUNT_INFO: Record<string, [string, string]> = {
  USER_AVAILABLE: ['用户可用余额', '玩家钱包可用资金'],
  USER_FREEZE_BET: ['用户投注冻结', '下注后冻结，结算时解冻'],
  USER_FREEZE_BANKER: ['用户上庄冻结', '上庄押金冻结，下庄时结余返还'],
  USER_FREEZE_WITHDRAW: ['用户提现冻结', '提现审核中冻结的资金'],
  PLATFORM_RAKE: ['抽水收入', '闲家赢 + 庄家盈利，只进不出'],
  PLATFORM_FEES: ['庄家费用收入', '上庄费 + 服务费'],
  PLATFORM_RESERVE: ['红包备付金', '代包费 − 内部红包发放'],
  PLATFORM_REBATE: ['推广返水支出户', '累计已发返水佣金'],
  PLATFORM_REWARD: ['活动奖励支出户', '累计已发每日/排行榜奖励'],
  PLATFORM_PROFIT_POOL: ['利润池分成支出户', '累计已发代理称桶分成'],
  TNG_TRANSIT: ['TNG 在途', '充值/提现过渡科目'],
  ADJUST_CLEARING: ['人工调账清算户', '调账对方科目'],
};

const REF_LABELS: Record<string, string> = {
  deposit: '充值到账',
  withdraw_freeze: '提现申请',
  withdraw_complete: '提现成功',
  withdraw_refund: '提现退回',
  withdraw_fee: '提现手续费',
  rebate: '推广返水',
  rebate_revoke: '推广返水撤回',
  profit_share: '代理分成',
  reward: '活动奖励',
  leaderboard_reward: '排行榜奖励',
  rake: '平台抽水',
  fee_banker_seat: '上庄费',
  fee_service: '服务费',
  fee_packet_agent: '代包费',
  adjust: '人工调账',
  bet: '下注冻结',
  bet_adjust: '改注调整',
  bet_withdraw: '撤回下注',
  bid: '上庄冻结',
  settle_win: '对局赢取',
  settle_lose: '对局输掉',
  settle_bet_return: '本金退回',
  settle_tie_return: '平局退回',
  settle_banker_return: '庄池结余退回',
  tip: '打赏客服',
  packet_create: '对局红包发出',
  packet_claim: '对局红包核销',
  packet_return: '对局红包退回',
  round_cancel_refund: '取消局退款',
};

const STATUS_LABEL: Record<StatusKey, string> = {
  ALL: '全部',
  PENDING: '待审',
  COMPLETED: '已完成',
  REJECTED: '已驳回',
};

function cents(value: unknown) {
  return Number(BigInt(String(value ?? 0))) / 100;
}

function todayKL() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kuala_Lumpur' });
}

function shiftKL(day: string, delta: number) {
  const next = new Date(new Date(`${day}T12:00:00+08:00`).getTime() + delta * 86_400_000);
  return next.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kuala_Lumpur' });
}

const RANGE_PRESETS = [
  { id: 'today', label: '今天' },
  { id: 'yesterday', label: '昨天' },
  { id: '3', label: '3日' },
  { id: '7', label: '7日' },
  { id: '15', label: '15日' },
] as const;

type RangePresetId = (typeof RANGE_PRESETS)[number]['id'];

function rangeForPreset(id: RangePresetId, today = todayKL()) {
  if (id === 'today') return { from: today, to: today };
  if (id === 'yesterday') {
    const yesterday = shiftKL(today, -1);
    return { from: yesterday, to: yesterday };
  }
  const days = Number(id);
  return { from: shiftKL(today, -(days - 1)), to: today };
}

function matchRangePreset(from: string, to: string, today = todayKL()): RangePresetId | '' {
  return RANGE_PRESETS.find(({ id }) => {
    const range = rangeForPreset(id, today);
    return range.from === from && range.to === to;
  })?.id ?? '';
}

function money(value: unknown) {
  return `RM ${rm(String(value ?? 0))}`;
}

function withdrawNet(item: Row) {
  const snap = item.targetSnapshot ?? {};
  const gross = BigInt(String(item.amountCents ?? 0));
  const feeRaw = String(snap.feeCents ?? '0');
  const fee = /^\d+$/.test(feeRaw) ? BigInt(feeRaw) : 0n;
  return { fee, net: fee <= gross ? gross - fee : gross };
}

function orderChannel(item: Row, kind: OrderKind) {
  if (kind === 'withdraw') {
    const snap = item.targetSnapshot ?? {};
    return [snap.institution ?? item.channel, snap.accountName, snap.accountNo].filter(Boolean).join(' · ') || '提现';
  }
  if (item.channel === 'VPAY') {
    return item.providerTradeNo ? `VPay · ${item.providerTradeNo}` : 'VPay';
  }
  const snap = item.payeeSnapshot ?? {};
  return [snap.bankName, snap.accountName, snap.accountNo].filter(Boolean).join(' · ') || '人工转账';
}

function FinanceChart({ items, mode }: { items: Row[]; mode: ChartMode }) {
  const width = 760;
  const height = 248;
  const pad = { top: 18, right: 16, bottom: 32, left: 16 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;
  const points = items.map((item) => ({
    date: String(item.date).slice(5),
    net: cents(item.netProfitCents),
    in: cents(item.depositsCents),
    out: cents(item.withdrawalsCents),
    income: cents(item.incomeCents),
    expense: cents(item.expenseCents),
  }));
  const values =
    mode === 'cash'
      ? points.flatMap((item) => [Math.abs(item.net), item.in, item.out])
      : points.flatMap((item) => [Math.abs(item.net), item.income, item.expense]);
  const maxAbs = Math.max(1, ...values);
  const zeroY = pad.top + chartH / 2;
  const scale = (value: number) => (value / maxAbs) * (chartH / 2);
  const slot = chartW / Math.max(1, points.length);
  const barW = Math.min(14, slot * 0.28);

  return (
    <div className="fin-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={mode === 'cash' ? '净利与充提' : '收入支出与净利'}>
        <line x1={pad.left} x2={width - pad.right} y1={zeroY} y2={zeroY} className="fin-chart-axis" />
        {points.map((point, index) => {
          const cx = pad.left + slot * index + slot / 2;
          const left = mode === 'cash' ? point.in : point.income;
          const right = mode === 'cash' ? point.out : point.expense;
          return (
            <g key={point.date}>
              <rect
                x={cx - barW - 2}
                y={zeroY - scale(left)}
                width={barW}
                height={Math.max(1, scale(left))}
                className={mode === 'cash' ? 'fin-bar-in' : 'fin-bar-income'}
              >
                <title>
                  {mode === 'cash'
                    ? `${point.date} 充值 RM ${point.in.toFixed(2)}`
                    : `${point.date} 收入 RM ${point.income.toFixed(2)}`}
                </title>
              </rect>
              <rect
                x={cx + 2}
                y={zeroY - scale(right)}
                width={barW}
                height={Math.max(1, scale(right))}
                className={mode === 'cash' ? 'fin-bar-out' : 'fin-bar-expense'}
              >
                <title>
                  {mode === 'cash'
                    ? `${point.date} 提现 RM ${point.out.toFixed(2)}`
                    : `${point.date} 支出 RM ${point.expense.toFixed(2)}`}
                </title>
              </rect>
              <circle
                cx={cx}
                cy={point.net >= 0 ? zeroY - scale(point.net) : zeroY + scale(Math.abs(point.net))}
                r="3.2"
                className={point.net >= 0 ? 'fin-dot-net' : 'fin-dot-net is-neg'}
              >
                <title>{`${point.date} 净利 RM ${point.net.toFixed(2)}`}</title>
              </circle>
              <text x={cx} y={height - 10} className="fin-chart-tick">
                {point.date}
              </text>
            </g>
          );
        })}
        <polyline
          className="fin-line-net"
          fill="none"
          points={points
            .map((point, index) => {
              const cx = pad.left + slot * index + slot / 2;
              const y = point.net >= 0 ? zeroY - scale(point.net) : zeroY + scale(Math.abs(point.net));
              return `${cx},${y}`;
            })
            .join(' ')}
        />
      </svg>
      <div className="fin-legend">
        {mode === 'cash' ? (
          <>
            <span><i className="in" /> 充值到账</span>
            <span><i className="out" /> 提现出账</span>
          </>
        ) : (
          <>
            <span><i className="income" /> 抽水+上庄+服务费</span>
            <span><i className="expense" /> 奖励+返水+分成</span>
          </>
        )}
        <span><i className="net" /> 当日净利</span>
      </div>
    </div>
  );
}

function OrderBook({
  kind,
  onOpenUser,
  canReview,
  preferPending = false,
  onReviewed,
}: {
  kind: OrderKind;
  onOpenUser: (userId: string) => void;
  canReview?: boolean;
  preferPending?: boolean;
  onReviewed?: () => void;
}) {
  const [status, setStatus] = useState<StatusKey>(preferPending ? 'PENDING' : 'ALL');
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<Row[]>([]);
  const [counts, setCounts] = useState<Record<StatusKey, number>>({ ALL: 0, PENDING: 0, COMPLETED: 0, REJECTED: 0 });
  const [amounts, setAmounts] = useState<Record<StatusKey, string>>({ ALL: '0', PENDING: '0', COMPLETED: '0', REJECTED: '0' });
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pageSize = 30;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  async function load(nextPage = page, nextStatus = status) {
    setBusy(true);
    try {
      const params = new URLSearchParams({
        kind,
        status: nextStatus,
        page: String(nextPage),
        pageSize: String(pageSize),
      });
      if (query.trim()) params.set('q', query.trim());
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const result = await request<{
        items: Row[];
        total: number;
        page: number;
        counts?: Record<StatusKey, number>;
        amounts?: Record<StatusKey, string>;
      }>(`/api/admin/finance/orders?${params}`);
      setError('');
      setItems(result.items ?? []);
      setTotal(result.total ?? 0);
      setPage(result.page ?? nextPage);
      if (result.counts) setCounts(result.counts);
      if (result.amounts) setAmounts(result.amounts);
    } catch (reason) {
      setItems([]);
      setTotal(0);
      setError((reason as Error).message || '订单列表加载失败');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load(1, status);
  }, [kind, status]);

  async function review(item: Row, action: 'complete' | 'reject') {
    let reason: string | undefined;
    if (action === 'reject') {
      const input = prompt('驳回原因');
      if (input === null) return;
      if (input.trim().length < 2) {
        alert('请填写驳回原因（至少 2 字）');
        return;
      }
      reason = input.trim();
    }
    if (action === 'complete') {
      const text =
        kind === 'deposit'
          ? `确认该笔 ${money(item.amountCents)}（UID ${item.user.uid} · ${item.user.nickname}）的充值已到账？`
          : `确认该笔 ${money(item.amountCents)}（UID ${item.user.uid} · ${item.user.nickname}）的提现已转账？`;
      if (!window.confirm(text)) return;
    }
    setBusy(true);
    try {
      setError('');
      await post(`/api/admin/orders/${kind}/${item.id}/review`, { action, reason });
      await load();
      onReviewed?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel fin-book">
      <div className="panel-title">
        <div>
          <small>{kind === 'deposit' ? 'DEPOSIT BOOK' : 'WITHDRAW BOOK'}</small>
          <h2>{kind === 'deposit' ? '全部充值订单' : '全部提现订单'}</h2>
        </div>
        <strong className="fin-book-sum">
          {STATUS_LABEL[status]} {counts[status]} 单 · {money(amounts[status])}
        </strong>
      </div>
      <div className="fin-book-toolbar">
        <div className="fin-status-pills" role="tablist">
          {(['ALL', 'PENDING', 'COMPLETED', 'REJECTED'] as StatusKey[]).map((value) => (
            <button
              type="button"
              key={value}
              className={status === value ? 'active' : ''}
              onClick={() => setStatus(value)}
            >
              {STATUS_LABEL[value]}
              <em>{counts[value]}</em>
            </button>
          ))}
        </div>
        <form
          className="fin-book-search"
          onSubmit={(event) => {
            event.preventDefault();
            void load(1, status);
          }}
        >
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 UID 或昵称"
          />
          <button type="submit" className="small" disabled={busy}>
            {busy ? '查询中…' : '查询'}
          </button>
        </form>
      </div>
      {error ? <p className="fin-error">{error}</p> : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>单号</th>
              <th>用户</th>
              <th>金额</th>
              <th>状态</th>
              <th>{kind === 'deposit' ? '渠道 / 收款' : '提现账户'}</th>
              <th>提交时间</th>
              <th>审核时间</th>
              {canReview ? <th>操作</th> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const extra = kind === 'withdraw' ? withdrawNet(item) : null;
              const opened = openId === item.id;
              return (
                <Fragment key={item.id}>
                  <tr className={opened ? 'is-open' : ''} onClick={() => setOpenId(opened ? null : item.id)}>
                    <td>
                      <strong>{String(item.id).slice(-8)}</strong>
                      <small>{item.channel === 'VPAY' ? 'VPay' : item.channel || (kind === 'deposit' ? '人工' : '提现')}</small>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="linkish"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenUser(item.user.id);
                        }}
                      >
                        {item.user.nickname || item.user.uid}
                        <small>UID {item.user.uid}</small>
                      </button>
                    </td>
                    <td className="money">
                      {money(item.amountCents)}
                      {extra ? <small>实转 {money(extra.net)}</small> : null}
                    </td>
                    <td>
                      <em className={`fx-status is-${String(item.status).toLowerCase()}`}>
                        {STATUS_LABEL[item.status as StatusKey] ?? item.status}
                      </em>
                    </td>
                    <td>{orderChannel(item, kind)}</td>
                    <td>{new Date(item.createdAt).toLocaleString('zh-MY')}</td>
                    <td>{item.reviewedAt ? new Date(item.reviewedAt).toLocaleString('zh-MY') : '—'}</td>
                    {canReview ? (
                      <td className="actions" onClick={(event) => event.stopPropagation()}>
                        {item.status === 'PENDING' ? (
                          <>
                            <button className="danger small" type="button" disabled={busy} onClick={() => void review(item, 'reject')}>
                              驳回
                            </button>
                            <button className="success small" type="button" disabled={busy} onClick={() => void review(item, 'complete')}>
                              {kind === 'deposit' ? '确认到账' : '确认已转账'}
                            </button>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                    ) : null}
                  </tr>
                  {opened && (
                    <tr key={`${item.id}-detail`} className="fin-order-detail">
                      <td colSpan={canReview ? 8 : 7}>
                        <dl>
                          <div>
                            <dt>完整单号</dt>
                            <dd>{item.id}</dd>
                          </div>
                          <div>
                            <dt>请求号</dt>
                            <dd>{item.requestId || '—'}</dd>
                          </div>
                          {kind === 'deposit' && (
                            <>
                              <div>
                                <dt>通道代码</dt>
                                <dd>{item.providerCode || '—'}</dd>
                              </div>
                              <div>
                                <dt>平台单号</dt>
                                <dd>{item.providerTradeNo || '—'}</dd>
                              </div>
                              <div>
                                <dt>实付 / 入账</dt>
                                <dd>
                                  {item.paidAmountCents != null ? money(item.paidAmountCents) : '—'}
                                  {' / '}
                                  {item.creditedAmountCents != null ? money(item.creditedAmountCents) : '—'}
                                </dd>
                              </div>
                            </>
                          )}
                          {kind === 'withdraw' && extra && (
                            <div>
                              <dt>手续费</dt>
                              <dd>
                                {money(extra.fee)}
                                {item.targetSnapshot?.freeQuota === true ? ' · 免费次数' : ''}
                              </dd>
                            </div>
                          )}
                          <div>
                            <dt>驳回原因</dt>
                            <dd>{item.rejectReason || '—'}</dd>
                          </div>
                          {item.proofUrl && (
                            <div>
                              <dt>凭证</dt>
                              <dd>
                                <button
                                  type="button"
                                  className="small"
                                  onClick={() => void openProtectedUpload(item.proofUrl)}
                                >
                                  查看凭证
                                </button>
                              </dd>
                            </div>
                          )}
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {items.length === 0 && <p className="fin-quiet">{busy ? '正在读取…' : '没有匹配的订单'}</p>}
      </div>
      <div className="fin-pager">
        <span>
          共 {total} 单 · 第 {page} / {pageCount} 页
        </span>
        <div>
          <button type="button" className="small" disabled={page <= 1 || busy} onClick={() => void load(page - 1)}>
            上一页
          </button>
          <button
            type="button"
            className="small"
            disabled={page >= pageCount || busy}
            onClick={() => void load(page + 1)}
          >
            下一页
          </button>
        </div>
      </div>
    </section>
  );
}

export default function FinanceCenter({
  onOpenUser,
  initialTab,
  onInitialTabConsumed,
  payees,
}: {
  onOpenUser: (userId: string, tab?: 'orders' | 'ledger') => void;
  initialTab?: Tab | null;
  onInitialTabConsumed?: () => void;
  payees?: ReactNode;
}) {
  const [tab, setTab] = useState<Tab>(initialTab && initialTab !== 'payees' ? initialTab : initialTab === 'payees' && payees ? 'payees' : 'overview');
  const [from, setFrom] = useState(() => rangeForPreset('today').from);
  const [to, setTo] = useState(() => rangeForPreset('today').to);
  const [report, setReport] = useState<Row | null>(null);
  const [accounts, setAccounts] = useState<Row[]>([]);
  const [rake, setRake] = useState({ playerPercent: '', bankerPercent: '' });
  const [trend, setTrend] = useState<Row[]>([]);
  const [trendError, setTrendError] = useState('');
  const [chartMode, setChartMode] = useState<ChartMode>('cash');
  const [pending, setPending] = useState({ deposits: 0, withdrawals: 0, depositCents: '0', withdrawalCents: '0' });
  const [ledger, setLedger] = useState<Row[]>([]);
  const [ledgerDraft, setLedgerDraft] = useState('');
  const [ledgerUid, setLedgerUid] = useState('');
  const [preferPending, setPreferPending] = useState(initialTab === 'deposits' || initialTab === 'withdrawals');

  function loadTrend() {
    return request<{
      items: Row[];
      pendingDeposits: number;
      pendingWithdrawals: number;
      pendingDepositCents?: string;
      pendingWithdrawalCents?: string;
    }>(`/api/admin/finance/trend?from=${from}&to=${to}`).then((result) => {
      setTrend(result.items ?? []);
      setTrendError('');
      setPending({
        deposits: result.pendingDeposits,
        withdrawals: result.pendingWithdrawals,
        depositCents: result.pendingDepositCents ?? '0',
        withdrawalCents: result.pendingWithdrawalCents ?? '0',
      });
    }).catch((error) => {
      setTrend([]);
      setTrendError((error as Error).message || '收支趋势加载失败');
    });
  }

  useEffect(() => {
    if (!initialTab) return;
    if (initialTab === 'payees' && !payees) return;
    setTab(initialTab);
    setPreferPending(initialTab === 'deposits' || initialTab === 'withdrawals');
    onInitialTabConsumed?.();
  }, [initialTab]);

  useEffect(() => {
    void request<Row>('/api/admin/finance/accounts').then((result) => {
      setAccounts(result.accounts ?? []);
      if (result.rake?.playerPercent && result.rake?.bankerPercent) {
        setRake({
          playerPercent: String(result.rake.playerPercent),
          bankerPercent: String(result.rake.bankerPercent),
        });
      }
    });
  }, []);

  useEffect(() => {
    void loadTrend();
  }, [from, to]);

  useEffect(() => {
    if (from !== to) {
      setReport(null);
      return;
    }
    void request<Row>(`/api/admin/finance/daily-report?date=${from}`)
      .then(setReport)
      .catch(() => setReport(null));
  }, [from, to]);

  useEffect(() => {
    if (tab !== 'ledger') return;
    const params = new URLSearchParams({ limit: '200' });
    if (ledgerUid.trim()) params.set('uid', ledgerUid.trim());
    void request<{ items: Row[] }>(`/api/admin/finance/ledger?${params}`).then((result) => setLedger(result.items));
  }, [tab, ledgerUid]);

  const accountByType = new Map(accounts.map((item) => [item.accountType, item]));
  const incomeTotal =
    BigInt(accountByType.get('PLATFORM_RAKE')?.balanceCents ?? 0) +
    BigInt(accountByType.get('PLATFORM_FEES')?.balanceCents ?? 0);
  const groups = [
    { title: '玩家资金', hint: '真人钱包合计，不含虚拟玩家；冻结会在局结或提现完成后解冻', types: ['USER_AVAILABLE', 'USER_FREEZE_BET', 'USER_FREEZE_BANKER', 'USER_FREEZE_WITHDRAW'], tone: 'plain' },
    { title: '收入科目', hint: '平台赚到的钱，只进不出', types: ['PLATFORM_RAKE', 'PLATFORM_FEES'], tone: 'jade' },
    { title: '支出户', hint: '负数表示累计已发出，属正常', types: ['PLATFORM_REBATE', 'PLATFORM_REWARD', 'PLATFORM_PROFIT_POOL'], tone: 'plain' },
    { title: '备付与在途', hint: '与红包 / 充提勾稽，不计入净利', types: ['PLATFORM_RESERVE', 'TNG_TRANSIT', 'ADJUST_CLEARING'], tone: 'blue' },
  ];
  const activePreset = matchRangePreset(from, to);
  const singleDay = from === to;
  const period = useMemo(() => {
    const sum = (key: string) =>
      trend.reduce((total, item) => total + BigInt(String(item[key] ?? 0)), 0n);
    return {
      net: sum('netProfitCents'),
      rake: sum('rakeCents'),
      deposits: sum('depositsCents'),
      withdrawals: sum('withdrawalsCents'),
    };
  }, [trend]);
  const kpis = useMemo(() => {
    return [
      [singleDay ? '当日净利' : '区间净利', money(period.net)],
      ['抽水', money(period.rake)],
      ['充值到账', singleDay && report ? `${money(report.depositsCents)} · ${report.depositsCount} 单` : money(period.deposits)],
      ['提现出账', singleDay && report ? `${money(report.withdrawalsCents)} · ${report.withdrawalsCount} 单` : money(period.withdrawals)],
      ['待审充值', `${pending.deposits} 单 · ${money(pending.depositCents)}`],
      ['待审提现', `${pending.withdrawals} 单 · ${money(pending.withdrawalCents)}`],
    ];
  }, [period, pending, report, singleDay]);

  function applyRange(nextFrom: string, nextTo: string) {
    const today = todayKL();
    const start = nextFrom <= nextTo ? nextFrom : nextTo;
    const end = nextFrom <= nextTo ? nextTo : nextFrom;
    const cappedEnd = end > today ? today : end;
    const cappedStart = start > cappedEnd ? cappedEnd : start;
    const span = Math.floor(
      (new Date(`${cappedEnd}T00:00:00+08:00`).getTime()
        - new Date(`${cappedStart}T00:00:00+08:00`).getTime())
        / 86_400_000,
    ) + 1;
    setFrom(span > 90 ? shiftKL(cappedEnd, -89) : cappedStart);
    setTo(cappedEnd);
  }

  return (
    <div className="fin-page">
      <div className="hub-tabs" role="tablist">
        {(
          [
            ['overview', '资金总览'],
            ['deposits', `充值订单${pending.deposits ? ` · ${pending.deposits} 待审` : ''}`],
            ['withdrawals', `提现订单${pending.withdrawals ? ` · ${pending.withdrawals} 待审` : ''}`],
            ['ledger', '科目流水'],
            ...(payees ? [['payees', '收款账户'] as [Tab, string]] : []),
          ] as Array<[Tab, string]>
        ).map(([id, label]) => (
          <button key={id} type="button" className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <section className="panel fin-hero">
            <div className="panel-title">
              <div>
                <small>{singleDay ? from : `${from} 至 ${to}`}</small>
                <h2>资金总览</h2>
              </div>
              <div className="fin-hero-tools">
                <div className="fin-status-pills">
                  {RANGE_PRESETS.map((preset) => (
                    <button
                      type="button"
                      key={preset.id}
                      className={activePreset === preset.id ? 'active' : ''}
                      onClick={() => {
                        const range = rangeForPreset(preset.id);
                        applyRange(range.from, range.to);
                      }}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <div className="fin-range-pickers">
                  <input
                    type="date"
                    value={from}
                    max={to}
                    onChange={(event) => applyRange(event.target.value, to)}
                  />
                  <span>至</span>
                  <input
                    type="date"
                    value={to}
                    min={from}
                    max={todayKL()}
                    onChange={(event) => applyRange(from, event.target.value)}
                  />
                </div>
                <div className="fin-status-pills">
                  <button type="button" className={chartMode === 'cash' ? 'active' : ''} onClick={() => setChartMode('cash')}>
                    充提
                  </button>
                  <button type="button" className={chartMode === 'pnl' ? 'active' : ''} onClick={() => setChartMode('pnl')}>
                    损益
                  </button>
                </div>
              </div>
            </div>
            <div className="fin-kpis">
              {kpis.map(([label, value]) => (
                <article key={label}>
                  <small>{label}</small>
                  <strong>{value}</strong>
                </article>
              ))}
            </div>
            {trendError ? (
              <p className="fin-quiet">{trendError}</p>
            ) : (
              <FinanceChart items={trend} mode={chartMode} />
            )}
            {trend.length > 1 && (
              <div className="table-wrap fin-trend-table">
                <table>
                  <thead>
                    <tr>
                      <th>日期</th>
                      <th>净利</th>
                      <th>抽水</th>
                      <th>上庄费</th>
                      <th>服务费</th>
                      <th>奖励</th>
                      <th>返水</th>
                      <th>分成</th>
                      <th>充值</th>
                      <th>提现</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trend.map((item) => (
                      <tr key={item.date}>
                        <td>{item.date}</td>
                        <td className={Number(item.netProfitCents) >= 0 ? 'positive' : 'negative'}>{money(item.netProfitCents)}</td>
                        <td>{money(item.rakeCents)}</td>
                        <td>{money(item.seatFeeCents)}</td>
                        <td>{money(item.serviceFeeCents)}</td>
                        <td>{money(item.rewardsCents)}</td>
                        <td>{money(item.rebatesCents)}</td>
                        <td>{money(item.profitShareCents)}</td>
                        <td>{money(item.depositsCents)}</td>
                        <td>{money(item.withdrawalsCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {groups.map((group) => (
            <section className="fin-group" key={group.title}>
              <header>
                <strong>{group.title}</strong>
                <small>{group.hint}</small>
              </header>
              <div className="pp-metrics fin-cards">
                {group.types.map((type) => {
                  const account = accountByType.get(type);
                  if (!account) return null;
                  return (
                    <article key={type} className={`pp-card tone-${group.tone}`}>
                      <small>{ACCOUNT_INFO[type]?.[0] ?? type}</small>
                      <strong>{money(account.balanceCents)}</strong>
                      <em>
                        {type === 'PLATFORM_RAKE' && rake.playerPercent && rake.bankerPercent
                          ? `闲家赢 ${rake.playerPercent}% + 庄家盈利 ${rake.bankerPercent}%，只进不出`
                          : ACCOUNT_INFO[type]?.[1]}
                      </em>
                    </article>
                  );
                })}
                {group.title === '收入科目' && (
                  <article className="pp-card tone-gold">
                    <small>收入合计</small>
                    <strong>{money(incomeTotal)}</strong>
                    <em>抽水收入 + 庄家费用，只进不出</em>
                  </article>
                )}
              </div>
            </section>
          ))}

          {report && (
            <section className="panel">
              <div className="panel-title">
                <div>
                  <small>日报明细</small>
                  <h2>{from} 收支拆解</h2>
                </div>
              </div>
              <div className="fin-report">
                {[
                  {
                    title: '对局',
                    rows: [
                      ['已结算', `${report.settledRounds} 局`],
                      ['取消', `${report.cancelledRounds} 局`],
                      ['投注流水', money(report.betsCents)],
                      ['闲家赔付', money(report.payoutsCents)],
                      ['免赔', money(report.shortfallCents)],
                    ],
                  },
                  {
                    title: '收入',
                    rows: [
                      ['抽水合计', money(report.rakeCents)],
                      [`闲家 ${rake.playerPercent || '—'}%`, money(report.rakePlayerCents ?? 0)],
                      [`庄家 ${rake.bankerPercent || '—'}%`, money(report.rakeBankerCents ?? 0)],
                      ['上庄费', money(report.seatFeeCents)],
                      ['服务费', money(report.serviceFeeCents)],
                      ['代包费（不计净利）', money(report.packetFeeCents)],
                    ],
                  },
                  {
                    title: '支出与进出',
                    rows: [
                      ['奖励', money(report.rewardsPaidCents)],
                      ['返水', money(report.rebatesPaidCents)],
                      ['称桶分成', money(report.profitSharesPaidCents ?? 0)],
                      ['充值', `${money(report.depositsCents)} · ${report.depositsCount} 单`],
                      ['提现', `${money(report.withdrawalsCents)} · ${report.withdrawalsCount} 单`],
                      ['红包在途', `${money(report.packetOutstandingCents)} · ${report.packetOutstandingCount} 包`],
                    ],
                  },
                  {
                    title: '当日净利',
                    net: true,
                    span: true,
                    rows: [['抽水 + 上庄费 + 服务费 − 奖励 − 返水 − 分成', money(report.netProfitCents)]],
                  },
                ].map((section) => (
                  <article key={section.title} className={[section.net ? 'is-net' : '', section.span ? 'is-span' : ''].filter(Boolean).join(' ')}>
                    <h3>{section.title}</h3>
                    <dl>
                      {section.rows.map(([label, value]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </article>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {tab === 'deposits' && (
        <OrderBook
          kind="deposit"
          preferPending={preferPending}
          canReview
          onOpenUser={(userId) => onOpenUser(userId, 'orders')}
          onReviewed={() => void loadTrend()}
        />
      )}
      {tab === 'withdrawals' && (
        <OrderBook
          kind="withdraw"
          preferPending={preferPending}
          canReview
          onOpenUser={(userId) => onOpenUser(userId, 'orders')}
          onReviewed={() => void loadTrend()}
        />
      )}
      {tab === 'payees' && payees}

      {tab === 'ledger' && (
        <section className="panel">
          <div className="panel-title">
            <div>
              <small>LEDGER</small>
              <h2>科目流水</h2>
            </div>
            <form
              className="fin-book-search"
              onSubmit={(event) => {
                event.preventDefault();
                setLedgerUid(ledgerDraft.trim());
              }}
            >
              <input
                value={ledgerDraft}
                onChange={(event) => setLedgerDraft(event.target.value)}
                placeholder="按 UID 筛选，留空看全部"
              />
              <button type="submit" className="small">筛选</button>
            </form>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>用户</th>
                  <th>科目</th>
                  <th>方向</th>
                  <th>金额</th>
                  <th>业务</th>
                  <th>关联局</th>
                  <th>备注</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((item) => (
                  <tr key={item.id}>
                    <td>{new Date(item.createdAt).toLocaleString('zh-MY')}</td>
                    <td>
                      {item.user ? (
                        <button type="button" className="linkish" onClick={() => onOpenUser(item.user.id, 'ledger')}>
                          {item.user.nickname || item.user.uid}
                          <small>UID {item.user.uid}</small>
                        </button>
                      ) : (
                        '平台科目'
                      )}
                    </td>
                    <td>{ACCOUNT_INFO[item.accountType]?.[0] ?? item.accountType}</td>
                    <td className={item.direction === 'CREDIT' ? 'positive' : 'negative'}>
                      {item.direction === 'CREDIT' ? '收入' : '支出'}
                    </td>
                    <td>{money(item.amountCents)}</td>
                    <td>{REF_LABELS[item.refType] ?? item.refType}</td>
                    <td>{item.roundId?.slice(-8) ?? '—'}</td>
                    <td>{item.memo ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ledger.length === 0 && <p className="fin-quiet">没有匹配的流水</p>}
          </div>
        </section>
      )}
    </div>
  );
}
