import { useEffect, useRef, useState, type ReactNode } from 'react';
import { del, downloadAuthorized, hasToken, logout, openProtectedUpload, patch, post, put, request, rm, setAdminToken } from './api';
import GameConfigEditor from './GameConfigEditor';
import GameOperationsCenter from './GameOperationsCenter';
import { GameLeaderboardsAdmin, GameRewardsAdmin } from './GameScopedOperations';
import VirtualPlayers from './VirtualPlayers';

const DEFAULT_GAME_CODE = 'SUPREME_NIUNIU';

type Admin = { id: string; username: string; role: 'SUPER' | 'OPERATOR' | 'REVIEWER' | 'FINANCE' };
type Page =
  | 'dashboard' | 'gameOps' | 'virtualPlayers' | 'users' | 'kyc' | 'deposits' | 'withdrawals' | 'rooms' | 'rounds'
  | 'tng' | 'finance' | 'rewards' | 'rebates' | 'leaderboards' | 'messaging'
  | 'support' | 'config' | 'bots' | 'admins' | 'audit';
type Row = Record<string, any>;

const pageTitles: Record<Page, [string, string]> = {
  dashboard: ['运营总览', '实时掌握审核、资金、牌局与风险状态'],
  gameOps: ['游戏运营中心', '游戏目录 → 互动群运营台（小助手 / 牌局 / TNG）'],
  virtualPlayers: ['虚拟玩家', '互动群假人：能力开关、资金、自动参与与代操作'],
  users: ['用户中心', '点选用户即可调账、改资料、看流水与牌局'],
  kyc: ['实名审核', '核对 TNG 姓名与提款银行资料'],
  deposits: ['充值管理', '充值工单与收款账户统一处理'],
  withdrawals: ['提现管理', '提现工单与收款账户审核'],
  rooms: ['游戏入口管理', '一款游戏对应一个互动群；当前仅支持至尊牛牛'],
  rounds: ['对局控制台', '竞标、下注、发包、认额与结算'],
  tng: ['TNG 红包台账', '发包账号、在途金额与认额差异'],
  finance: ['钱包财务', '平台科目、全量流水与人工调账'],
  rewards: ['每日奖励', '棋牌、庄家与特别奖励配置'],
  rebates: ['推广返水', '三级有效流水与日结佣金'],
  leaderboards: ['排行榜', '积分、棋牌、打桩三榜快照'],
  messaging: ['消息中心', '推送、公告与系统通知统一管理'],
  support: ['客服会话', '处理设备、资金与牌局咨询'],
  config: ['游戏配置', '倍数、费用、倒计时与动态范围'],
  bots: ['Bot 管理', '多机器人、默认入口与启停路由'],
  admins: ['管理员与权限', '账号、角色、状态与密码安全'],
  audit: ['审计日志', '追踪所有高风险后台操作'],
};

const roleMenus: Record<Admin['role'], Page[]> = {
  SUPER: ['dashboard', 'users', 'kyc', 'deposits', 'withdrawals', 'gameOps', 'tng', 'finance', 'rebates', 'messaging', 'support', 'bots', 'admins', 'audit'],
  OPERATOR: ['dashboard', 'users', 'kyc', 'deposits', 'withdrawals', 'gameOps', 'tng', 'messaging', 'support'],
  REVIEWER: ['dashboard', 'users', 'kyc', 'withdrawals', 'support'],
  FINANCE: ['dashboard', 'users', 'deposits', 'withdrawals', 'gameOps', 'tng', 'finance', 'rebates'],
};

const roleLabels: Record<Admin['role'], string> = {
  SUPER: '超级管理员',
  OPERATOR: '运营',
  REVIEWER: '审核',
  FINANCE: '财务',
};

const badgeLabels: Record<string, string> = {
  PENDING: '待处理', APPROVED: '已通过', COMPLETED: '已完成', REJECTED: '已驳回',
  ACTIVE: '启用', DISABLED: '停用', PAUSED: '已暂停', FINISHED: '已结算', CANCELLED: '已取消',
  SENT: '已发送', FAILED: '失败', PARTIAL: '部分成功', PROCESSING: '发送中',
  CLAIM_EXPIRED: '认额复核', CLAIMING: '抢包中', WAITING: '等待开局', BANKER_BID: '竞标中',
  BETTING: '下注中', SENDING_PACKET: '待发包', SETTLING: '结算中', BANNED: '已封禁',
  UNBOUND: '未绑定', BOUND: '已绑定', MISSING: '未认额', PUBLISHED: '已发布', ARCHIVED: '已下架',
  DRAFT: '草稿', ALL: '全部用户', KYC_APPROVED: '已实名', UIDS: '指定 UID',
};

const groups: Array<[string, Page[]]> = [
  ['总览', ['dashboard']],
  ['会员', ['users', 'kyc']],
  ['资金', ['deposits', 'withdrawals', 'finance', 'tng']],
  ['游戏', ['gameOps']],
  ['增长', ['rebates', 'messaging', 'support']],
  ['系统', ['bots', 'admins', 'audit']],
];

const icons: Record<Page, string> = {
  dashboard: '⌁', gameOps: '◈', virtualPlayers: '♟', users: '◎', kyc: '◇', deposits: '＋', withdrawals: '↗', rooms: '▦',
  rounds: '◉', tng: '◫', finance: '¥', rewards: '✦', rebates: '%', leaderboards: '♛',
  messaging: '✉', support: '◌', config: '⚙', bots: '◆', admins: '♙', audit: '≡',
};

function storedAdmin(): Admin | null {
  try { return JSON.parse(localStorage.getItem('admin_profile') ?? 'null'); } catch { return null; }
}

export default function App() {
  const [admin, setAdmin] = useState<Admin | null>(hasToken() ? storedAdmin() : null);
  if (!admin) return <Login onLogin={setAdmin} />;
  return <Shell admin={admin} />;
}

function Login({ onLogin }: { onLogin: (admin: Admin) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true); setError('');
    try {
      const result = await request<{ token: string; admin: Admin }>('/api/admin/login', {
        method: 'POST', body: JSON.stringify({ username, password }),
      });
      setAdminToken(result.token);
      localStorage.setItem('admin_profile', JSON.stringify(result.admin));
      onLogin(result.admin);
    } catch { setError('账号或密码错误，请重新输入'); }
    finally { setBusy(false); }
  }

  return (
    <main className="login-screen">
      <section className="login-panel">
        <header className="login-header">
          <img src="/logo.png" alt="" className="login-logo" />
          <div>
            <h1>至尊牛牛</h1>
            <p>运营后台</p>
          </div>
        </header>

        <label htmlFor="admin-username">账号</label>
        <input
          id="admin-username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          placeholder="管理员账号"
        />
        <label htmlFor="admin-password">密码</label>
        <input
          id="admin-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && void submit()}
          type="password"
          autoComplete="current-password"
          placeholder="登录密码"
        />
        {error && <div className="form-error">{error}</div>}
        <button
          type="button"
          className="primary login-submit"
          disabled={busy || !username || !password}
          onClick={() => void submit()}
        >
          {busy ? '登录中…' : '登录'}
        </button>
      </section>
    </main>
  );
}

type SupportToastItem = {
  id: string;
  userId: string;
  nickname: string;
  preview: string;
  unread: number;
};

function Shell({ admin }: { admin: Admin }) {
  const allowed = roleMenus[admin.role] ?? roleMenus.OPERATOR;
  const [page, setPage] = useState<Page>(() => allowed[0] ?? 'dashboard');
  const [collapsed, setCollapsed] = useState(false);
  const [supportFocusUserId, setSupportFocusUserId] = useState<string | null>(null);
  const [supportToasts, setSupportToasts] = useState<SupportToastItem[]>([]);
  const [supportUnreadTotal, setSupportUnreadTotal] = useState(0);
  const supportBaseline = useRef<Map<string, number> | null>(null);
  const current = allowed.includes(page) ? page : allowed[0] ?? 'dashboard';
  const [title, subtitle] = pageTitles[current];
  const canSupport = allowed.includes('support');

  function go(target: Page) {
    if (allowed.includes(target)) setPage(target);
  }

  function openSupportThread(userId: string) {
    if (!canSupport) return;
    setSupportFocusUserId(userId);
    setPage('support');
    setSupportToasts((items) => items.filter((item) => item.userId !== userId));
  }

  useEffect(() => {
    if (!canSupport) return;
    let cancelled = false;

    async function poll() {
      try {
        const result = await request<{ items: Row[] }>('/api/admin/support/threads');
        if (cancelled) return;
        const nextMap = new Map<string, number>();
        let totalUnread = 0;
        for (const thread of result.items) {
          const unread = Number(thread.unread ?? 0);
          nextMap.set(thread.userId, unread);
          totalUnread += unread;
        }
        setSupportUnreadTotal(totalUnread);
        if (!supportBaseline.current) {
          supportBaseline.current = nextMap;
          return;
        }
        const prev = supportBaseline.current;
        const fresh: SupportToastItem[] = [];
        for (const thread of result.items) {
          const unread = Number(thread.unread ?? 0);
          const before = prev.get(thread.userId) ?? 0;
          if (unread > before) {
            fresh.push({
              id: `${thread.userId}-${thread.id ?? thread.createdAt ?? Date.now()}`,
              userId: thread.userId,
              nickname: thread.user?.nickname ?? '玩家',
              preview: String(thread.content ?? '[新消息]').slice(0, 48),
              unread,
            });
          }
        }
        supportBaseline.current = nextMap;
        if (fresh.length) {
          setSupportToasts((items) => {
            const next = [...fresh, ...items].slice(0, 4);
            for (const item of fresh) {
              window.setTimeout(() => {
                setSupportToasts((current) => current.filter((row) => row.id !== item.id));
              }, 18_000);
            }
            return next;
          });
        }
      } catch {
        // ignore polling errors
      }
    }

    void poll();
    const timer = window.setInterval(() => void poll(), 6_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [canSupport]);

  return (
    <div className={`admin-shell ${collapsed ? 'collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-brand"><span className="brand-mark"><img src="/logo.png" alt="" /></span><div><strong>至尊牛牛</strong><small>运营后台</small></div></div>
        <nav>
          {groups.map(([group, pages]) => {
            const visible = pages.filter((item) => allowed.includes(item));
            if (!visible.length) return null;
            return <section key={group}><span>{group}</span>{visible.map((item) => (
              <button key={item} className={current === item ? 'active' : ''} onClick={() => setPage(item)}>
                <i>{icons[item]}</i>
                <em>{pageTitles[item][0]}</em>
                {item === 'support' && supportUnreadTotal > 0 ? (
                  <b className="nav-unread">{supportUnreadTotal > 99 ? '99+' : supportUnreadTotal}</b>
                ) : null}
              </button>
            ))}</section>;
          })}
        </nav>
        <div className="sidebar-user">
          <div>{admin.username[0]?.toUpperCase() ?? '管'}</div>
          <span><strong>{admin.username}</strong><small>{roleLabels[admin.role] ?? admin.role}</small></span>
          <button type="button" title="退出登录" aria-label="退出登录" onClick={logout}>↪</button>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <button className="collapse" onClick={() => setCollapsed((value) => !value)}>☰</button>
          <div><h1>{title}</h1><p>{subtitle}</p></div>
          <div className="top-actions"><span className="system-live"><i /> 系统在线</span><time>{new Date().toLocaleDateString('zh-MY')}</time></div>
        </header>
        <div className="content">
          {current === 'dashboard' && <Dashboard allowed={allowed} onNavigate={go} />}
          {current === 'gameOps' && <GameOperationsCenter admin={admin} />}
          {current === 'virtualPlayers' && <VirtualPlayers />}
          {current === 'users' && <Users role={admin.role} />}
          {current === 'kyc' && <KycReview />}
          {current === 'deposits' && <DepositsHub role={admin.role} />}
          {current === 'withdrawals' && <WithdrawalsHub role={admin.role} />}
          {current === 'rooms' && <Rooms />}
          {current === 'rounds' && <Rounds canReconcile={admin.role === 'SUPER' || admin.role === 'FINANCE'} />}
          {current === 'tng' && <Tng canReconcile={admin.role === 'SUPER' || admin.role === 'FINANCE'} />}
          {current === 'finance' && <Finance />}
          {current === 'rewards' && <RewardsAdmin />}
          {current === 'rebates' && <Rebates />}
          {current === 'leaderboards' && <LeaderboardsAdmin />}
          {current === 'messaging' && <MessagingHub />}
          {current === 'support' && (
            <Support
              focusUserId={supportFocusUserId}
              onFocusConsumed={() => setSupportFocusUserId(null)}
            />
          )}
          {current === 'config' && <ConfigEditor />}
          {current === 'bots' && <Bots />}
          {current === 'admins' && <Admins />}
          {current === 'audit' && <Audit />}
        </div>
      </main>

      {supportToasts.length > 0 && (
        <div className="support-toast-stack" aria-live="polite">
          {supportToasts.map((toast) => (
            <div className="support-toast" key={toast.id}>
              <button
                type="button"
                className="support-toast-body"
                onClick={() => openSupportThread(toast.userId)}
              >
                <small>客服新消息{toast.unread > 1 ? ` · ${toast.unread}` : ''}</small>
                <strong>{toast.nickname}</strong>
                <span>{toast.preview}</span>
                <em>点击回复 ›</em>
              </button>
              <button
                type="button"
                className="support-toast-close"
                aria-label="关闭通知"
                onClick={() => setSupportToasts((items) => items.filter((item) => item.id !== toast.id))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, hint, tone = 'gold' }: { label: string; value: string | number; hint: string; tone?: string }) {
  return <article className={`stat-card ${tone}`}><div><span>{label}</span><strong>{value}</strong></div><i>{icons.dashboard}</i><p>{hint}</p></article>;
}
function Badge({ value }: { value: string }) {
  return <span className={`badge ${value.toLowerCase()}`}>{badgeLabels[value] ?? value}</span>;
}
function Empty({ text = '暂无数据' }: { text?: string }) { return <div className="empty"><b>◇</b><span>{text}</span></div>; }

function HubTabs({
  tabs,
  children,
}: {
  tabs: Array<{ id: string; label: string }>;
  children: (tab: string) => ReactNode;
}) {
  const [tab, setTab] = useState(tabs[0]?.id ?? '');
  const active = tabs.some((item) => item.id === tab) ? tab : tabs[0]?.id ?? '';
  return (
    <div className="hub-page">
      <div className="hub-tabs" role="tablist">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active === item.id}
            className={active === item.id ? 'active' : ''}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="hub-body">{children(active)}</div>
    </div>
  );
}

function DepositsHub({ role }: { role: Admin['role'] }) {
  const canOrders = role === 'SUPER' || role === 'FINANCE';
  const canPayees = role === 'SUPER' || role === 'OPERATOR' || role === 'FINANCE';
  const tabs = [
    ...(canOrders ? [{ id: 'orders', label: '充值工单' }] : []),
    ...(canPayees ? [{ id: 'payees', label: '收款账户' }] : []),
  ];
  return (
    <HubTabs tabs={tabs}>
      {(tab) => (tab === 'payees' ? <DepositPayees /> : <Orders type="deposit" />)}
    </HubTabs>
  );
}

function WithdrawalsHub({ role }: { role: Admin['role'] }) {
  const canOrders = role === 'SUPER' || role === 'FINANCE';
  const tabs = [
    ...(canOrders ? [{ id: 'orders', label: '提现工单' }] : []),
    { id: 'accounts', label: '账户审核' },
  ];
  return (
    <HubTabs tabs={tabs}>
      {(tab) => (tab === 'orders' ? <Orders type="withdraw" /> : <WithdrawAccountReview />)}
    </HubTabs>
  );
}

function MessagingHub() {
  return (
    <HubTabs
      tabs={[
        { id: 'push', label: '推送中心' },
        { id: 'announcements', label: '公告管理' },
        { id: 'notices', label: '系统通知' },
      ]}
    >
      {(tab) => {
        if (tab === 'announcements') return <Announcements />;
        if (tab === 'notices') return <SystemNoticesAdmin />;
        return <PushCenter />;
      }}
    </HubTabs>
  );
}
function ErrorBox({ error }: { error: string }) { return error ? <div className="error-box">{error}</div> : null; }
function toCents(value: string) {
  const cleaned = value.trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) throw new Error('金额格式无效，请输入如 12.50');
  const negative = cleaned.startsWith('-');
  const [integer, decimal = ''] = (negative ? cleaned.slice(1) : cleaned).split('.');
  const cents = BigInt(integer || '0') * 100n + BigInt((decimal + '00').slice(0, 2));
  return String(negative ? -cents : cents);
}

function DashMetric({
  label,
  value,
  hint,
  tone = 'gold',
  level = 0,
  alert = false,
  onClick,
}: {
  label: string;
  value: string | number;
  hint: string;
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
      <p>{hint}</p>
      <div className="dash-meter" aria-hidden>
        <i style={{ width: `${Math.max(6, Math.min(100, level))}%` }} />
      </div>
    </button>
  );
}

function Dashboard({
  allowed,
  onNavigate,
}: {
  allowed: Page[];
  onNavigate: (page: Page) => void;
}) {
  const [data, setData] = useState<Row | null>(null);
  const [checks, setChecks] = useState<boolean[]>(() => {
    try {
      const raw = localStorage.getItem('admin_dashboard_checks');
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed)
        ? parsed.map(Boolean).slice(0, 4).concat([false, false, false, false]).slice(0, 4)
        : [false, false, false, false];
    } catch {
      return [false, false, false, false];
    }
  });

  useEffect(() => {
    request<Row>('/api/admin/dashboard').then(setData).catch(() => setData(null));
    const timer = window.setInterval(() => {
      request<Row>('/api/admin/dashboard').then(setData).catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    localStorage.setItem('admin_dashboard_checks', JSON.stringify(checks));
  }, [checks]);

  function go(page: Page) {
    if (allowed.includes(page)) onNavigate(page);
  }

  const pendingKyc = Number(data?.pendingKyc ?? 0);
  const pendingDeposits = Number(data?.pendingDeposits ?? 0);
  const pendingWithdrawals = Number(data?.pendingWithdrawals ?? 0);
  const activeRounds = Number(data?.activeRounds ?? 0);
  const todaySettlements = Number(data?.todaySettlements ?? 0);
  const todayPushFailures = Number(data?.todayPushFailures ?? 0);
  const reconcileAnomalies = Number(data?.reconcileAnomalies ?? 0);
  const transitCents = BigInt(data?.packetTransitCents ?? 0);
  const betsCents = BigInt(data?.todayBetsCents ?? 0);
  const rakeCents = BigInt(data?.todayRakeCents ?? 0);

  const todoTotal = pendingKyc + pendingDeposits + pendingWithdrawals + todayPushFailures + reconcileAnomalies + (activeRounds > 0 ? 1 : 0);
  const maxTodo = Math.max(pendingKyc, pendingDeposits, pendingWithdrawals, activeRounds, reconcileAnomalies, todayPushFailures, 1);
  const maxMoney = Number(betsCents > rakeCents ? betsCents : rakeCents || 1n);
  const checkedCount = checks.filter(Boolean).length;

  const checklist: Array<{ label: string; page: Page; tip: string }> = [
    { label: '核对 TNG 发包账号额度', page: 'tng', tip: '红包台账' },
    {
      label: '处理待审实名与充提工单',
      page: pendingKyc ? 'kyc' : pendingDeposits ? 'deposits' : 'withdrawals',
      tip: '审核队列',
    },
    {
      label: '检查异常局与在途红包',
      page: activeRounds || reconcileAnomalies ? 'gameOps' : 'tng',
      tip: '牌局 / TNG',
    },
    { label: '确认推送与奖励配置', page: 'messaging', tip: '消息中心' },
  ];

  return (
    <div className="dash-page">
      <section className="dash-summary panel">
        <div className="dash-summary-main">
          <small>今日运营状态</small>
          <strong>{todoTotal > 0 ? `${todoTotal} 项待处理` : '暂无紧急待办'}</strong>
          <p>
            已结算 {todaySettlements} 局 · 流水 RM {rm(betsCents)} · 抽水 RM {rm(rakeCents)}
          </p>
        </div>
        <div className="dash-summary-side">
          <button type="button" className="dash-pill" onClick={() => go('gameOps')} disabled={!allowed.includes('gameOps')}>
            <span>进行中牌局</span>
            <b>{activeRounds}</b>
          </button>
          <button type="button" className="dash-pill" onClick={() => go('tng')} disabled={!allowed.includes('tng')}>
            <span>TNG 在途</span>
            <b>RM {rm(transitCents)}</b>
          </button>
          <button type="button" className="dash-pill" onClick={() => go('kyc')} disabled={!allowed.includes('kyc')}>
            <span>待审实名</span>
            <b className={pendingKyc ? 'warn' : ''}>{pendingKyc}</b>
          </button>
        </div>
      </section>

      <section className="dash-section">
        <div className="dash-section-head">
          <h2>待办处理</h2>
          <span>点击卡片进入对应模块</span>
        </div>
        <div className="dash-metrics">
          <DashMetric
            label="待审实名"
            value={data ? pendingKyc : '—'}
            hint="实名审核队列"
            tone="gold"
            alert={pendingKyc > 0}
            level={(pendingKyc / maxTodo) * 100}
            onClick={allowed.includes('kyc') ? () => go('kyc') : undefined}
          />
          <DashMetric
            label="待处理充值"
            value={data ? pendingDeposits : '—'}
            hint="充值工单"
            tone="jade"
            alert={pendingDeposits > 0}
            level={(pendingDeposits / maxTodo) * 100}
            onClick={allowed.includes('deposits') ? () => go('deposits') : undefined}
          />
          <DashMetric
            label="待处理提现"
            value={data ? pendingWithdrawals : '—'}
            hint="提现工单 / 账户审核"
            tone="jade"
            alert={pendingWithdrawals > 0}
            level={(pendingWithdrawals / maxTodo) * 100}
            onClick={allowed.includes('withdrawals') ? () => go('withdrawals') : undefined}
          />
          <DashMetric
            label="推送失败"
            value={data ? todayPushFailures : '—'}
            hint="今日私聊触达异常"
            tone={todayPushFailures ? 'red' : 'gold'}
            alert={todayPushFailures > 0}
            level={(todayPushFailures / maxTodo) * 100}
            onClick={allowed.includes('messaging') ? () => go('messaging') : undefined}
          />
        </div>
      </section>

      <section className="dash-section">
        <div className="dash-section-head">
          <h2>今日经营</h2>
          <span>结算与抽水一眼看清</span>
        </div>
        <div className="dash-metrics dash-metrics-4">
          <DashMetric
            label="今日已结算"
            value={data ? todaySettlements : '—'}
            hint="局数"
            tone="gold"
            level={Math.min(100, todaySettlements * 8)}
            onClick={allowed.includes('gameOps') ? () => go('gameOps') : undefined}
          />
          <DashMetric
            label="今日投注流水"
            value={data ? `RM ${rm(betsCents)}` : '—'}
            hint="已结算注单合计"
            tone="jade"
            level={maxMoney ? Number((betsCents * 100n) / BigInt(maxMoney)) : 0}
            onClick={allowed.includes('finance') ? () => go('finance') : allowed.includes('gameOps') ? () => go('gameOps') : undefined}
          />
          <DashMetric
            label="今日抽水"
            value={data ? `RM ${rm(rakeCents)}` : '—'}
            hint="平台赢方抽水"
            tone="gold"
            level={maxMoney ? Number((rakeCents * 100n) / BigInt(maxMoney)) : 0}
            onClick={allowed.includes('finance') ? () => go('finance') : allowed.includes('rebates') ? () => go('rebates') : undefined}
          />
          <DashMetric
            label="进行中牌局"
            value={data ? activeRounds : '—'}
            hint="需关注的实时牌桌"
            tone={activeRounds ? 'red' : 'jade'}
            alert={activeRounds > 0}
            level={(activeRounds / Math.max(activeRounds, todaySettlements, 1)) * 100}
            onClick={allowed.includes('gameOps') ? () => go('gameOps') : undefined}
          />
        </div>
      </section>

      <div className="dashboard-grid dash-bottom">
        <section className="panel dash-risk">
          <div className="dash-section-head compact">
            <h2>风险与资金</h2>
            <span>异常优先处理</span>
          </div>
          <div className="dash-risk-list">
            <button type="button" className="dash-risk-row" onClick={() => go('tng')} disabled={!allowed.includes('tng')}>
              <div>
                <strong>TNG 在途金额</strong>
                <small>等待核销红包</small>
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
              className={`dash-risk-row${todayPushFailures ? ' alert' : ''}`}
              onClick={() => go('messaging')}
              disabled={!allowed.includes('messaging')}
            >
              <div>
                <strong>推送失败</strong>
                <small>消息中心查看重试</small>
              </div>
              <b>{data ? todayPushFailures : '—'}</b>
            </button>
            <button type="button" className="dash-risk-row" onClick={() => go('support')} disabled={!allowed.includes('support')}>
              <div>
                <strong>客服会话</strong>
                <small>设备 / 资金 / 牌局咨询</small>
              </div>
              <em>进入 ›</em>
            </button>
          </div>
        </section>

        <section className="panel checklist dash-checklist">
          <div className="panel-title">
            <div>
              <small>每日清单</small>
              <h2>今日运营检查</h2>
            </div>
            <span>{checkedCount}/4</span>
          </div>
          {checklist.map((item, index) => (
            <label key={item.label} className={checks[index] ? 'done' : ''}>
              <input
                type="checkbox"
                checked={checks[index]}
                onChange={(event) => {
                  const next = [...checks];
                  next[index] = event.target.checked;
                  setChecks(next);
                }}
              />
              <span>
                {item.label}
                <small>{item.tip}</small>
              </span>
              <button
                type="button"
                className="dash-check-go"
                onClick={(event) => {
                  event.preventDefault();
                  go(item.page);
                }}
                disabled={!allowed.includes(item.page)}
              >
                前往
              </button>
            </label>
          ))}
        </section>
      </div>
    </div>
  );
}

type UserDetailTab = 'overview' | 'profile' | 'kyc' | 'withdrawAccounts' | 'ledger' | 'rounds' | 'invitees' | 'orders';

const userDetailTabs: Array<[UserDetailTab, string]> = [
  ['overview', '账户总览'],
  ['profile', '基础资料'],
  ['kyc', '实名资料'],
  ['withdrawAccounts', '提款账户'],
  ['ledger', '余额流水'],
  ['rounds', '参与牌局'],
  ['invitees', '直属下线'],
  ['orders', '充提记录'],
];

type WithdrawAccountDraft = {
  id: string;
  type: string;
  institution: string;
  accountNo: string;
  accountName: string;
  status: string;
  rejectReason: string;
  isDefault: boolean;
  reason: string;
};

function canAdjustBalance(role: Admin['role']) {
  return role === 'SUPER' || role === 'FINANCE';
}
function canEditProfile(role: Admin['role']) {
  return role === 'SUPER';
}
function canEditKyc(role: Admin['role']) {
  return role === 'SUPER' || role === 'OPERATOR' || role === 'REVIEWER';
}
function canEditNote(role: Admin['role']) {
  return role === 'SUPER' || role === 'OPERATOR' || role === 'REVIEWER';
}
function canEditWithdrawAccounts(role: Admin['role']) {
  return role === 'SUPER' || role === 'OPERATOR' || role === 'REVIEWER' || role === 'FINANCE';
}

function dateTime(value?: string | null) {
  return value ? new Date(value).toLocaleString('zh-MY') : '—';
}

function WithdrawOrderTarget({ item }: { item: Row }) {
  const snapshot =
    item.targetSnapshot &&
    typeof item.targetSnapshot === 'object' &&
    !Array.isArray(item.targetSnapshot)
      ? item.targetSnapshot
      : {};
  const grossCents = BigInt(String(item.amountCents ?? 0));
  const feeValue = String(snapshot.feeCents ?? '0');
  const feeCents = /^\d+$/.test(feeValue) ? BigInt(feeValue) : 0n;
  const netCents = feeCents <= grossCents ? grossCents - feeCents : grossCents;
  return (
    <>
      <strong>{snapshot.institution ?? item.channel ?? '—'} · {snapshot.accountName ?? '—'}</strong>
      <small>账号：{snapshot.accountNo ?? '—'}</small>
      <small>
        财务应转 RM {rm(netCents)} · 手续费 RM {rm(feeCents)}
        {snapshot.freeQuota === true ? '（免费次数）' : ''}
      </small>
    </>
  );
}

function Users({ role }: { role: Admin['role'] }) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [items, setItems] = useState<Row[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    setError('');
    try {
      const params = new URLSearchParams({ q: query, limit: '100' });
      if (statusFilter) params.set('status', statusFilter);
      const result = await request<{ items: Row[] }>(`/api/admin/users?${params}`);
      setItems(result.items);
      if (selectedId && !result.items.some((item) => item.id === selectedId)) setSelectedId(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function status(user: Row) {
    const next = user.status === 'ACTIVE' ? 'BANNED' : 'ACTIVE';
    const reason = prompt(next === 'BANNED' ? '请输入封禁原因（至少 2 字）' : '请输入恢复原因（至少 2 字）');
    if (!reason || reason.trim().length < 2) return;
    try {
      await patch(`/api/admin/users/${user.id}/status`, { status: next, reason: reason.trim() });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function unbind(user: Row) {
    if (!confirm(`确认解绑 UID ${user.uid} 的当前设备？用户下次登录需要重新绑定。`)) return;
    try {
      await post(`/api/admin/users/${user.id}/unbind-device`, {});
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <div className="toolbar standalone user-search-bar">
        <div className="search">
          <span>⌕</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void load()}
            placeholder="UID、昵称、TG、实名、DuitNow 或银行账号/后四位"
          />
        </div>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="">全部状态</option>
          <option value="ACTIVE">正常</option>
          <option value="BANNED">已封禁</option>
        </select>
        <span className="toolbar-count">{items.length} 位用户</span>
        <button disabled={busy} onClick={() => void load()}>{busy ? '查询中…' : '查询'}</button>
      </div>
      <ErrorBox error={error} />
      <div className={`user-center-layout ${selectedId ? 'has-detail' : ''}`}>
        <section className="panel user-directory">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>用户</th>
                  <th>实名</th>
                  <th>邀请关系</th>
                  <th>账户资金</th>
                  <th>设备</th>
                  <th>状态</th>
                  <th>快捷操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((user) => (
                  <tr
                    key={user.id}
                    className={`clickable-row ${selectedId === user.id ? 'selected' : ''}`}
                    onClick={() => setSelectedId(user.id)}
                  >
                    <td>
                      <strong>{user.nickname || '未设置昵称'}</strong>
                      <small>UID {user.uid} · TG {user.tgId}</small>
                    </td>
                    <td>
                      {user.kyc ? (
                        <>
                          <strong>{user.kyc.realName}</strong>
                          <small><Badge value={user.kyc.status} /> {user.kyc.bankName} {user.kyc.bankAccount}</small>
                        </>
                      ) : '—'}
                    </td>
                    <td>
                      <span>{user.inviter?.uid ?? '无上级'}</span>
                      <small>{user.invitees} 位直属</small>
                    </td>
                    <td>
                      <strong className="money">RM {rm(user.wallet?.availableCents ?? 0)}</strong>
                      <small>冻结 RM {rm(
                        BigInt(String(user.wallet?.freezeBankerCents ?? 0))
                        + BigInt(String(user.wallet?.freezeBetCents ?? 0))
                        + BigInt(String(user.wallet?.freezeWithdrawCents ?? 0)),
                      )}</small>
                    </td>
                    <td><Badge value={user.device?.status ?? 'UNBOUND'} /></td>
                    <td><Badge value={user.status} /></td>
                    <td className="actions" onClick={(event) => event.stopPropagation()}>
                      <button onClick={() => setSelectedId(user.id)}>查看详情</button>
                      {role === 'SUPER' && (
                        <button onClick={() => void status(user)}>{user.status === 'ACTIVE' ? '封禁' : '恢复'}</button>
                      )}
                      {role !== 'FINANCE' && <button onClick={() => void unbind(user)}>解绑设备</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {items.length === 0 && <Empty text="未找到用户" />}
          </div>
        </section>
        {selectedId && (
          <UserDetail
            key={selectedId}
            userId={selectedId}
            role={role}
            onClose={() => setSelectedId(null)}
            onChanged={() => void load()}
            onToggleStatus={async () => {
              const user = items.find((item) => item.id === selectedId);
              if (user) await status(user);
            }}
            onUnbind={async () => {
              const user = items.find((item) => item.id === selectedId);
              if (user) await unbind(user);
            }}
          />
        )}
      </div>
    </>
  );
}

function UserDetail({
  userId,
  role,
  onClose,
  onChanged,
  onToggleStatus,
  onUnbind,
}: {
  userId: string;
  role: Admin['role'];
  onClose: () => void;
  onChanged: () => void;
  onToggleStatus: () => Promise<void>;
  onUnbind: () => Promise<void>;
}) {
  const [tab, setTab] = useState<UserDetailTab>('overview');
  const [detail, setDetail] = useState<Row | null>(null);
  const [ledger, setLedger] = useState<Row[]>([]);
  const [rounds, setRounds] = useState<Row[]>([]);
  const [invitees, setInvitees] = useState<Row[]>([]);
  const [orders, setOrders] = useState<Row[]>([]);
  const [ledgerCursor, setLedgerCursor] = useState<string | null>(null);
  const [roundCursor, setRoundCursor] = useState<string | null>(null);
  const [inviteeCursor, setInviteeCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [adminNote, setAdminNote] = useState('');
  const [profile, setProfile] = useState({
    nickname: '',
    tgUsername: '',
    tgDisplayName: '',
    avatarUrl: '',
    reason: '',
  });
  const [kyc, setKyc] = useState({
    realName: '',
    duitnowId: '',
    bankName: '',
    bankAccount: '',
    accountHolder: '',
    status: 'PENDING',
    rejectReason: '',
    reason: '',
  });
  const [adjustment, setAdjustment] = useState({ direction: 'credit', amount: '', reason: '' });
  const [withdrawDrafts, setWithdrawDrafts] = useState<WithdrawAccountDraft[]>([]);
  const adjustmentRequestId = useRef(crypto.randomUUID());

  function applyDetail(value: Row) {
    setDetail(value);
    setAdminNote(value.user.adminNote ?? '');
    setProfile({
      nickname: value.user.nickname ?? '',
      tgUsername: value.user.tgUsername ?? '',
      tgDisplayName: value.user.tgDisplayName ?? '',
      avatarUrl: value.user.avatarUrl ?? '',
      reason: '',
    });
    setKyc({
      realName: value.kyc?.realName ?? '',
      duitnowId: value.kyc?.duitnowId ?? '',
      bankName: value.kyc?.bankName ?? '',
      bankAccount: value.kyc?.bankAccount ?? '',
      accountHolder: value.kyc?.accountHolder ?? '',
      status: value.kyc?.status ?? 'PENDING',
      rejectReason: value.kyc?.rejectReason ?? '',
      reason: '',
    });
    setWithdrawDrafts(
      (value.withdrawAccounts as Row[]).map((account) => ({
        id: account.id,
        type: account.type,
        institution: account.institution ?? '',
        accountNo: account.accountNo ?? '',
        accountName: account.accountName ?? '',
        status: account.status,
        rejectReason: account.rejectReason ?? '',
        isDefault: Boolean(account.isDefault),
        reason: '',
      })),
    );
  }

  function patchWithdrawDraft(accountId: string, patch: Partial<WithdrawAccountDraft>) {
    setWithdrawDrafts((prev) =>
      prev.map((item) => (item.id === accountId ? { ...item, ...patch } : item)),
    );
  }

  async function load() {
    setBusy(true);
    setError('');
    try {
      const [userResult, ledgerResult, roundResult, inviteeResult, orderResult] = await Promise.all([
        request<Row>(`/api/admin/users/${userId}`),
        request<{ items: Row[]; nextCursor: string | null }>(`/api/admin/users/${userId}/ledger?limit=50`),
        request<{ items: Row[]; nextCursor: string | null }>(`/api/admin/users/${userId}/rounds?limit=30`),
        request<{ items: Row[]; nextCursor: string | null }>(`/api/admin/users/${userId}/invitees?limit=50`),
        request<{ items: Row[] }>(`/api/admin/users/${userId}/orders?limit=40`),
      ]);
      applyDetail(userResult);
      setLedger(ledgerResult.items);
      setLedgerCursor(ledgerResult.nextCursor);
      setRounds(roundResult.items);
      setRoundCursor(roundResult.nextCursor);
      setInvitees(inviteeResult.items);
      setInviteeCursor(inviteeResult.nextCursor);
      setOrders(orderResult.items);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, [userId]);

  async function saveProfile() {
    if (profile.reason.trim().length < 4) return;
    if (!confirm(`确认修改 UID ${detail?.user.uid} 的基础资料？本操作会写入审计日志。`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await patch(`/api/admin/users/${userId}/profile`, {
        nickname: profile.nickname.trim() || null,
        tgUsername: profile.tgUsername.trim().replace(/^@/, '') || null,
        tgDisplayName: profile.tgDisplayName.trim() || null,
        avatarUrl: profile.avatarUrl.trim() || null,
        reason: profile.reason.trim(),
      });
      setNotice('基础资料已保存');
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveKyc() {
    if (!kyc.realName || !kyc.duitnowId) return;
    if (kyc.reason.trim().length < 4 || (kyc.status === 'REJECTED' && kyc.rejectReason.trim().length < 2)) return;
    if (!confirm(`确认覆盖 UID ${detail?.user.uid} 的实名资料？DuitNow 对应的 KYC 提现账户也会同步。`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await patch(`/api/admin/users/${userId}/kyc`, {
        realName: kyc.realName,
        duitnowId: kyc.duitnowId,
        bankName: kyc.bankName,
        bankAccount: kyc.bankAccount,
        accountHolder: kyc.accountHolder,
        status: kyc.status,
        rejectReason: kyc.status === 'REJECTED' ? kyc.rejectReason : null,
        reason: kyc.reason.trim(),
      });
      setNotice('实名资料已保存；TNG 提现账户已同步，银行账号请在提款账户中管理');
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function adjustBalance() {
    if (!detail || !canAdjustBalance(role) || !adjustment.amount || adjustment.reason.trim().length < 4) return;
    let amountCents: string;
    try {
      amountCents = toCents(adjustment.amount);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    const action = adjustment.direction === 'credit' ? '增加' : '扣减';
    if (!confirm(`确认给 UID ${detail.user.uid} ${action} RM ${adjustment.amount}？\n原因：${adjustment.reason}`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await post<{ duplicate?: boolean }>('/api/admin/finance/adjust', {
        uid: detail.user.uid,
        direction: adjustment.direction,
        amountCents,
        reason: adjustment.reason.trim(),
        requestId: adjustmentRequestId.current,
      });
      setNotice(result.duplicate ? '该调账请求此前已处理，本次未重复入账' : `余额已${action}`);
      adjustmentRequestId.current = crypto.randomUUID();
      setAdjustment({ direction: 'credit', amount: '', reason: '' });
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveNote() {
    if (!canEditNote(role)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await patch(`/api/admin/users/${userId}/note`, {
        adminNote: adminNote.trim() || null,
        reason: '更新客服备注',
      });
      setNotice('内部备注已保存');
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveWithdrawAccount(draft: WithdrawAccountDraft) {
    if (!canEditWithdrawAccounts(role)) return;
    if (!draft.institution.trim() || !draft.accountNo.trim() || !draft.accountName.trim()) {
      setError('请填写机构、账号与户名');
      return;
    }
    if (draft.reason.trim().length < 4) {
      setError('修改原因至少 4 个字');
      return;
    }
    if (draft.status === 'REJECTED' && draft.rejectReason.trim().length < 2) {
      setError('驳回时请填写驳回原因');
      return;
    }
    if (draft.isDefault && draft.status !== 'APPROVED') {
      setError('仅「已通过」账户可设为默认');
      return;
    }
    if (!confirm(`确认修改 UID ${detail?.user.uid} 的提款账户「${draft.institution}」？将写入审计日志。`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await patch(`/api/admin/users/${userId}/withdraw-accounts/${draft.id}`, {
        type: draft.type,
        institution: draft.institution.trim(),
        accountNo: draft.accountNo.trim(),
        accountName: draft.accountName.trim(),
        status: draft.status,
        rejectReason: draft.status === 'REJECTED' ? draft.rejectReason.trim() : null,
        isDefault: draft.isDefault,
        reason: draft.reason.trim(),
      });
      setNotice('提款账户已保存');
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function loadMoreLedger() {
    if (!ledgerCursor) return;
    const result = await request<{ items: Row[]; nextCursor: string | null }>(
      `/api/admin/users/${userId}/ledger?limit=50&cursor=${encodeURIComponent(ledgerCursor)}`,
    );
    setLedger((current) => [...current, ...result.items]);
    setLedgerCursor(result.nextCursor);
  }

  async function loadMoreRounds() {
    if (!roundCursor) return;
    const result = await request<{ items: Row[]; nextCursor: string | null }>(
      `/api/admin/users/${userId}/rounds?limit=30&cursor=${encodeURIComponent(roundCursor)}`,
    );
    setRounds((current) => [...current, ...result.items]);
    setRoundCursor(result.nextCursor);
  }

  async function loadMoreInvitees() {
    if (!inviteeCursor) return;
    const result = await request<{ items: Row[]; nextCursor: string | null }>(
      `/api/admin/users/${userId}/invitees?limit=50&cursor=${encodeURIComponent(inviteeCursor)}`,
    );
    setInvitees((current) => [...current, ...result.items]);
    setInviteeCursor(result.nextCursor);
  }

  async function resetPaymentPin() {
    if (!detail?.paymentPin?.set) return;
    const reason = prompt('请输入重置原因（至少 4 个字）。重置后设备会同时解绑：', '用户忘记支付密码');
    if (reason == null) return;
    if (reason.trim().length < 4) {
      setError('重置原因至少需要 4 个字');
      return;
    }
    if (!confirm(`确认重置 UID ${detail.user.uid} 的支付密码并解绑当前设备？`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await post(`/api/admin/users/${userId}/reset-payment-pin`, { reason: reason.trim() });
      setNotice('支付密码已重置，旧设备会话已失效');
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const reasonLen = adjustment.reason.trim().length;
  const adjustReady = Boolean(adjustment.amount.trim()) && reasonLen >= 4;
  const adjustHint = !adjustment.amount.trim()
    ? '请先填写金额'
    : reasonLen < 4
      ? `调账原因至少 4 个字（当前 ${reasonLen} 字），例如「客服补分」`
      : '填写完成，可点击确认调账';

  const AdjustBox = (
    <section className="user-adjust-box">
      <div>
        <small>高风险操作</small>
        <h3>人工调整可用余额</h3>
        <p>通过 ADJUST_CLEARING 双分录入账；不会直接改钱包字段。原因至少 4 个字，重复提交由请求号防重。</p>
      </div>
      <div className="user-adjust-form">
        <select value={adjustment.direction} onChange={(event) => setAdjustment({ ...adjustment, direction: event.target.value })}>
          <option value="credit">增加余额</option>
          <option value="debit">扣减余额</option>
        </select>
        <input value={adjustment.amount} onChange={(event) => setAdjustment({ ...adjustment, amount: event.target.value })} placeholder="金额 RM，如 222" />
        <input value={adjustment.reason} onChange={(event) => setAdjustment({ ...adjustment, reason: event.target.value })} placeholder="原因至少 4 字，如：客服补分" />
        <button className="primary" disabled={busy || !adjustReady} onClick={() => void adjustBalance()}>确认调账</button>
      </div>
      <p className={`user-adjust-hint ${adjustReady ? 'ok' : 'warn'}`}>{adjustHint}</p>
    </section>
  );

  async function exportLedgerCsv() {
    if (!detail) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await downloadAuthorized(
        `/api/admin/users/${userId}/ledger.csv`,
        `user-${detail.user.uid}-ledger.csv`,
      );
      setNotice('流水 CSV 已开始下载');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!detail) {
    return (
      <aside className="detail-drawer user-detail-drawer">
        <header><div><small>用户档案</small><h2>{busy ? '读取中…' : '读取失败'}</h2></div><button onClick={onClose}>×</button></header>
        <ErrorBox error={error} />
      </aside>
    );
  }

  const wallet = detail.wallet ?? {};
  const frozen =
    BigInt(String(wallet.freezeBankerCents ?? 0))
    + BigInt(String(wallet.freezeBetCents ?? 0))
    + BigInt(String(wallet.freezeWithdrawCents ?? 0));

  return (
    <aside className="detail-drawer user-detail-drawer">
      <header className="user-detail-head">
        <div className="user-detail-identity">
          <SupportAvatar url={detail.user.avatarUrl} name={detail.user.nickname} />
          <div>
            <small>UID {detail.user.uid}</small>
            <h2>{detail.user.nickname || '未设置昵称'}</h2>
            <span>TG {detail.user.tgId} {detail.user.tgUsername ? `· @${detail.user.tgUsername}` : ''}</span>
          </div>
        </div>
        <div className="user-detail-head-actions">
          <Badge value={detail.user.status} />
          {role === 'SUPER' && (
            <button onClick={async () => { await onToggleStatus(); await load(); }}>
              {detail.user.status === 'ACTIVE' ? '封禁' : '恢复'}
            </button>
          )}
          {detail.device?.status === 'ACTIVE' && role !== 'FINANCE' && (
            <button onClick={async () => { await onUnbind(); await load(); }}>解绑设备</button>
          )}
          {detail.paymentPin?.set && (role === 'SUPER' || role === 'REVIEWER') && (
            <button disabled={busy} onClick={() => void resetPaymentPin()}>重置支付密码</button>
          )}
          <button title="刷新用户详情" onClick={() => void load()}>刷新</button>
          <button title="关闭详情" onClick={onClose}>×</button>
        </div>
      </header>

      <div className="user-detail-tabs">
        {userDetailTabs.map(([key, label]) => (
          <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {(error || notice) && (
        <div className="user-detail-feedback">
          <ErrorBox error={error} />
          {notice && <div className="success-box">{notice}</div>}
        </div>
      )}

      {tab === 'overview' && (
        <div className="user-detail-body">
          <div className="user-wallet-grid">
            <article><small>可用余额</small><strong>RM {rm(wallet.availableCents ?? 0)}</strong><span>可下注 / 提现</span></article>
            <article><small>冻结总额</small><strong>RM {rm(frozen)}</strong><span>庄池、下注、提现</span></article>
            <article><small>庄池冻结</small><strong>RM {rm(wallet.freezeBankerCents ?? 0)}</strong><span>进行中庄家资金</span></article>
            <article><small>下注冻结</small><strong>RM {rm(wallet.freezeBetCents ?? 0)}</strong><span>未结算注单</span></article>
            <article><small>提现冻结</small><strong>RM {rm(wallet.freezeWithdrawCents ?? 0)}</strong><span>待审核提现金额</span></article>
          </div>

          {canAdjustBalance(role) ? AdjustBox : (
            <div className="user-readonly-note">余额调整仅超级管理员或财务可执行；你仍可查看流水与牌局。</div>
          )}

          <section className="user-subsection">
            <div className="drawer-title">内部备注</div>
            <textarea
              className="user-note-input"
              value={adminNote}
              disabled={!canEditNote(role)}
              onChange={(event) => setAdminNote(event.target.value)}
              placeholder="仅后台可见：风控提示、客服处理记录、联系偏好等"
              rows={3}
            />
            {canEditNote(role)
              ? <button className="primary user-save-button" disabled={busy} onClick={() => void saveNote()}>保存备注</button>
              : <div className="user-readonly-note">财务角色只读备注。</div>}
          </section>

          <div className="user-summary-grid">
            <section>
              <div className="drawer-title">账户身份</div>
              <dl className="user-info-list">
                <div><dt>UID</dt><dd>{detail.user.uid}</dd></div>
                <div><dt>Telegram ID</dt><dd>{detail.user.tgId}</dd></div>
                <div><dt>显示名称</dt><dd>{detail.user.tgDisplayName || '—'}</dd></div>
                <div><dt>注册时间</dt><dd>{dateTime(detail.user.createdAt)}</dd></div>
                <div><dt>一级邀请人</dt><dd>{detail.user.inviter ? `${detail.user.inviter.uid} · ${detail.user.inviter.nickname || '—'}` : '无'}</dd></div>
                <div><dt>二级邀请人</dt><dd>{detail.user.grandInviter ? `${detail.user.grandInviter.uid} · ${detail.user.grandInviter.nickname || '—'}` : '无'}</dd></div>
              </dl>
            </section>
            <section>
              <div className="drawer-title">准入与设备</div>
              <dl className="user-info-list">
                <div><dt>实名状态</dt><dd><Badge value={detail.kyc?.status ?? 'UNBOUND'} /></dd></div>
                <div><dt>TNG 实名</dt><dd>{detail.kyc?.realName || '—'}</dd></div>
                <div><dt>设备状态</dt><dd><Badge value={detail.device?.status ?? 'UNBOUND'} /></dd></div>
                <div><dt>设备标识</dt><dd>{detail.device?.deviceIdMasked ?? '—'}</dd></div>
                <div><dt>绑定时间</dt><dd>{dateTime(detail.device?.boundAt)}</dd></div>
                <div>
                  <dt>支付密码</dt>
                  <dd>
                    {detail.paymentPin?.set
                      ? detail.paymentPin.lockedUntil && new Date(detail.paymentPin.lockedUntil) > new Date()
                        ? '已锁定'
                        : '已设置'
                      : '未设置'}
                  </dd>
                </div>
                <div><dt>提款账户</dt><dd>{detail.withdrawAccounts.length} 个</dd></div>
              </dl>
            </section>
          </div>

          <div className="user-activity-grid">
            {[
              ['坐庄局数', detail.summary.bankerRounds],
              ['竞标记录', detail.summary.bids],
              ['下注记录', detail.summary.bets],
              ['认额记录', detail.summary.claims],
              ['已结算对局', detail.summary.settlements],
              ['直属下线', detail.summary.directInvitees],
              ['奖励记录', detail.summary.rewards],
              ['充值工单', detail.summary.deposits],
              ['提现工单', detail.summary.withdrawals],
            ].map(([label, value]) => <div key={String(label)}><strong>{value}</strong><span>{label}</span></div>)}
          </div>

          <section className="user-subsection">
            <div className="drawer-title">
              提款账户
              <button type="button" className="linkish" onClick={() => setTab('withdrawAccounts')}>去编辑 →</button>
            </div>
            {detail.withdrawAccounts.length ? detail.withdrawAccounts.map((account: Row) => (
              <div className="user-account-row" key={account.id}>
                <div>
                  <strong>{account.institution}{account.isDefault ? ' · 默认' : ''}</strong>
                  <small>{account.type === 'BANK' ? '银行' : '电子钱包'} · {account.source === 'kyc' ? '实名生成' : '用户添加'}</small>
                </div>
                <div>
                  <strong className="mono">{account.accountNo || account.accountNoMasked}</strong>
                  <small>{account.accountName}</small>
                </div>
                <Badge value={account.status} />
              </div>
            )) : <Empty text="没有提款账户" />}
          </section>

          <section className="user-subsection">
            <div className="drawer-title">最近管理操作</div>
            {detail.auditLogs.length ? detail.auditLogs.slice(0, 8).map((log: Row) => (
              <div className="user-audit-row" key={log.id}>
                <span>{log.action}</span><small>{dateTime(log.createdAt)}</small>
              </div>
            )) : <Empty text="没有针对该用户的管理记录" />}
          </section>
        </div>
      )}

      {tab === 'profile' && (
        <div className="user-detail-body">
          <div className="user-safety-note">
            UID、Telegram ID、邀请关系和历史记录是系统标识，不能在此直接覆盖。Telegram 同步字段可能在用户下次登录时再次更新。
          </div>
          <div className="user-form-grid">
            <label>昵称<input value={profile.nickname} disabled={!canEditProfile(role)} onChange={(event) => setProfile({ ...profile, nickname: event.target.value })} /></label>
            <label>Telegram 用户名<input value={profile.tgUsername} disabled={!canEditProfile(role)} onChange={(event) => setProfile({ ...profile, tgUsername: event.target.value })} placeholder="不含 @" /></label>
            <label>Telegram 显示名<input value={profile.tgDisplayName} disabled={!canEditProfile(role)} onChange={(event) => setProfile({ ...profile, tgDisplayName: event.target.value })} /></label>
            <label className="wide">头像 URL<input value={profile.avatarUrl} disabled={!canEditProfile(role)} onChange={(event) => setProfile({ ...profile, avatarUrl: event.target.value })} /></label>
            {canEditProfile(role) && (
              <label className="wide">修改原因<textarea value={profile.reason} onChange={(event) => setProfile({ ...profile, reason: event.target.value })} placeholder="至少 4 字，将写入审计日志" /></label>
            )}
          </div>
          {canEditProfile(role)
            ? <button className="primary user-save-button" disabled={busy || profile.reason.trim().length < 4} onClick={() => void saveProfile()}>保存基础资料</button>
            : <div className="user-readonly-note">仅超级管理员可以修改基础资料。</div>}
        </div>
      )}

      {tab === 'kyc' && (
        <div className="user-detail-body">
          <div className="user-safety-note">
            实名字段加密存储。保存为「已通过」时，会同步 KYC 来源的 TNG 与银行提款账户；历史订单快照不会被改写。日常待审请优先走「实名审核」队列。单独改提款账户请用「提款账户」页签。
          </div>
          <div className="user-form-grid">
            <label>TNG 实名<input value={kyc.realName} disabled={!canEditKyc(role)} onChange={(event) => setKyc({ ...kyc, realName: event.target.value })} /></label>
            <label>DuitNow ID<input value={kyc.duitnowId} disabled={!canEditKyc(role)} onChange={(event) => setKyc({ ...kyc, duitnowId: event.target.value })} /></label>
            <label className="wide">备注：银行卡/电子钱包请在「提款账户」页签管理；以下银行字段仅兼容历史资料。
            </label>
            <label>历史提款银行<input value={kyc.bankName} disabled={!canEditKyc(role)} onChange={(event) => setKyc({ ...kyc, bankName: event.target.value })} placeholder="可选" /></label>
            <label>历史银行账号<input value={kyc.bankAccount} disabled={!canEditKyc(role)} onChange={(event) => setKyc({ ...kyc, bankAccount: event.target.value })} placeholder="可选" /></label>
            <label>历史银行户名<input value={kyc.accountHolder} disabled={!canEditKyc(role)} onChange={(event) => setKyc({ ...kyc, accountHolder: event.target.value })} placeholder="可选，默认同实名" /></label>
            <label>实名状态<select value={kyc.status} disabled={!canEditKyc(role)} onChange={(event) => setKyc({ ...kyc, status: event.target.value })}><option value="PENDING">待审核</option><option value="APPROVED">已通过</option><option value="REJECTED">已驳回</option></select></label>
            {kyc.status === 'REJECTED' && <label className="wide">驳回原因<input value={kyc.rejectReason} disabled={!canEditKyc(role)} onChange={(event) => setKyc({ ...kyc, rejectReason: event.target.value })} /></label>}
            {canEditKyc(role) && <label className="wide">修改原因<textarea value={kyc.reason} onChange={(event) => setKyc({ ...kyc, reason: event.target.value })} placeholder="至少 4 字，将写入审计日志" /></label>}
          </div>
          {canEditKyc(role)
            ? <button className="primary user-save-button" disabled={busy || kyc.reason.trim().length < 4} onClick={() => void saveKyc()}>保存实名资料</button>
            : <div className="user-readonly-note">财务角色只读实名资料；协助更换请联系运营 / 审核。提款账户可在「提款账户」页签修改。</div>}
        </div>
      )}

      {tab === 'withdrawAccounts' && (
        <div className="user-detail-body">
          <div className="user-safety-note">
            账号与户名在后台明文展示（库内仍加密）。修改会立即影响后续提现打款目标；历史提现工单快照不会被改写。KYC 来源账户与实名资料相互独立，改这里不会自动回写实名页。
          </div>
          {!canEditWithdrawAccounts(role) && (
            <div className="user-readonly-note">当前角色无法修改提款账户。</div>
          )}
          {withdrawDrafts.length ? withdrawDrafts.map((draft) => {
            const meta = (detail.withdrawAccounts as Row[]).find((item) => item.id === draft.id);
            const editable = canEditWithdrawAccounts(role);
            return (
              <section className="user-withdraw-card" key={draft.id}>
                <div className="user-withdraw-card-head">
                  <div>
                    <strong>{meta?.institution ?? draft.institution}</strong>
                    <small>
                      {meta?.source === 'kyc' ? '实名生成' : '用户添加'}
                      {draft.isDefault ? ' · 默认收款' : ''}
                      {meta?.updatedAt ? ` · 更新于 ${dateTime(meta.updatedAt)}` : ''}
                    </small>
                  </div>
                  <Badge value={draft.status} />
                </div>
                <div className="user-form-grid">
                  <label>
                    类型
                    <select
                      value={draft.type}
                      disabled={!editable}
                      onChange={(event) => patchWithdrawDraft(draft.id, { type: event.target.value })}
                    >
                      <option value="EWALLET">电子钱包</option>
                      <option value="BANK">银行</option>
                    </select>
                  </label>
                  <label>
                    机构名称
                    <input
                      value={draft.institution}
                      disabled={!editable}
                      onChange={(event) => patchWithdrawDraft(draft.id, { institution: event.target.value })}
                      placeholder={draft.type === 'BANK' ? '如 CIMB Bank Berhad' : "如 Touch 'n Go eWallet"}
                    />
                  </label>
                  <label>
                    账号 / DuitNow
                    <input
                      className="mono"
                      value={draft.accountNo}
                      disabled={!editable}
                      onChange={(event) => patchWithdrawDraft(draft.id, { accountNo: event.target.value })}
                    />
                  </label>
                  <label>
                    户名
                    <input
                      value={draft.accountName}
                      disabled={!editable}
                      onChange={(event) => patchWithdrawDraft(draft.id, { accountName: event.target.value })}
                    />
                  </label>
                  <label>
                    状态
                    <select
                      value={draft.status}
                      disabled={!editable}
                      onChange={(event) => {
                        const status = event.target.value;
                        patchWithdrawDraft(draft.id, {
                          status,
                          isDefault: status === 'APPROVED' ? draft.isDefault : false,
                        });
                      }}
                    >
                      <option value="PENDING">待审核</option>
                      <option value="APPROVED">已通过</option>
                      <option value="REJECTED">已驳回</option>
                    </select>
                  </label>
                  <label className="user-check-label">
                    <span>默认收款账户</span>
                    <input
                      type="checkbox"
                      checked={draft.isDefault}
                      disabled={!editable || draft.status !== 'APPROVED'}
                      onChange={(event) => patchWithdrawDraft(draft.id, { isDefault: event.target.checked })}
                    />
                  </label>
                  {draft.status === 'REJECTED' && (
                    <label className="wide">
                      驳回原因
                      <input
                        value={draft.rejectReason}
                        disabled={!editable}
                        onChange={(event) => patchWithdrawDraft(draft.id, { rejectReason: event.target.value })}
                      />
                    </label>
                  )}
                  {editable && (
                    <label className="wide">
                      修改原因
                      <textarea
                        value={draft.reason}
                        onChange={(event) => patchWithdrawDraft(draft.id, { reason: event.target.value })}
                        placeholder="至少 4 字，将写入审计日志"
                      />
                    </label>
                  )}
                </div>
                {editable && (
                  <button
                    className="primary user-save-button"
                    disabled={busy || draft.reason.trim().length < 4}
                    onClick={() => void saveWithdrawAccount(draft)}
                  >
                    保存此账户
                  </button>
                )}
              </section>
            );
          }) : <Empty text="没有提款账户" />}
        </div>
      )}

      {tab === 'ledger' && (
        <div className="user-detail-body">
          {canAdjustBalance(role) ? AdjustBox : (
            <div className="user-readonly-note">流水可查询；余额调整仅超级管理员或财务可执行。</div>
          )}
          <div className="user-ledger-toolbar">
            <div className="drawer-title">钱包流水</div>
            <button disabled={busy} onClick={() => void exportLedgerCsv()}>导出 CSV</button>
          </div>
          <div className="table-wrap user-ledger-table">
            <table>
              <thead><tr><th>时间</th><th>科目</th><th>方向</th><th>金额</th><th>余额后</th><th>业务</th><th>关联局</th><th>备注</th></tr></thead>
              <tbody>
                {ledger.map((entry) => (
                  <tr key={entry.id}>
                    <td>{dateTime(entry.createdAt)}</td>
                    <td>{entry.accountType}</td>
                    <td className={entry.direction === 'CREDIT' ? 'positive' : 'negative'}>{entry.direction === 'CREDIT' ? '增加' : '减少'}</td>
                    <td>RM {rm(entry.amountCents)}</td>
                    <td>{entry.balanceAfterCents === null ? '—' : `RM ${rm(entry.balanceAfterCents)}`}</td>
                    <td>{entry.refType}</td>
                    <td>{entry.roundId ? entry.roundId.slice(-8) : '—'}</td>
                    <td>{entry.memo || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ledger.length === 0 && <Empty text="该用户暂无流水" />}
          </div>
          {ledgerCursor && <button className="load-more" onClick={() => void loadMoreLedger()}>加载更多流水</button>}
        </div>
      )}

      {tab === 'rounds' && (
        <div className="user-detail-body">
          <div className="table-wrap user-round-table">
            <table>
              <thead><tr><th>牌局</th><th>身份</th><th>阶段</th><th>竞标 / 下注</th><th>认额</th><th>结果</th><th>净变动</th><th>时间</th></tr></thead>
              <tbody>
                {rounds.map((round) => {
                  const bankerNet = round.scoreboard?.bankerSummary?.netCents;
                  const net = round.role === 'BANKER' ? bankerNet : round.playerNetCents;
                  return (
                    <tr key={round.id}>
                      <td><strong>{round.room.title} #{round.seqNo}</strong><small>{round.id.slice(-8)}</small></td>
                      <td>{round.role === 'BANKER' ? '庄家' : round.role === 'PLAYER' ? '闲家' : '竞标者'}</td>
                      <td><Badge value={round.phase} /></td>
                      <td>
                        {round.role === 'BANKER'
                          ? `庄池 RM ${rm(round.potCents)}`
                          : round.bet
                            ? `${round.bet.isAllIn ? '梭哈' : '下注'} RM ${rm(round.bet.amountCents)}`
                            : round.bid
                              ? `竞标 RM ${rm(round.bid.amountCents)}`
                              : '—'}
                      </td>
                      <td>{round.claim ? <><strong>RM {rm(round.claim.amountCents)}</strong><small>{round.claim.handType || '—'} · {round.claim.points ?? '—'} 点</small></> : '—'}</td>
                      <td>{round.settlement?.outcome ?? (round.cancelReason ? `取消：${round.cancelReason}` : '—')}</td>
                      <td className={net !== null && net !== undefined && BigInt(String(net)) >= 0n ? 'positive' : 'negative'}>{net === null || net === undefined ? '—' : `RM ${rm(net)}`}</td>
                      <td>{dateTime(round.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rounds.length === 0 && <Empty text="该用户没有参与牌局" />}
          </div>
          {roundCursor && <button className="load-more" onClick={() => void loadMoreRounds()}>加载更多牌局</button>}
        </div>
      )}

      {tab === 'invitees' && (
        <div className="user-detail-body">
          <div className="table-wrap user-round-table">
            <table>
              <thead><tr><th>下线</th><th>实名</th><th>状态</th><th>余额</th><th>再下线</th><th>绑定时间</th></tr></thead>
              <tbody>
                {invitees.map((item) => (
                  <tr key={item.id}>
                    <td><strong>{item.nickname || '未设置昵称'}</strong><small>UID {item.uid}</small></td>
                    <td>{item.realName || '—'}{item.kycStatus ? <> · <Badge value={item.kycStatus} /></> : null}</td>
                    <td><Badge value={item.status} /></td>
                    <td className="money">RM {rm(item.availableCents ?? 0)}</td>
                    <td>{item.invitees}</td>
                    <td>{dateTime(item.inviterBoundAt ?? item.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {invitees.length === 0 && <Empty text="没有直属下线" />}
          </div>
          {inviteeCursor && <button className="load-more" onClick={() => void loadMoreInvitees()}>加载更多下线</button>}
        </div>
      )}

      {tab === 'orders' && (
        <div className="user-detail-body">
          <div className="table-wrap user-ledger-table">
            <table>
              <thead><tr><th>类型</th><th>金额</th><th>状态</th><th>详情</th><th>时间</th></tr></thead>
              <tbody>
                {orders.map((item) => (
                  <tr key={`${item.kind}-${item.id}`}>
                    <td>{item.kind === 'deposit' ? '充值' : '提现'}</td>
                    <td className="money">RM {rm(item.amountCents)}</td>
                    <td><Badge value={item.status} /></td>
                    <td>
                      {item.kind === 'deposit'
                        ? (item.payeeSnapshot
                          ? `${item.payeeSnapshot.bankName ?? ''} · ${item.payeeSnapshot.accountName ?? ''}`
                          : item.proofUrl ? '有凭证' : '—')
                        : <WithdrawOrderTarget item={item} />}
                    </td>
                    <td>{dateTime(item.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {orders.length === 0 && <Empty text="该用户暂无充提记录" />}
          </div>
        </div>
      )}
    </aside>
  );
}

function KycReview() {
  const [items, setItems] = useState<Row[]>([]);
  const load = () => request<{ items: Row[] }>('/api/admin/kyc?status=PENDING').then((result) => setItems(result.items));
  useEffect(() => { void load(); }, []);
  async function review(id: string, action: 'approve' | 'reject') {
    const reason = action === 'reject' ? prompt('驳回原因') ?? '资料不符' : undefined;
    await post(`/api/admin/kyc/${id}/review`, { action, reason }); await load();
  }
  return <section className="panel"><div className="panel-title"><div><small>实名队列</small><h2>待审核 {items.length} 人</h2></div></div>
    <div className="review-grid">{items.map((item) => <article className="review-card" key={item.id}><header><SupportAvatar url={item.avatarUrl} name={item.nickname} /><div><strong>{item.nickname}</strong><small>UID {item.uid}</small></div><Badge value={item.status} /></header><dl><div><dt>TNG 实名</dt><dd>{item.realName}</dd></div><div><dt>DuitNow</dt><dd>{item.duitnowId}</dd></div>{item.bankName ? <div><dt>历史银行</dt><dd>{item.bankName}</dd></div> : null}{item.bankAccount ? <div><dt>历史账号</dt><dd>{item.bankAccount}</dd></div> : null}</dl><footer><button className="danger" onClick={() => void review(item.id, 'reject')}>驳回</button><button className="success" onClick={() => void review(item.id, 'approve')}>审核通过</button></footer></article>)}</div>
    {items.length === 0 && <Empty text="实名审核队列已清空" />}
  </section>;
}

function Orders({ type }: { type: 'deposit' | 'withdraw' }) {
  const [items, setItems] = useState<Row[]>([]);
  const [error, setError] = useState('');
  const load = () => request<{ items: Row[] }>(`/api/admin/orders/${type}?status=PENDING`).then((result) => setItems(result.items)).catch((e) => setError((e as Error).message));
  useEffect(() => { void load(); }, [type]);
  async function review(id: string, action: 'complete' | 'reject') {
    const reason = action === 'reject' ? prompt('驳回原因') ?? '' : undefined;
    if (action === 'reject' && (!reason || reason.trim().length < 2)) return;
    try {
      setError('');
      await post(`/api/admin/orders/${type}/${id}/review`, { action, reason });
      await load();
    } catch (e) { setError((e as Error).message); }
  }
  async function viewProof(url: string) {
    try {
      setError('');
      await openProtectedUpload(url);
    } catch (e) { setError(`无法打开凭证：${(e as Error).message}`); }
  }
  return <section className="panel"><ErrorBox error={error} /><div className="table-wrap"><table><thead><tr><th>工单</th><th>用户</th><th>金额</th><th>{type === 'deposit' ? '收款 / 凭证' : '收款目标'}</th><th>提交时间</th><th>操作</th></tr></thead><tbody>
    {items.map((item) => <tr key={item.id}><td><strong>{item.id.slice(-8)}</strong><small><Badge value={item.status} /></small></td><td><strong>{item.user.nickname}</strong><small>UID {item.user.uid}</small></td><td className="money">RM {rm(item.amountCents)}</td><td>{type === 'deposit' ? <><strong>{item.payeeSnapshot ? `${item.payeeSnapshot.bankName} · ${item.payeeSnapshot.accountName}` : '—'}</strong><small>{item.payeeSnapshot?.accountNo ?? ''}</small>{item.proofUrl ? <button type="button" onClick={() => void viewProof(item.proofUrl)}>查看凭证 ↗</button> : <small>未上传</small>}</> : <WithdrawOrderTarget item={item} />}</td><td>{new Date(item.createdAt).toLocaleString('zh-MY')}</td><td className="actions"><button className="danger" onClick={() => void review(item.id, 'reject')}>驳回</button><button className="success" onClick={() => void review(item.id, 'complete')}>{type === 'deposit' ? '确认到账' : '确认已转账'}</button></td></tr>)}
  </tbody></table>{items.length === 0 && <Empty text="当前没有待处理工单" />}</div></section>;
}

function WithdrawAccountReview() {
  const [items, setItems] = useState<Row[]>([]);
  const [error, setError] = useState('');
  const load = () =>
    request<{ items: Row[] }>('/api/admin/withdraw-accounts?status=PENDING')
      .then((result) => setItems(result.items))
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    void load();
  }, []);

  async function review(id: string, action: 'approve' | 'reject') {
    const reason = action === 'reject' ? prompt('驳回原因') ?? '' : undefined;
    if (action === 'reject' && (!reason || reason.trim().length < 2)) return;
    try {
      setError('');
      await post(`/api/admin/withdraw-accounts/${id}/review`, { action, reason });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="panel">
      <ErrorBox error={error} />
      <div className="panel-title">
        <div>
          <small>绑定审核</small>
          <h2>待审核 {items.length} 个账户</h2>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>用户</th>
              <th>类型</th>
              <th>机构</th>
              <th>账号 / 户名</th>
              <th>提交时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  <strong>{item.user?.nickname ?? '—'}</strong>
                  <small>UID {item.user?.uid}</small>
                </td>
                <td>{item.type === 'BANK' ? '银行' : '电子钱包'}</td>
                <td>
                  <strong>{item.institution}</strong>
                </td>
                <td>
                  <strong>{item.accountNo}</strong>
                  <small>{item.accountName}</small>
                </td>
                <td>{new Date(item.createdAt).toLocaleString('zh-MY')}</td>
                <td className="actions">
                  <button className="danger" type="button" onClick={() => void review(item.id, 'reject')}>
                    驳回
                  </button>
                  <button className="success" type="button" onClick={() => void review(item.id, 'approve')}>
                    审核通过
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && <Empty text="暂无待审核的提现账户" />}
      </div>
    </section>
  );
}

function DepositPayees() {
  const emptyForm = { bankName: '', accountNo: '', accountName: '', label: '', isCurrent: true };
  const [items, setItems] = useState<Row[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    request<{ items: Row[] }>('/api/admin/deposit-payees')
      .then((result) => setItems(result.items))
      .catch((e) => setError((e as Error).message));

  useEffect(() => {
    void load();
  }, []);

  function startEdit(item: Row) {
    setEditingId(item.id);
    setForm({
      bankName: item.bankName ?? '',
      accountNo: item.accountNo ?? '',
      accountName: item.accountName ?? '',
      label: item.label ?? '',
      isCurrent: !!item.isCurrent,
    });
  }

  async function save() {
    if (!form.bankName || !form.accountNo || !form.accountName) return;
    setBusy(true);
    setError('');
    try {
      const body = {
        bankName: form.bankName.trim(),
        accountNo: form.accountNo.trim(),
        accountName: form.accountName.trim(),
        label: form.label.trim() || undefined,
        isCurrent: form.isCurrent,
        status: 'ACTIVE' as const,
      };
      if (editingId) await patch(`/api/admin/deposit-payees/${editingId}`, body);
      else await post('/api/admin/deposit-payees', body);
      setEditingId(null);
      setForm(emptyForm);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function activate(id: string) {
    setError('');
    try {
      await post(`/api/admin/deposit-payees/${id}/activate`, {});
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function toggleStatus(item: Row) {
    setError('');
    try {
      await patch(`/api/admin/deposit-payees/${item.id}`, {
        status: item.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE',
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(id: string) {
    if (!confirm('确认删除该收款账户？已产生的充值工单仍会保留提交时的账户快照。')) return;
    setError('');
    try {
      await del(`/api/admin/deposit-payees/${id}`);
      if (editingId === id) {
        setEditingId(null);
        setForm(emptyForm);
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <section className="panel inline-form">
        <header style={{ gridColumn: '1 / -1', marginBottom: 4 }}>
          <div>
            <small>{editingId ? '编辑收款账户' : '新增收款账户'}</small>
            <h2>{editingId ? '替换 / 修改账户信息' : '添加银行收款账户'}</h2>
          </div>
        </header>
        <input
          placeholder="银行名称（如 GX BANK）"
          value={form.bankName}
          onChange={(e) => setForm({ ...form, bankName: e.target.value })}
        />
        <input
          placeholder="银行账号"
          value={form.accountNo}
          onChange={(e) => setForm({ ...form, accountNo: e.target.value })}
        />
        <input
          placeholder="户名"
          value={form.accountName}
          onChange={(e) => setForm({ ...form, accountName: e.target.value })}
        />
        <input
          placeholder="备注（可选）"
          value={form.label}
          onChange={(e) => setForm({ ...form, label: e.target.value })}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={form.isCurrent}
            onChange={(e) => setForm({ ...form, isCurrent: e.target.checked })}
          />
          设为当前玩家可见收款账户
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="primary small"
            type="button"
            disabled={busy || !form.bankName || !form.accountNo || !form.accountName}
            onClick={() => void save()}
          >
            {busy ? '保存中…' : editingId ? '保存修改' : '添加账户'}
          </button>
          {editingId && (
            <button
              className="small"
              type="button"
              onClick={() => {
                setEditingId(null);
                setForm(emptyForm);
              }}
            >
              取消编辑
            </button>
          )}
        </div>
      </section>
      <ErrorBox error={error} />
      <section className="panel">
        <div className="panel-title">
          <div>
            <small>账户池</small>
            <h2>共 {items.length} 个收款账户</h2>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>银行 / 户名</th>
                <th>账号</th>
                <th>状态</th>
                <th>当前展示</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.bankName}</strong>
                    <small>
                      {item.accountName}
                      {item.label ? ` · ${item.label}` : ''}
                    </small>
                  </td>
                  <td>
                    <strong>{item.accountNo}</strong>
                  </td>
                  <td>
                    <Badge value={item.status} />
                  </td>
                  <td>{item.isCurrent ? <Badge value="ACTIVE" /> : <span>—</span>}</td>
                  <td className="actions">
                    {!item.isCurrent && item.status === 'ACTIVE' && (
                      <button type="button" onClick={() => void activate(item.id)}>
                        切换为当前
                      </button>
                    )}
                    <button type="button" onClick={() => startEdit(item)}>
                      编辑
                    </button>
                    <button type="button" onClick={() => void toggleStatus(item)}>
                      {item.status === 'ACTIVE' ? '停用' : '启用'}
                    </button>
                    <button className="danger" type="button" onClick={() => void remove(item.id)}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length === 0 && <Empty text="尚未配置收款账户，请先添加" />}
        </div>
      </section>
    </>
  );
}

function Rooms() {
  const [items, setItems] = useState<Row[]>([]);
  const load = () => request<{items: Row[]}>('/api/admin/games').then((games) => setItems(games.items));
  useEffect(() => { void load(); }, []);
  return <><div className="toolbar standalone"><div className="toolbar-hint"><small>游戏目录</small><span>一款游戏 = 一个互动群</span></div></div>
    <p style={{fontSize:13,color:'#6b7280',margin:'0 0 12px'}}>当前目录只有「至尊牛牛」。不能自由复制或改名创建其他群；以后新增互动群，必须先接入独立规则引擎与游戏代码。</p>
    <div className="room-grid">{items.map((game) => <article className="room-card" key={game.code}><header><div className="room-symbol"><img src="/logo.png" alt="" /></div><div><strong>{game.title}</strong><small>{game.interactionGroupTitle} · {game.code}</small></div><Badge value={game.room?.status ?? 'PAUSED'} /></header><div className="room-stats"><div><span>群成员</span><b>{game.room?.members ?? 0}</b></div><div><span>最低人数</span><b>{game.room?.minPlayers ?? '—'}</b></div><div><span>历史局数</span><b>{game.room?.rounds ?? 0}</b></div></div><footer>{game.room ? <><button onClick={async()=>{await patch(`/api/admin/rooms/${game.room.id}`,{status:game.room.status==='ACTIVE'?'PAUSED':'ACTIVE'});await load();}}>{game.room.status==='ACTIVE'?'暂停入口':'启用入口'}</button><button className="success" onClick={async()=>{await post(`/api/admin/rooms/${game.room.id}/start`,{force:true});alert('已开启竞标');}}>强制开局</button></> : <span>尚未建互动群</span>}</footer></article>)}</div>
    {items.length===0&&<Empty text="游戏目录为空" />}</>;
}

function Rounds({ canReconcile }: { canReconcile: boolean }) {
  type Filter = 'all' | 'SENDING_PACKET' | 'CLAIMING' | 'CLAIM_EXPIRED' | 'live';
  const [items, setItems] = useState<Row[]>([]);
  const [detail, setDetail] = useState<Row | null>(null);
  const [accounts, setAccounts] = useState<Row[]>([]);
  const [filter, setFilter] = useState<Filter>('live');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [claimUrl, setClaimUrl] = useState('');
  const [packerAccount, setPackerAccount] = useState('');
  const [claimDrafts, setClaimDrafts] = useState<Record<string, { tngName: string; amount: string }>>({});
  const [cancelReason, setCancelReason] = useState('');
  const [returnAmount, setReturnAmount] = useState('');

  const load = async () => {
    const [rounds, tng] = await Promise.all([
      request<{ items: Row[] }>('/api/admin/rounds?limit=100'),
      request<{ items: Row[] }>('/api/admin/tng/accounts'),
    ]);
    setItems(rounds.items);
    const active = tng.items.filter((item) => item.status === 'ACTIVE');
    setAccounts(active);
    setPackerAccount((prev) => prev || active[0]?.id || '');
  };

  const open = async (id: string) => {
    const next = await request<Row>(`/api/admin/rounds/${id}`);
    setDetail(next);
    setError('');
    setClaimUrl('');
    setCancelReason('');
    setReturnAmount('');
    const drafts: Record<string, { tngName: string; amount: string }> = {};
    const bankerBid = next.bids?.find((b: Row) => b.userId === next.bankerId);
    if (next.bankerId) {
      drafts[next.bankerId] = {
        tngName: next.claims?.find((c: Row) => c.userId === next.bankerId)?.tngName
          ?? bankerBid?.user?.nickname
          ?? '',
        amount: next.claims?.find((c: Row) => c.userId === next.bankerId)
          ? rm(next.claims.find((c: Row) => c.userId === next.bankerId).amountCents)
          : '',
      };
    }
    for (const bet of (next.bets ?? []).filter((b: Row) => b.status === 'FROZEN')) {
      const claim = next.claims?.find((c: Row) => c.userId === bet.userId);
      drafts[bet.userId] = {
        tngName: claim?.tngName ?? bet.user?.nickname ?? '',
        amount: claim ? rm(claim.amountCents) : '',
      };
    }
    setClaimDrafts(drafts);
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!detail) return;
    const still = items.find((item) => item.id === detail.id);
    if (still && still.phase !== detail.phase) void open(detail.id);
  }, [items, detail?.id, detail?.phase]);

  const filtered = items.filter((round) => {
    if (filter === 'all') return true;
    if (filter === 'live') {
      return !['FINISHED', 'CANCELLED', 'WAITING'].includes(round.phase);
    }
    if (filter === 'CLAIMING') return ['CLAIMING', 'CLAIM_EXPIRED'].includes(round.phase);
    return round.phase === filter;
  });

  const pendingSend = items.filter((r) => r.phase === 'SENDING_PACKET').length;
  const pendingClaim = items.filter((r) => ['CLAIMING', 'CLAIM_EXPIRED'].includes(r.phase)).length;
  const frozenBets = detail?.bets?.filter((b: Row) => b.status === 'FROZEN') ?? [];
  const expectedClaims = (detail?.bankerId ? 1 : 0) + frozenBets.length;
  const claimReview = !!detail && ['CLAIMING', 'CLAIM_EXPIRED'].includes(detail.phase);
  const claimReady = claimReview && detail.claims.length === expectedClaims && expectedClaims > 0;

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await task();
      if (detail) await open(detail.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function action(name: string, extra: Row = {}) {
    if (!detail) return;
    await run(async () => {
      await post(`/api/admin/rounds/${detail.id}/action`, { action: name, ...extra });
    });
  }

  async function submitPacket() {
    if (!detail) return;
    if (!claimUrl.trim()) {
      setError('请粘贴 TNG Money Packet 链接');
      return;
    }
    if (!packerAccount) {
      setError('请先在 TNG 红包台账添加启用的发包账号');
      return;
    }
    await run(async () => {
      await post(`/api/admin/rounds/${detail.id}/packet`, {
        claimUrl: claimUrl.trim(),
        packerAccount,
      });
      setClaimUrl('');
    });
  }

  async function submitClaim(userId: string, force = false, reason = '') {
    if (!detail) return;
    const draft = claimDrafts[userId];
    if (!draft?.tngName.trim() || !draft.amount.trim()) {
      setError('请填写 TNG 显示姓名与领取金额');
      return;
    }
    await run(async () => {
      try {
        await post(`/api/admin/rounds/${detail.id}/claims`, {
          userId,
          tngName: draft.tngName.trim(),
          amountCents: toCents(draft.amount),
          forceMatch: force,
          matchOverrideReason: reason || undefined,
        });
      } catch (e) {
        if ((e as { code?: string }).code !== 'TNG_NAME_MISMATCH') throw e;
        const override = window.prompt('姓名与实名不一致。如确认归属，请填写强制匹配原因（至少 4 字）') ?? '';
        if (override.trim().length < 4) throw e;
        await post(`/api/admin/rounds/${detail.id}/claims`, {
          userId,
          tngName: draft.tngName.trim(),
          amountCents: toCents(draft.amount),
          forceMatch: true,
          matchOverrideReason: override.trim(),
        });
      }
    });
  }

  async function correctClaimEntry(entry: Row) {
    if (!detail) return;
    const draft = claimDrafts[entry.userId] ?? { tngName: entry.tngName ?? '', amount: rm(entry.amountCents) };
    const reason = window.prompt('更正原因（必填，至少 4 字）') ?? '';
    if (reason.trim().length < 4) return;
    await run(async () => {
      try {
        await post(`/api/admin/claims/${entry.id}/correct`, {
          tngName: draft.tngName.trim(),
          amountCents: toCents(draft.amount),
          reason: reason.trim(),
          forceMatch: false,
        });
      } catch (e) {
        if ((e as { code?: string }).code !== 'TNG_NAME_MISMATCH') throw e;
        if (!confirm('姓名与实名不一致，确定强制更正归属？')) return;
        await post(`/api/admin/claims/${entry.id}/correct`, {
          tngName: draft.tngName.trim(),
          amountCents: toCents(draft.amount),
          reason: reason.trim(),
          forceMatch: true,
        });
      }
    });
  }

  async function forfeit(userId: string) {
    if (!detail || !confirm('确认该玩家未领取并按弃权处理？下注冻结将原路退回。')) return;
    await run(async () => {
      await post(`/api/admin/rounds/${detail.id}/forfeit`, { userId });
    });
  }

  async function reconcileReturn() {
    if (!detail?.packet || !returnAmount.trim()) return;
    await run(async () => {
      await post(`/api/admin/packets/${detail.packet.id}/reconcile-return`, {
        returnedCents: toCents(returnAmount),
      });
      setReturnAmount('');
    });
  }

  function setDraft(userId: string, patch: Partial<{ tngName: string; amount: string }>) {
    setClaimDrafts((prev) => ({
      ...prev,
      [userId]: { tngName: prev[userId]?.tngName ?? '', amount: prev[userId]?.amount ?? '', ...patch },
    }));
  }

  const bankerName =
    detail?.bids?.find((b: Row) => b.userId === detail.bankerId)?.user?.nickname
    ?? detail?.bankerId?.slice(-6)
    ?? '—';

  return (
    <>
      <section className="panel round-console-bar">
        <div className="round-filter-chips">
          {([
            ['live', `进行中`],
            ['SENDING_PACKET', `待发包 ${pendingSend}`],
            ['CLAIMING', `认额中 ${pendingClaim}`],
            ['all', '全部'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={filter === key ? 'active' : ''}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="small" disabled={busy} onClick={() => void load()}>刷新</button>
        <p>
          运营流程：封盘后在 TNG App 创建红包 → 本台粘贴链接发包 → 玩家抢包 → 对照 History 录入认额 → 复核结算。
          互动群内「小助手」会自动播报等待发包 / 开始抢包 / 成绩单。
        </p>
      </section>

      <div className="split-view">
        <section className="panel">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>局号</th>
                  <th>房间</th>
                  <th>阶段</th>
                  <th>庄池</th>
                  <th>红包</th>
                  <th>认额</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((round) => (
                  <tr
                    className={detail?.id === round.id ? 'selected' : ''}
                    key={round.id}
                    onClick={() => void open(round.id)}
                  >
                    <td>
                      <strong>#{round.seqNo}</strong>
                      <small>{round.id.slice(-8)}</small>
                    </td>
                    <td>{round.room.title}</td>
                    <td><Badge value={round.phase} /></td>
                    <td>RM {rm(round.potCents)}</td>
                    <td>RM {rm(round.packet?.totalCents ?? 0)}</td>
                    <td>{round._count.claims}/{round.packet?.participantCount ?? '—'}</td>
                    <td>{new Date(round.createdAt).toLocaleString('zh-MY')}</td>
                  </tr>
                ))}
                {!filtered.length && (
                  <tr>
                    <td colSpan={7}><Empty text="当前筛选下暂无牌局" /></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="detail-drawer">
          {!detail ? (
            <Empty text="选择一局进入对局控制台" />
          ) : (
            <>
              <header>
                <div>
                  <small>对局控制台</small>
                  <h2>第 {detail.seqNo} 局</h2>
                </div>
                <Badge value={detail.phase} />
              </header>
              <ErrorBox error={error} />

              <dl className="round-meta">
                <div><dt>互动群</dt><dd>{detail.room?.title ?? '—'}</dd></div>
                <div><dt>庄家</dt><dd>{bankerName}</dd></div>
                <div><dt>庄池</dt><dd>RM {rm(detail.potCents)}</dd></div>
                <div><dt>冻结</dt><dd>RM {rm(detail.bankerReservedCents)}</dd></div>
                <div><dt>红包总额</dt><dd>RM {rm(detail.packet?.totalCents ?? 0)}</dd></div>
                <div><dt>认额进度</dt><dd>{detail.claims.length}/{detail.packet?.participantCount ?? (expectedClaims || '—')}</dd></div>
              </dl>

              <div className="round-actions">
                {detail.phase === 'BANKER_BID' && (
                  <button type="button" disabled={busy} onClick={() => void action('close_bidding')}>立即结束竞标</button>
                )}
                {detail.phase === 'BETTING' && (
                  <button type="button" disabled={busy} onClick={() => void action('close_betting')}>立即封盘</button>
                )}
                {claimReady && (
                  <button
                    type="button"
                    className="success"
                    disabled={busy}
                    onClick={() => {
                      if (confirm('已复核全部 TNG 姓名与金额，确认结算并公布成绩单？')) {
                        void action('settle');
                      }
                    }}
                  >
                    复核并结算
                  </button>
                )}
                {!['FINISHED', 'CANCELLED', 'SETTLING'].includes(detail.phase) && (
                  <button
                    type="button"
                    className="danger"
                    disabled={busy || cancelReason.trim().length < 2}
                    onClick={() => void action('cancel', { reason: cancelReason.trim() })}
                  >
                    取消本局并退款
                  </button>
                )}
              </div>

              {!['FINISHED', 'CANCELLED', 'SETTLING'].includes(detail.phase) && (
                <div className="round-form-block">
                  <label>取消原因</label>
                  <input
                    placeholder="至少 2 字，例如：红包链接失效"
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                  />
                </div>
              )}

              {detail.phase === 'SENDING_PACKET' && (
                <div className="round-form-block highlight">
                  <h3>① 登记并发送红包</h3>
                  <p>
                    请在发包账号的 TNG App 创建 Money Packet：总额 <strong>RM {rm(detail.packet?.totalCents ?? 0)}</strong>
                    ，个数 <strong>{detail.packet?.participantCount ?? '—'}</strong>。
                    创建后粘贴链接，互动群小助手会推送「开始抢包」。
                  </p>
                  <label>TNG 红包链接</label>
                  <input
                    placeholder="https://…（Money Packet 分享链接）"
                    value={claimUrl}
                    onChange={(e) => setClaimUrl(e.target.value)}
                  />
                  <label>发包账号</label>
                  <select value={packerAccount} onChange={(e) => setPackerAccount(e.target.value)}>
                    {!accounts.length && <option value="">请先添加发包账号</option>}
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.label} · {account.maskedId ?? account.accountName}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="primary small"
                    disabled={busy || !claimUrl.trim() || !packerAccount}
                    onClick={() => void submitPacket()}
                  >
                    登记并推送到互动群
                  </button>
                </div>
              )}

              {claimReview && (
                <div className="round-form-block">
                  <h3>② 对照 History 录入认额</h3>
                  <p>打开发包账号「Money Packet History」，按姓名匹配玩家后录入金额。全部录入后可结算。</p>
                </div>
              )}

              <h3 className="drawer-title">参与者与认额</h3>
              <div className="participant-list claim-console">
                {detail.bankerId && (
                  <div className="claim-row">
                    <span className="role banker">庄</span>
                    <strong>
                      {bankerName}
                      <small>庄家 · 须领取</small>
                    </strong>
                    {detail.claims.some((c: Row) => c.userId === detail.bankerId) ? (
                      <div className="claim-done">
                        <Badge value="COMPLETED" />
                        {claimReview && (
                          <button type="button" disabled={busy} onClick={() => void correctClaimEntry(detail.claims.find((c: Row) => c.userId === detail.bankerId))}>
                            更正
                          </button>
                        )}
                      </div>
                    ) : claimReview ? (
                      <div className="claim-inputs">
                        <input
                          placeholder="TNG 姓名"
                          value={claimDrafts[detail.bankerId]?.tngName ?? ''}
                          onChange={(e) => setDraft(detail.bankerId, { tngName: e.target.value })}
                        />
                        <input
                          placeholder="金额 RM"
                          value={claimDrafts[detail.bankerId]?.amount ?? ''}
                          onChange={(e) => setDraft(detail.bankerId, { amount: e.target.value })}
                        />
                        <button type="button" className="primary small" disabled={busy} onClick={() => void submitClaim(detail.bankerId)}>
                          录入
                        </button>
                      </div>
                    ) : (
                      <Badge value="MISSING" />
                    )}
                  </div>
                )}

                {frozenBets.map((bet: Row) => {
                  const claim = detail.claims.find((c: Row) => c.userId === bet.userId);
                  return (
                    <div className="claim-row" key={bet.id}>
                      <span className="role">闲</span>
                      <strong>
                        {bet.user.nickname}
                        <small>{bet.isAllIn ? '梭哈' : '下注'} RM {rm(bet.amountCents)}</small>
                      </strong>
                      {claim ? (
                        <div className="claim-done">
                          <Badge value="COMPLETED" />
                          <em>RM {rm(claim.amountCents)}</em>
                          {claimReview && (
                            <button type="button" disabled={busy} onClick={() => void correctClaimEntry(claim)}>
                              更正
                            </button>
                          )}
                        </div>
                      ) : claimReview ? (
                        <div className="claim-inputs">
                          <input
                            placeholder="TNG 姓名"
                            value={claimDrafts[bet.userId]?.tngName ?? ''}
                            onChange={(e) => setDraft(bet.userId, { tngName: e.target.value })}
                          />
                          <input
                            placeholder="金额 RM"
                            value={claimDrafts[bet.userId]?.amount ?? ''}
                            onChange={(e) => setDraft(bet.userId, { amount: e.target.value })}
                          />
                          <button type="button" className="primary small" disabled={busy} onClick={() => void submitClaim(bet.userId)}>
                            录入
                          </button>
                          <button type="button" className="danger" disabled={busy} onClick={() => void forfeit(bet.userId)}>
                            弃权
                          </button>
                        </div>
                      ) : (
                        <Badge value="MISSING" />
                      )}
                    </div>
                  );
                })}
              </div>

              {canReconcile && detail.phase === 'FINISHED' && detail.packet
                && BigInt(String(detail.packet.reconciledCents ?? 0)) + BigInt(String(detail.packet.returnedCents ?? 0))
                  < BigInt(String(detail.packet.totalCents ?? 0)) && (
                <div className="round-form-block">
                  <h3>登记 TNG 退回</h3>
                  <input
                    placeholder={`未核销上限 RM ${rm(BigInt(String(detail.packet.totalCents)) - BigInt(String(detail.packet.reconciledCents ?? 0)))}`}
                    value={returnAmount}
                    onChange={(e) => setReturnAmount(e.target.value)}
                  />
                  <button type="button" disabled={busy || !returnAmount.trim()} onClick={() => void reconcileReturn()}>
                    确认退回金额
                  </button>
                </div>
              )}
            </>
          )}
        </aside>
      </div>
    </>
  );
}

function Tng({ canReconcile }: { canReconcile: boolean }) {
  const [accounts,setAccounts]=useState<Row[]>([]);const [packets,setPackets]=useState<Row[]>([]);const [form,setForm]=useState({label:'',accountName:'',maskedId:'',monthlyLimitCents:''});
  const load=()=>Promise.all([request<{items:Row[]}>('/api/admin/tng/accounts'),request<{items:Row[]}>('/api/admin/tng/reconciliation')]).then(([a,p])=>{setAccounts(a.items);setPackets(p.items);});
  useEffect(()=>{void load();},[]);
  async function add(){await post('/api/admin/tng/accounts',{...form,monthlyLimitCents:form.monthlyLimitCents?toCents(form.monthlyLimitCents):undefined});setForm({label:'',accountName:'',maskedId:'',monthlyLimitCents:''});await load();}
  async function reconcileCancelled(packet:Row){const claimed=prompt('实际已领取累计金额（RM）',rm(packet.reconciledCents??0));const returned=prompt('TNG 实际退回累计金额（RM）',rm(packet.returnedCents??0));if(claimed===null||returned===null)return;await post(`/api/admin/packets/${packet.id}/reconcile-cancelled`,{claimedCents:toCents(claimed),returnedCents:toCents(returned)});await load();}
  return <><section className="panel inline-form"><input placeholder="账号标签" value={form.label} onChange={e=>setForm({...form,label:e.target.value})}/><input placeholder="TNG 户名" value={form.accountName} onChange={e=>setForm({...form,accountName:e.target.value})}/><input placeholder="账号尾号" value={form.maskedId} onChange={e=>setForm({...form,maskedId:e.target.value})}/><input placeholder="月限额 RM" value={form.monthlyLimitCents} onChange={e=>setForm({...form,monthlyLimitCents:e.target.value})}/><button className="primary small" onClick={()=>void add()}>添加发包账号</button></section><section className="panel"><div className="account-chips">{accounts.map(a=><div key={a.id}><span><i/> {a.label}</span><strong>{a.accountName}</strong><small>{a.maskedId||'未填尾号'} · 月限额 {a.monthlyLimitCents?`RM ${rm(a.monthlyLimitCents)}`:'未设置'}</small><footer><Badge value={a.status}/><button onClick={async()=>{await patch(`/api/admin/tng/accounts/${a.id}`,{status:a.status==='ACTIVE'?'DISABLED':'ACTIVE'});await load();}}>{a.status==='ACTIVE'?'停用':'启用'}</button></footer></div>)}</div></section><section className="panel"><div className="panel-title"><div><small>红包台账</small><h2>红包对账</h2></div></div><div className="table-wrap"><table><thead><tr><th>局号</th><th>房间</th><th>总额</th><th>已领取</th><th>已退回</th><th>领取人数</th><th>状态</th><th>操作</th></tr></thead><tbody>{packets.map(p=><tr key={p.id}><td>#{p.round.seqNo}</td><td>{p.round.room.title}</td><td>RM {rm(p.totalCents)}</td><td>RM {rm(p.reconciledCents)}</td><td>RM {rm(p.returnedCents??0)}</td><td>{p.claims.length}/{p.participantCount}</td><td><Badge value={p.status}/></td><td>{canReconcile&&p.round.phase==='CANCELLED'&&BigInt(String(p.reconciledCents??0))+BigInt(String(p.returnedCents??0))<BigInt(String(p.totalCents))?<button onClick={()=>void reconcileCancelled(p)}>核销取消包</button>:(p.sentAt?new Date(p.sentAt).toLocaleString('zh-MY'):'—')}</td></tr>)}</tbody></table></div></section></>;
}

function Finance() {
  const today=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Kuala_Lumpur'});
  const [accounts,setAccounts]=useState<Row[]>([]);const [ledger,setLedger]=useState<Row[]>([]);const [uid,setUid]=useState('');const [amount,setAmount]=useState('');const [direction,setDirection]=useState('credit');const [reason,setReason]=useState('');
  const [reportDate,setReportDate]=useState(today);const [report,setReport]=useState<Row|null>(null);
  const load=()=>Promise.all([request<Row>('/api/admin/finance/accounts'),request<{items:Row[]}>('/api/admin/finance/ledger?limit=200')]).then(([a,l])=>{setAccounts(a.accounts);setLedger(l.items);});
  useEffect(()=>{void load();},[]);
  useEffect(()=>{request<Row>(`/api/admin/finance/daily-report?date=${reportDate}`).then(setReport).catch(()=>setReport(null));},[reportDate]);
  async function adjust(){
    try {
      await post('/api/admin/finance/adjust',{uid,direction,amountCents:toCents(amount),reason});
      setAmount('');setReason('');await load();
    } catch(e){ alert(`调账失败：${(e as Error).message}`); }
  }
  const reportRows: Array<[string,string]> = report ? [
    ['已结算局数', `${report.settledRounds} 局（取消 ${report.cancelledRounds} 局）`],
    ['投注流水', `RM ${rm(report.betsCents)}`],
    ['闲家赔付', `RM ${rm(report.payoutsCents)}（免赔 RM ${rm(report.shortfallCents)}）`],
    ['抽水收入', `RM ${rm(report.rakeCents)}`],
    ['上庄费', `RM ${rm(report.seatFeeCents)}`],
    ['服务费', `RM ${rm(report.serviceFeeCents)}`],
    ['代包费', `RM ${rm(report.packetFeeCents)}`],
    ['奖励支出', `RM ${rm(report.rewardsPaidCents)}`],
    ['返水支出', `RM ${rm(report.rebatesPaidCents)}`],
    ['充值入账', `RM ${rm(report.depositsCents)}（${report.depositsCount} 单）`],
    ['提现出账', `RM ${rm(report.withdrawalsCents)}（${report.withdrawalsCount} 单）`],
    ['红包在途差异', `RM ${rm(report.packetOutstandingCents)}（${report.packetOutstandingCount} 包）`],
  ] : [];
  return <><div className="stats-grid finance-stats">{accounts.map(a=><Stat key={a.id} label={a.accountType} value={`RM ${rm(a.balanceCents)}`} hint="平台逻辑科目" tone={a.balanceCents<0?'red':'jade'}/>)}</div>
    <section className="panel"><div className="panel-title"><div><small>日报</small><h2>财务日报</h2></div><input type="date" value={reportDate} onChange={e=>setReportDate(e.target.value)}/></div>
      {report?<div className="table-wrap report-table"><table><tbody>{reportRows.map(([label,value])=><tr key={label}><td>{label}</td><td className="money">{value}</td></tr>)}</tbody></table></div>:<Empty text="该业务日暂无数据"/>}
    </section>
    <section className="panel"><div className="panel-title"><div><small>人工调账</small><h2>余额调整</h2></div><span>调账会写入审计日志</span></div><div className="inline-form"><input placeholder="用户 UID" value={uid} onChange={e=>setUid(e.target.value)}/><select value={direction} onChange={e=>setDirection(e.target.value)}><option value="credit">增加余额</option><option value="debit">扣减余额</option></select><input placeholder="金额 RM" value={amount} onChange={e=>setAmount(e.target.value)}/><input placeholder="调账原因（必填）" value={reason} onChange={e=>setReason(e.target.value)}/><button className="primary small" disabled={!uid||!amount||reason.length<4} onClick={()=>void adjust()}>执行调账</button></div></section><section className="panel"><div className="panel-title"><div><small>全量流水</small><h2>钱包台账</h2></div><span>最近 200 条</span></div><div className="table-wrap"><table><thead><tr><th>时间</th><th>科目</th><th>方向</th><th>金额</th><th>业务</th><th>关联局</th><th>备注</th></tr></thead><tbody>{ledger.map(l=><tr key={l.id}><td>{new Date(l.createdAt).toLocaleString('zh-MY')}</td><td>{l.accountType}</td><td className={l.direction==='CREDIT'?'positive':'negative'}>{l.direction}</td><td>RM {rm(l.amountCents)}</td><td>{l.refType}</td><td>{l.roundId?.slice(-8)??'—'}</td><td>{l.memo??'—'}</td></tr>)}</tbody></table></div></section></>;
}

function RewardsAdmin() {
  return (
    <div className="legacy-game-scope">
      <div className="toolbar standalone">
        <div className="toolbar-hint">
          <small>每日奖励</small>
          <span>已改为表单填写；建议在「游戏运营中心 → 每日奖励」管理</span>
        </div>
      </div>
      <GameRewardsAdmin gameCode={DEFAULT_GAME_CODE} />
    </div>
  );
}

function Rebates() {
  const today=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Kuala_Lumpur'});const [date,setDate]=useState(today);const [items,setItems]=useState<Row[]>([]);
  const load=()=>request<{items:Row[]}>(`/api/admin/rebates?date=${date}`).then(r=>setItems(r.items));
  useEffect(()=>{void load();},[date]);
  return <><div className="toolbar standalone"><div className="toolbar-hint"><small>业务日</small><span>三级有效流水与佣金日结</span></div><input type="date" value={date} onChange={e=>setDate(e.target.value)}/><button className="primary small" onClick={async()=>{await post('/api/admin/rebates/settle',{settlementDate:date});await load();}}>执行日结</button></div><section className="panel"><div className="table-wrap"><table><thead><tr><th>玩家</th><th>自身流水</th><th>直属流水</th><th>二级流水</th><th>佣金</th><th>状态</th></tr></thead><tbody>{items.map(i=><tr key={i.id}><td>{i.user.nickname}<small>UID {i.user.uid}</small></td><td>RM {rm(i.selfCents)}</td><td>RM {rm(i.l1Cents)}</td><td>RM {rm(i.l2Cents)}</td><td className="money">RM {rm(i.commissionCents)}</td><td><Badge value={i.status}/></td></tr>)}</tbody></table>{items.length===0&&<Empty text="该业务日尚无返水结算" />}</div></section></>;
}

function LeaderboardsAdmin() {
  return (
    <div className="legacy-game-scope">
      <div className="toolbar standalone">
        <div className="toolbar-hint">
          <small>排行榜</small>
          <span>已改为表单发放；建议在「游戏运营中心 → 排行榜」管理</span>
        </div>
      </div>
      <GameLeaderboardsAdmin gameCode={DEFAULT_GAME_CODE} />
    </div>
  );
}

function PushCenter() {
  const [jobs,setJobs]=useState<Row[]>([]);const [templates,setTemplates]=useState<Row[]>([]);const [rooms,setRooms]=useState<Row[]>([]);
  const [body,setBody]=useState('');const [audience,setAudience]=useState('all');const [uids,setUids]=useState('');const [roomId,setRoomId]=useState('');const [templateId,setTemplateId]=useState('');const [scheduledAt,setScheduledAt]=useState('');
  const audienceLabel:Record<string,string>={all:'全部用户',kyc_approved:'已实名',uids:'指定 UID',room:'指定房间'};
  const load=()=>Promise.all([request<{items:Row[]}>('/api/admin/push/jobs'),request<{items:Row[]}>('/api/admin/push/templates'),request<{items:Row[]}>('/api/admin/rooms')]).then(([a,b,c])=>{setJobs(a.items);setTemplates(b.items);setRooms(c.items);});
  useEffect(()=>{void load();},[]);
  async function send(){
    await post('/api/admin/push/jobs',{
      templateId:templateId||undefined,
      audience:{type:audience,uids:audience==='uids'?uids.split(/[\s,]+/).filter(Boolean):undefined,roomId:audience==='room'?roomId:undefined},
      payload:body?{body}:{},
      scheduledAt:scheduledAt?new Date(scheduledAt).toISOString():undefined,
    });
    setBody('');setScheduledAt('');setTimeout(()=>void load(),800);
  }
  async function editTemplate(item?:Row){
    const code=prompt('模板代码（小写字母/数字/下划线）',item?.code??'')??'';
    const title=prompt('模板名称',item?.title??'')??'';
    const tplBody=prompt('模板内容（支持 {{变量}}）',item?.body??'')??'';
    if(!code||!title||!tplBody)return;
    await post('/api/admin/push/templates',{code,title,body:tplBody});await load();
  }
  const canSend=(templateId||body)&&(audience!=='room'||roomId)&&(audience!=='uids'||uids.trim());
  return <>
    <section className="panel push-compose"><div><small>新建推送</small><h2>创建运营推送</h2></div>
      <textarea value={body} onChange={e=>setBody(e.target.value)} placeholder={templateId?'选择模板后可留空，或输入变量替换内容…':'输入将通过 Telegram Bot 发送的内容…'} />
      <div className="inline-form">
        <select value={templateId} onChange={e=>setTemplateId(e.target.value)}><option value="">不使用模板</option>{templates.map(t=><option value={t.id} key={t.id}>{t.title}</option>)}</select>
        <select value={audience} onChange={e=>setAudience(e.target.value)}><option value="all">全部用户</option><option value="kyc_approved">已实名用户</option><option value="uids">指定 UID</option><option value="room">指定房间成员</option></select>
        {audience==='uids'&&<input value={uids} onChange={e=>setUids(e.target.value)} placeholder="多个 UID 用逗号分隔"/>}
        {audience==='room'&&<select value={roomId} onChange={e=>setRoomId(e.target.value)}><option value="">选择房间</option>{rooms.map(r=><option value={r.id} key={r.id}>{r.title}</option>)}</select>}
        <input type="datetime-local" value={scheduledAt} onChange={e=>setScheduledAt(e.target.value)} title="留空立即发送"/>
        <button className="primary small" disabled={!canSend} onClick={()=>void send()}>{scheduledAt?'定时推送':'立即推送'}</button>
      </div>
    </section>
    <section className="panel"><div className="panel-title"><div><small>模板库</small><h2>推送模板</h2></div><button className="primary small" onClick={()=>void editTemplate()}>＋ 新建模板</button></div>
      <div className="table-wrap"><table><thead><tr><th>代码</th><th>名称</th><th>内容</th><th>操作</th></tr></thead><tbody>{templates.map(t=><tr key={t.id}><td><code>{t.code}</code></td><td>{t.title}</td><td className="truncate">{t.body}</td><td><button onClick={()=>void editTemplate(t)}>编辑</button></td></tr>)}</tbody></table>{templates.length===0&&<Empty text="暂无模板，业务事件将使用内置文案"/>}</div>
    </section>
    <section className="panel"><div className="panel-title"><div><small>任务队列</small><h2>推送任务</h2></div></div>
      <div className="table-wrap"><table><thead><tr><th>创建时间</th><th>人群</th><th>内容</th><th>定时</th><th>状态</th><th>日志</th><th>操作</th></tr></thead><tbody>{jobs.map(j=><tr key={j.id}><td>{new Date(j.createdAt).toLocaleString('zh-MY')}</td><td>{audienceLabel[j.audience.type]??j.audience.type}</td><td className="truncate">{j.template?.title??j.payload.body}</td><td>{j.scheduledAt?new Date(j.scheduledAt).toLocaleString('zh-MY'):'立即'}</td><td><Badge value={j.status}/></td><td>{j._count.logs}</td><td><button onClick={async()=>{await post(`/api/admin/push/jobs/${j.id}/retry`,{});setTimeout(()=>void load(),600);}}>重试</button></td></tr>)}</tbody></table></div>
    </section>
  </>;
}

function Announcements() {
  const [items,setItems]=useState<Row[]>([]);const [title,setTitle]=useState('');const [body,setBody]=useState('');const [pinOnCreate,setPinOnCreate]=useState(true);
  const load=()=>request<{items:Row[]}>('/api/admin/announcements').then(r=>setItems(r.items));
  useEffect(()=>{void load();},[]);
  async function create(){await post('/api/admin/announcements',{title,body,publishNow:true,pinned:pinOnCreate});setTitle('');setBody('');await load();}
  return <>
    <section className="panel" style={{padding:'12px 16px',marginBottom:14}}>
      <p style={{margin:0,color:'#98988e',fontSize:12,lineHeight:1.55}}>已发布且勾选「置顶」的公告，会作为互动群「置顶小通告」展示（最多 7 条）。可用于认包提示、防诈说明等。</p>
    </section>
    <section className="panel inline-form announcement-form">
      <input value={title} onChange={e=>setTitle(e.target.value)} placeholder="公告标题"/>
      <input value={body} onChange={e=>setBody(e.target.value)} placeholder="公告正文"/>
      <label style={{display:'flex',alignItems:'center',gap:6,fontSize:12,whiteSpace:'nowrap'}}>
        <input type="checkbox" checked={pinOnCreate} onChange={e=>setPinOnCreate(e.target.checked)}/> 发布为互动群置顶
      </label>
      <button className="primary small" disabled={!title||!body} onClick={()=>void create()}>发布公告</button>
    </section>
    <div className="announcement-admin-grid">{items.map(item=><article className="panel" key={item.id}><header><Badge value={item.status}/><time>{new Date(item.createdAt).toLocaleString('zh-MY')}</time></header><h3>{item.title}</h3><p>{item.body}</p><footer><label><input type="checkbox" checked={item.pinned} onChange={async(e)=>{await patch(`/api/admin/announcements/${item.id}`,{pinned:e.target.checked});await load();}}/> 置顶</label><button onClick={async()=>{await patch(`/api/admin/announcements/${item.id}`,{status:item.status==='PUBLISHED'?'ARCHIVED':'PUBLISHED'});await load();}}>{item.status==='PUBLISHED'?'下架':'发布'}</button></footer></article>)}</div>
    {items.length===0&&<Empty text="暂无公告，发布后会展示在大厅 Banner" />}
  </>;
}

function SystemNoticesAdmin() {
  const [items, setItems] = useState<Row[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<'ALL' | 'KYC_APPROVED' | 'UIDS'>('ALL');
  const [uidsText, setUidsText] = useState('');
  const [pushTelegram, setPushTelegram] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => request<{ items: Row[] }>('/api/admin/notices').then((r) => setItems(r.items));
  useEffect(() => { void load(); }, []);

  async function create() {
    setBusy(true); setMessage('');
    try {
      const uids = uidsText.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean);
      const result = await post<{ ok: boolean; push: { total: number; success: number } | null }>('/api/admin/notices', {
        title, body, audience, uids, publishNow: true, pushTelegram,
      });
      setTitle(''); setBody(''); setUidsText(''); setPushTelegram(false);
      if (result.push) setMessage(`已发布；Telegram 推送 ${result.push.success}/${result.push.total}`);
      else setMessage('已发布到小程序系统通知');
      await load();
    } catch (e) {
      setMessage(`发送失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const audienceLabel = (value: string) => badgeLabels[value] ?? value;

  return (
    <>
      <section className="panel inline-form announcement-form" style={{ display: 'grid', gap: 10 }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="通知标题" />
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="通知正文（支持多行）" rows={4} style={{ resize: 'vertical', minHeight: 88 }} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <label>
            受众{' '}
            <select value={audience} onChange={(e) => setAudience(e.target.value as typeof audience)}>
              <option value="ALL">全部用户</option>
              <option value="KYC_APPROVED">已实名用户</option>
              <option value="UIDS">指定 UID</option>
            </select>
          </label>
          <label>
            <input type="checkbox" checked={pushTelegram} onChange={(e) => setPushTelegram(e.target.checked)} /> 同步 Telegram 私聊
          </label>
          <button className="primary small" disabled={busy || !title || !body || (audience === 'UIDS' && !uidsText.trim())} onClick={() => void create()}>
            {busy ? '发送中…' : '发布通知'}
          </button>
        </div>
        {audience === 'UIDS' && (
          <input value={uidsText} onChange={(e) => setUidsText(e.target.value)} placeholder="UID，逗号或空格分隔" />
        )}
        {message && <p className="muted">{message}</p>}
      </section>
      <div className="announcement-admin-grid">
        {items.map((item) => (
          <article className="panel" key={item.id}>
            <header>
              <Badge value={item.status} />
              <Badge value={item.audience} />
              <time>{new Date(item.publishedAt ?? item.createdAt).toLocaleString('zh-MY')}</time>
            </header>
            <h3>{item.title}</h3>
            <p style={{ whiteSpace: 'pre-wrap' }}>{item.body}</p>
            <footer>
              <small>已读 {item._count?.reads ?? 0} · {audienceLabel(item.audience)}{item.pushTelegram ? ' · 已推 TG' : ''}</small>
              <button onClick={async () => {
                await patch(`/api/admin/notices/${item.id}`, { status: item.status === 'PUBLISHED' ? 'ARCHIVED' : 'PUBLISHED' });
                await load();
              }}>
                {item.status === 'PUBLISHED' ? '下架' : '发布'}
              </button>
            </footer>
          </article>
        ))}
        {items.length === 0 && <Empty text="暂无系统通知，先发一条试试" />}
      </div>
    </>
  );
}

function SupportAvatar({ url, name }: { url?: string | null; name?: string | null }) {
  const letter = name?.[0] ?? '牛';
  if (url) {
    return (
      <div className="avatar">
        <img src={url} alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
        <span className="avatar-fallback">{letter}</span>
      </div>
    );
  }
  return <div className="avatar">{letter}</div>;
}

function Support({
  focusUserId,
  onFocusConsumed,
}: {
  focusUserId?: string | null;
  onFocusConsumed?: () => void;
}) {
  const [threads, setThreads] = useState<Row[]>([]);
  const [selected, setSelected] = useState<Row | null>(null);
  const [messages, setMessages] = useState<Row[]>([]);
  const [profile, setProfile] = useState<Row | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const streamRef = useRef<HTMLElement>(null);

  const load = () =>
    request<{ items: Row[] }>('/api/admin/support/threads').then((r) => setThreads(r.items));

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 8_000);
    return () => window.clearInterval(timer);
  }, []);

  async function open(thread: Row) {
    setSelected(thread);
    const result = await request<{ items: Row[]; user: Row }>(
      `/api/admin/support/${thread.userId}/messages`,
    );
    setMessages(result.items);
    setProfile(result.user);
    void load();
    requestAnimationFrame(() => {
      const el = streamRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  useEffect(() => {
    if (!focusUserId) return;
    const existing = threads.find((thread) => thread.userId === focusUserId);
    if (existing) {
      void open(existing).finally(() => onFocusConsumed?.());
      return;
    }
    void request<{ items: Row[] }>('/api/admin/support/threads')
      .then((result) => {
        setThreads(result.items);
        const thread = result.items.find((item) => item.userId === focusUserId);
        if (thread) return open(thread);
        return undefined;
      })
      .finally(() => onFocusConsumed?.());
  }, [focusUserId]);

  async function send() {
    if (!selected || !text.trim()) return;
    setBusy(true);
    try {
      await post(`/api/admin/support/${selected.userId}/messages`, {
        type: 'TEXT',
        content: text.trim(),
      });
      setText('');
      await open(selected);
    } finally {
      setBusy(false);
    }
  }

  const unreadTotal = threads.reduce((sum, thread) => sum + Number(thread.unread ?? 0), 0);
  const orderedThreads = [...threads].sort((a, b) => {
    const unreadDiff = Number(b.unread ?? 0) - Number(a.unread ?? 0);
    if (unreadDiff !== 0) return unreadDiff;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return (
    <div className="support-layout">
      <section className="panel thread-list">
        <header className="thread-list-head">
          <strong>会话列表</strong>
          <span>{unreadTotal > 0 ? `${unreadTotal} 条未读` : '全部已读'}</span>
        </header>
        {orderedThreads.map((t) => (
          <button
            className={[
              selected?.userId === t.userId ? 'active' : '',
              t.unread > 0 ? 'has-unread' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            key={t.userId}
            onClick={() => void open(t)}
          >
            <SupportAvatar url={t.user?.avatarDisplayUrl} name={t.user?.nickname} />
            <span>
              <strong>
                {t.user?.nickname ?? '玩家'}
                {t.unread > 0 ? <em className="thread-unread-tag">未读</em> : null}
              </strong>
              <small>
                {t.unread > 0 ? `[未读] ` : ''}
                {t.content ?? '[动画表情]'}
              </small>
            </span>
            {t.unread > 0 && <b>{t.unread}</b>}
          </button>
        ))}
        {threads.length === 0 && <Empty text="暂无客服会话" />}
      </section>

      <section className="panel support-chat">
        {!selected ? (
          <Empty text="选择会话开始处理" />
        ) : (
          <>
            <header className="support-chat-header">
              <div className="support-user-row">
                <SupportAvatar
                  url={profile?.avatarDisplayUrl ?? selected.user?.avatarDisplayUrl}
                  name={profile?.nickname ?? selected.user?.nickname}
                />
                <div>
                  <strong>{profile?.nickname ?? selected.user?.nickname}</strong>
                  <small>UID {profile?.uid ?? selected.user?.uid}</small>
                </div>
              </div>
            </header>
            <main ref={streamRef}>
              {messages.map((m) => (
                <div
                  className={`support-message ${String(m.senderType).toLowerCase()}`}
                  key={m.id}
                >
                  {m.senderType === 'SYSTEM' && <em className="support-sys-tag">自动回复</em>}
                  <p style={{ whiteSpace: 'pre-wrap' }}>{m.content}</p>
                  <time>{new Date(m.createdAt).toLocaleString('zh-MY')}</time>
                </div>
              ))}
            </main>
            <footer>
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void send()}
                placeholder="输入客服回复…"
              />
              <button className="primary small" disabled={busy || !text.trim()} onClick={() => void send()}>
                发送
              </button>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}

function ConfigEditor() {
  return (
    <div className="legacy-game-scope">
      <div className="toolbar standalone">
        <div className="toolbar-hint">
          <small>游戏配置</small>
          <span>已改为表单填写；建议在「游戏运营中心 → 规则与配置」管理</span>
        </div>
      </div>
      <GameConfigEditor gameCode={DEFAULT_GAME_CODE} />
    </div>
  );
}

function Bots() {
  const [items,setItems]=useState<Row[]>([]);const [form,setForm]=useState({name:'',username:'',token:'',isDefault:false});
  const load=()=>request<{items:Row[]}>('/api/admin/bots').then(r=>setItems(r.items));
  useEffect(()=>{void load();},[]);
  async function add(){await post('/api/admin/bots',form);setForm({name:'',username:'',token:'',isDefault:false});await load();}
  return <><section className="panel inline-form bot-form"><input placeholder="名称" value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/><input placeholder="username（不含 @）" value={form.username} onChange={e=>setForm({...form,username:e.target.value})}/><input placeholder="Bot Token" value={form.token} onChange={e=>setForm({...form,token:e.target.value})}/><label><input type="checkbox" checked={form.isDefault} onChange={e=>setForm({...form,isDefault:e.target.checked})}/> 默认入口</label><button className="primary small" disabled={!form.name||!form.username||!form.token} onClick={()=>void add()}>添加 Bot</button></section><div className="bot-grid">{items.map(bot=><article className="panel" key={bot.id}><header><div className="bot-avatar">◆</div><div><strong>{bot.name}</strong><small>@{bot.username}</small></div><Badge value={bot.status}/></header><dl><div><dt>Token</dt><dd>{bot.tokenMasked}</dd></div><div><dt>默认入口</dt><dd>{bot.isDefault?'是':'否'}</dd></div></dl><footer><button onClick={async()=>{await patch(`/api/admin/bots/${bot.id}`,{status:bot.status==='ACTIVE'?'DISABLED':'ACTIVE'});await load();}}>{bot.status==='ACTIVE'?'停用':'启用'}</button>{!bot.isDefault&&<button className="success" onClick={async()=>{await patch(`/api/admin/bots/${bot.id}`,{isDefault:true});await load();}}>设为默认</button>}</footer></article>)}</div></>;
}

function Admins() {
  const [items,setItems]=useState<Row[]>([]);const [error,setError]=useState('');const [form,setForm]=useState({username:'',password:'',role:'OPERATOR'});
  const load=()=>request<{items:Row[]}>('/api/admin/admins').then(r=>setItems(r.items));
  useEffect(()=>{void load();},[]);
  async function add(){try{setError('');await post('/api/admin/admins',form);setForm({username:'',password:'',role:'OPERATOR'});await load();}catch(e){setError((e as Error).message);}}
  async function update(id:string,data:Row){try{setError('');await patch(`/api/admin/admins/${id}`,data);await load();}catch(e){setError((e as Error).message);}}
  return <><section className="panel inline-form"><input placeholder="登录账号" value={form.username} onChange={e=>setForm({...form,username:e.target.value})}/><input type="password" placeholder="初始密码（至少 8 位）" value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/><select value={form.role} onChange={e=>setForm({...form,role:e.target.value})}><option value="OPERATOR">运营</option><option value="REVIEWER">审核</option><option value="FINANCE">财务</option><option value="SUPER">超级管理员</option></select><button className="primary small" disabled={form.username.length<3||form.password.length<8} onClick={()=>void add()}>创建账号</button></section><ErrorBox error={error}/><section className="panel"><div className="table-wrap"><table><thead><tr><th>账号</th><th>角色</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{items.map(item=><tr key={item.id}><td><strong>{item.username}</strong><small>{item.id.slice(-8)}</small></td><td><select value={item.role} onChange={e=>void update(item.id,{role:e.target.value})}><option value="SUPER">超级管理员</option><option value="OPERATOR">运营</option><option value="REVIEWER">审核</option><option value="FINANCE">财务</option></select></td><td><Badge value={item.status}/></td><td>{new Date(item.createdAt).toLocaleString('zh-MY')}</td><td className="actions"><button onClick={()=>{const password=prompt('输入新密码（至少 8 位）');if(password)void update(item.id,{password});}}>重置密码</button><button className={item.status==='ACTIVE'?'danger':'success'} onClick={()=>void update(item.id,{status:item.status==='ACTIVE'?'DISABLED':'ACTIVE'})}>{item.status==='ACTIVE'?'停用':'启用'}</button></td></tr>)}</tbody></table></div></section></>;
}

function Audit() {
  const [items,setItems]=useState<Row[]>([]);useEffect(()=>{request<{items:Row[]}>('/api/admin/audit-logs').then(r=>setItems(r.items));},[]);
  return <section className="panel"><div className="table-wrap"><table><thead><tr><th>时间</th><th>管理员</th><th>动作</th><th>目标</th><th>变更内容</th><th>IP</th></tr></thead><tbody>{items.map(i=><tr key={i.id}><td>{new Date(i.createdAt).toLocaleString('zh-MY')}</td><td>{i.adminId.slice(-8)}</td><td><code>{i.action}</code></td><td>{i.target??'—'}</td><td className="truncate">{JSON.stringify(i.after??i.before??{})}</td><td>{i.ip??'—'}</td></tr>)}</tbody></table></div></section>;
}
