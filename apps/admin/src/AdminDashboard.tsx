import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { request, rm } from './api';

type Page =
  | 'dashboard' | 'gameOps' | 'virtualPlayers' | 'users' | 'kyc' | 'payments' | 'rooms' | 'rounds'
  | 'tng' | 'finance' | 'profitPool' | 'rewards' | 'rebates' | 'leaderboards' | 'messaging'
  | 'support' | 'config' | 'bots' | 'admins' | 'audit';

type MetricCompare = {
  direction: 'up' | 'down' | 'flat' | 'new';
  percent: number | null;
  label: string;
};

type TodoAging = {
  depositsSeconds?: number | null;
  withdrawalsSeconds?: number | null;
  kycSeconds?: number | null;
  withdrawAccountsSeconds?: number | null;
  supportSeconds?: number | null;
};

type RoundLiveStats = {
  headline: string | null;
  detail: string | null;
};

type RoomLive = {
  title: string;
  chatMuteLabel?: string;
  chatMuted: boolean;
  status: string;
  statusLabel: string;
  startModeLabel: string;
  packetChannelLabel?: string;
  onlineCount: number;
  phase: string | null;
  phaseLabel: string;
  seqNo: number | null;
  countdownSeconds: number | null;
  phaseWaitingSeconds?: number | null;
  phaseWaitingLabel?: string | null;
  sendingPacketStuck?: boolean;
  schedulerLastError?: string | null;
  roundStats?: RoundLiveStats | null;
};

type DashboardData = {
  asOf?: string;
  pendingKyc?: number;
  pendingDeposits?: number;
  pendingDepositCents?: string;
  pendingWithdrawals?: number;
  pendingWithdrawCents?: string;
  pendingWithdrawAccounts?: number;
  unreadSupport?: number;
  packetTransitCents?: string;
  todaySettlements?: number;
  todayBetsCents?: string;
  todayRakeCents?: string;
  todayCancelled?: number;
  todayNewUsers?: number;
  todayPushFailures?: number;
  reconcileAnomalies?: number;
  claimReviewRounds?: number;
  pendingClaimInbox?: number;
  cancelledAlert?: boolean;
  compare?: {
    settlements?: MetricCompare;
    bets?: MetricCompare;
    rake?: MetricCompare;
    cancelled?: MetricCompare;
  };
  todoAging?: TodoAging;
  rebateYesterday?: {
    date: string;
    status: 'empty' | 'settled' | 'pending';
    label: string;
  };
  roomLive?: RoomLive | null;
  profitPool?: {
    ready: boolean;
    label: string;
    detail: string;
    pendingBatchCount?: number;
  };
};

function formatCountdown(seconds: number | null | undefined) {
  if (seconds == null) return null;
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  if (minutes <= 0) return `${rest}秒`;
  return `${minutes}分${String(rest).padStart(2, '0')}秒`;
}

function formatWaitLabel(seconds: number | null | undefined) {
  if (seconds == null) return null;
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 60) return `${safe}秒`;
  if (safe < 3600) return `${Math.floor(safe / 60)}分钟`;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  return minutes > 0 ? `${hours}小时${minutes}分` : `${hours}小时`;
}

function DashMetric({
  label,
  value,
  hint,
  extra,
  tone = 'gold',
  level = 0,
  alert = false,
  onClick,
}: {
  label: string;
  value: string | number;
  hint: string;
  extra?: ReactNode;
  tone?: string;
  level?: number;
  alert?: boolean;
  onClick?: () => void;
}) {
  const clickable = typeof onClick === 'function';
  return (
    <button
      type="button"
      className={`dash-metric ${tone}${alert ? ' alert' : ''}${clickable ? ' clickable' : ''}`}
      onClick={onClick}
      disabled={!clickable}
    >
      <div className="dash-metric-top">
        <span>{label}</span>
        {clickable && <em>查看 ›</em>}
      </div>
      <strong>{value}</strong>
      {extra}
      <p>{hint}</p>
      <div className="dash-meter" aria-hidden>
        <i style={{ width: `${Math.max(6, Math.min(100, level))}%` }} />
      </div>
    </button>
  );
}

function CompareHint({ compare }: { compare?: MetricCompare }) {
  if (!compare) return null;
  return <small className={`dash-compare ${compare.direction}`}>{compare.label}</small>;
}

function AgingHint({ seconds }: { seconds?: number | null }) {
  const label = formatWaitLabel(seconds);
  if (!label) return null;
  return <small className="dash-aging">最久已等 {label}</small>;
}

const AdminDashboard = memo(function AdminDashboard({
  allowed,
  onNavigate,
  onOpenFinance,
}: {
  allowed: Page[];
  onNavigate: (page: Page) => void;
  onOpenFinance: (tab: 'deposits' | 'withdrawals') => void;
}) {
  const [data, setData] = useState<DashboardData | null>(null);
  const dataRef = useRef<DashboardData | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    function accept(next: DashboardData) {
      const encoded = JSON.stringify(next);
      if (encoded === JSON.stringify(dataRef.current)) return;
      dataRef.current = next;
      setData(next);
    }
    function load() {
      if (document.hidden) return;
      request<DashboardData>('/api/admin/dashboard').then(accept).catch(() => {
        if (!dataRef.current) setData(null);
      });
    }
    load();
    const timer = window.setInterval(load, 30_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisible);
    const clock = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(clock);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  function go(page: Page) {
    if (allowed.includes(page)) onNavigate(page);
  }

  const pendingKyc = Number(data?.pendingKyc ?? 0);
  const pendingDeposits = Number(data?.pendingDeposits ?? 0);
  const pendingWithdrawals = Number(data?.pendingWithdrawals ?? 0);
  const pendingWithdrawAccounts = Number(data?.pendingWithdrawAccounts ?? 0);
  const unreadSupport = Number(data?.unreadSupport ?? 0);
  const todaySettlements = Number(data?.todaySettlements ?? 0);
  const todayCancelled = Number(data?.todayCancelled ?? 0);
  const todayNewUsers = Number(data?.todayNewUsers ?? 0);
  const todayPushFailures = Number(data?.todayPushFailures ?? 0);
  const reconcileAnomalies = Number(data?.reconcileAnomalies ?? 0);
  const claimReviewRounds = Number(data?.claimReviewRounds ?? 0);
  const pendingClaimInbox = Number(data?.pendingClaimInbox ?? 0);
  const transitCents = BigInt(data?.packetTransitCents ?? 0);
  const betsCents = BigInt(data?.todayBetsCents ?? 0);
  const rakeCents = BigInt(data?.todayRakeCents ?? 0);
  const depositCents = BigInt(data?.pendingDepositCents ?? 0);
  const withdrawCents = BigInt(data?.pendingWithdrawCents ?? 0);
  const room = data?.roomLive ?? null;
  const profitPool = data?.profitPool;
  const rebateYesterday = data?.rebateYesterday;
  const todoAging = data?.todoAging ?? {};
  const maxTodo = Math.max(
    pendingKyc,
    pendingWithdrawAccounts,
    pendingDeposits,
    pendingWithdrawals,
    unreadSupport,
    1,
  );
  const maxMoney = Number(betsCents > rakeCents ? betsCents : rakeCents || 1n);
  const todoTotal =
    pendingKyc +
    pendingWithdrawAccounts +
    pendingDeposits +
    pendingWithdrawals +
    unreadSupport;
  const fetchedAt = data?.asOf ? Date.parse(data.asOf) : NaN;
  const liveCountdown =
    room?.countdownSeconds == null || Number.isNaN(fetchedAt)
      ? room?.countdownSeconds
      : Math.max(0, room.countdownSeconds - Math.floor((nowMs - fetchedAt) / 1000));
  const livePhaseWaiting =
    room?.phaseWaitingSeconds == null || Number.isNaN(fetchedAt)
      ? room?.phaseWaitingSeconds
      : Math.max(0, room.phaseWaitingSeconds + Math.floor((nowMs - fetchedAt) / 1000));
  const countdown = formatCountdown(liveCountdown);
  const phaseWaiting = formatWaitLabel(livePhaseWaiting);
  const roundStats = room?.roundStats;
  const profitPoolPending = Number(profitPool?.pendingBatchCount ?? 0);

  return (
    <div className="dash-page">
      <section className={`dash-live panel${room?.sendingPacketStuck || room?.schedulerLastError ? ' alert' : ''}`}>
        <div className="dash-live-main">
          <small>牌桌实况</small>
          <strong>{room?.title ?? '至尊牛牛互动群'}</strong>
          <div className="dash-live-chips">
            <span className={`dash-chip ${room?.status === 'ACTIVE' ? 'on' : 'off'}`}>
              {room?.statusLabel ?? '入口状态同步中'}
            </span>
            <span className="dash-chip">{room?.startModeLabel ?? '开局模式同步中'}</span>
            <span className={`dash-chip ${room?.chatMuted ? 'warn' : ''}`}>
              {room?.chatMuteLabel ?? (room?.chatMuted ? '运营全群禁言' : '运营未封群')}
            </span>
            {room?.packetChannelLabel && <span className="dash-chip">{room.packetChannelLabel}</span>}
            {phaseWaiting && (
              <span className={`dash-chip${room?.sendingPacketStuck ? ' warn' : ''}`}>
                本阶段已 {phaseWaiting}
              </span>
            )}
          </div>
          {roundStats?.headline && (
            <p className="dash-live-stats">
              <strong>{roundStats.headline}</strong>
              {roundStats.detail ? ` · ${roundStats.detail}` : ''}
            </p>
          )}
          {room?.schedulerLastError && (
            <p className="dash-scheduler-error">调度失败：{room.schedulerLastError}</p>
          )}
          <p>
            {!data
              ? '审核、流水与牌桌状态加载中'
              : todoTotal > 0
                ? `${todoTotal} 项待办 · 已结算 ${todaySettlements} 局 · 今日新注册 ${todayNewUsers}`
                : `暂无待办 · 已结算 ${todaySettlements} 局 · 今日新注册 ${todayNewUsers}`}
          </p>
        </div>
        <button
          type="button"
          className="dash-live-side"
          onClick={() => go('gameOps')}
          disabled={!allowed.includes('gameOps')}
        >
          <span>当前阶段</span>
          <b>{data ? room?.phaseLabel ?? '等待开局' : '—'}</b>
          <em>
            {data
              ? [
                  room?.seqNo != null ? `第 ${room.seqNo} 局` : null,
                  countdown,
                  `在线 ${room?.onlineCount ?? 0}`,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : '同步中'}
          </em>
        </button>
      </section>

      <section className="dash-section">
        <div className="dash-section-head">
          <h2>待办处理</h2>
          <span>充提同时看笔数和金额</span>
        </div>
        <div className="dash-metrics dash-metrics-5">
          <DashMetric
            label="待审充值"
            value={data ? pendingDeposits : '—'}
            extra={
              data ? (
                <>
                  <small className="dash-metric-money">RM {rm(depositCents)}</small>
                  <AgingHint seconds={todoAging.depositsSeconds} />
                </>
              ) : null
            }
            hint="人工确认到账"
            tone="jade"
            alert={pendingDeposits > 0}
            level={(pendingDeposits / maxTodo) * 100}
            onClick={allowed.includes('finance') ? () => onOpenFinance('deposits') : undefined}
          />
          <DashMetric
            label="待审提现"
            value={data ? pendingWithdrawals : '—'}
            extra={
              data ? (
                <>
                  <small className="dash-metric-money">RM {rm(withdrawCents)}</small>
                  <AgingHint seconds={todoAging.withdrawalsSeconds} />
                </>
              ) : null
            }
            hint="待出款工单"
            tone="jade"
            alert={pendingWithdrawals > 0}
            level={(pendingWithdrawals / maxTodo) * 100}
            onClick={allowed.includes('finance') ? () => onOpenFinance('withdrawals') : undefined}
          />
          <DashMetric
            label="待审实名"
            value={data ? pendingKyc : '—'}
            extra={<AgingHint seconds={todoAging.kycSeconds} />}
            hint="身份资料待核"
            tone="gold"
            alert={pendingKyc > 0}
            level={(pendingKyc / maxTodo) * 100}
            onClick={allowed.includes('kyc') ? () => go('kyc') : undefined}
          />
          <DashMetric
            label="待审提款账户"
            value={data ? pendingWithdrawAccounts : '—'}
            extra={<AgingHint seconds={todoAging.withdrawAccountsSeconds} />}
            hint="银行卡 / 电子钱包"
            tone="gold"
            alert={pendingWithdrawAccounts > 0}
            level={(pendingWithdrawAccounts / maxTodo) * 100}
            onClick={allowed.includes('kyc') ? () => go('kyc') : undefined}
          />
          <DashMetric
            label="未读客服"
            value={data ? unreadSupport : '—'}
            extra={<AgingHint seconds={todoAging.supportSeconds} />}
            hint="玩家待回复会话"
            tone={unreadSupport ? 'red' : 'gold'}
            alert={unreadSupport > 0}
            level={(unreadSupport / maxTodo) * 100}
            onClick={allowed.includes('support') ? () => go('support') : undefined}
          />
        </div>
      </section>

      <section className="dash-section">
        <div className="dash-section-head">
          <h2>今日经营</h2>
          <span>马来日对照昨日</span>
        </div>
        <div className="dash-metrics dash-metrics-4">
          <DashMetric
            label="已结算局数"
            value={data ? todaySettlements : '—'}
            extra={<CompareHint compare={data?.compare?.settlements} />}
            hint="今日完结牌局"
            tone="gold"
            level={Math.min(100, todaySettlements * 8)}
            onClick={allowed.includes('gameOps') ? () => go('gameOps') : undefined}
          />
          <DashMetric
            label="投注流水"
            value={data ? `RM ${rm(betsCents)}` : '—'}
            extra={<CompareHint compare={data?.compare?.bets} />}
            hint="已结算注单合计"
            tone="jade"
            level={maxMoney ? Number((betsCents * 100n) / BigInt(maxMoney)) : 0}
            onClick={allowed.includes('finance') ? () => go('finance') : allowed.includes('gameOps') ? () => go('gameOps') : undefined}
          />
          <DashMetric
            label="平台抽水"
            value={data ? `RM ${rm(rakeCents)}` : '—'}
            extra={<CompareHint compare={data?.compare?.rake} />}
            hint="赢方抽水入账"
            tone="gold"
            level={maxMoney ? Number((rakeCents * 100n) / BigInt(maxMoney)) : 0}
            onClick={allowed.includes('finance') ? () => go('finance') : allowed.includes('rebates') ? () => go('rebates') : undefined}
          />
          <DashMetric
            label="取消局"
            value={data ? todayCancelled : '—'}
            extra={<CompareHint compare={data?.compare?.cancelled} />}
            hint="今日取消不占号"
            tone={data?.cancelledAlert ? 'red' : 'jade'}
            alert={Boolean(data?.cancelledAlert)}
            level={Math.min(100, todayCancelled * 20)}
            onClick={allowed.includes('gameOps') ? () => go('gameOps') : undefined}
          />
        </div>
      </section>

      <section className="panel dash-risk">
        <div className="dash-section-head compact">
          <h2>风险资金</h2>
          <span>在途、核销与利润池</span>
        </div>
        <div className="dash-risk-grid">
          <button type="button" className="dash-risk-row" onClick={() => go('tng')} disabled={!allowed.includes('tng')}>
            <div>
              <strong>TNG 在途金额</strong>
              <small>红包台账待回笼</small>
            </div>
            <b>RM {data ? rm(transitCents) : '—'}</b>
          </button>
          <button
            type="button"
            className={`dash-risk-row${reconcileAnomalies ? ' alert' : ''}`}
            onClick={() => go('tng')}
            disabled={!allowed.includes('tng')}
          >
            <div>
              <strong>待核销红包</strong>
              <small>领取与退回未对平</small>
            </div>
            <b>{data ? reconcileAnomalies : '—'}</b>
          </button>
          <button
            type="button"
            className={`dash-risk-row${pendingClaimInbox ? ' alert' : ''}`}
            onClick={() => go('tng')}
            disabled={!allowed.includes('tng')}
          >
            <div>
              <strong>未匹配领取</strong>
              <small>同名 / 姓名对不上待指认</small>
            </div>
            <b>{data ? pendingClaimInbox : '—'}</b>
          </button>
          <button
            type="button"
            className={`dash-risk-row${claimReviewRounds ? ' alert' : ''}`}
            onClick={() => go('gameOps')}
            disabled={!allowed.includes('gameOps')}
          >
            <div>
              <strong>认额复核</strong>
              <small>超时未认额待处理</small>
            </div>
            <b>{data ? claimReviewRounds : '—'}</b>
          </button>
          <button
            type="button"
            className={`dash-risk-row${profitPoolPending ? ' alert' : profitPool && !profitPool.ready ? ' wait' : ''}`}
            onClick={() => go('profitPool')}
            disabled={!allowed.includes('profitPool')}
          >
            <div>
              <strong>利润池批次</strong>
              <small>{profitPool?.detail ?? '按马来日下午2点后查看'}</small>
            </div>
            <b>{data ? profitPool?.label ?? '—' : '—'}</b>
          </button>
          <button
            type="button"
            className={`dash-risk-row${rebateYesterday?.status === 'pending' ? ' alert' : ''}`}
            onClick={() => go('rebates')}
            disabled={!allowed.includes('rebates')}
          >
            <div>
              <strong>昨日返水</strong>
              <small>{rebateYesterday?.date ? `业务日 ${rebateYesterday.date}` : '马来日昨日'}</small>
            </div>
            <b>{data ? rebateYesterday?.label ?? '—' : '—'}</b>
          </button>
        </div>
        {todayPushFailures > 0 && (
          <button
            type="button"
            className="dash-push-note"
            onClick={() => go('messaging')}
            disabled={!allowed.includes('messaging')}
          >
            今日推送失败 {todayPushFailures} 条 · 去消息中心
          </button>
        )}
      </section>
    </div>
  );
});

export default AdminDashboard;
