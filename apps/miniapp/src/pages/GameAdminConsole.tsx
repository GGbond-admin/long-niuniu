import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  rm,
  type GameAdminAction,
  type GameAdminConsole as ConsoleData,
  type GameAdminMember,
} from '../api';
import { goBack } from '../lib/nav';

const actionCopy: Record<string, string> = {
  PACKET_SEND: '发送预算红包',
  MEMBER_MUTE: '禁言成员',
  MEMBER_UNMUTE: '解除禁言',
};

function displayTime(value: string) {
  return new Date(value).toLocaleString('zh-MY', {
    timeZone: 'Asia/Kuala_Lumpur',
    hour12: false,
  });
}

function memberName(member: GameAdminMember) {
  return member.user.nickname || member.user.tgUsername || `UID ${member.user.uid}`;
}

function muteLabel(mute: GameAdminMember['mute']) {
  if (!mute.active) return '正常发言';
  if (!mute.mutedUntil) return '永久禁言';
  return `禁言至 ${new Date(mute.mutedUntil).toLocaleString('zh-MY', {
    timeZone: 'Asia/Kuala_Lumpur',
    hour12: false,
  })}`;
}

export default function GameAdminConsole() {
  const { gameCode = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [consoleData, setConsoleData] = useState<ConsoleData | null>(null);
  const [members, setMembers] = useState<GameAdminMember[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [actions, setActions] = useState<GameAdminAction[]>([]);
  const [actionsCursor, setActionsCursor] = useState<string | null>(null);
  const [actionsLoaded, setActionsLoaded] = useState(false);
  const [tab, setTab] = useState<'members' | 'audit'>('members');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [membersLoading, setMembersLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<GameAdminMember | null>(null);
  const [duration, setDuration] = useState('60');
  const [reason, setReason] = useState('');

  const canSendPacket = consoleData?.assignment.permissions.includes('SEND_BUDGET_PACKET');
  const canMute = consoleData?.assignment.permissions.includes('MUTE_MEMBERS');
  const onlineCount = useMemo(
    () => members.filter((member) => member.online).length,
    [members],
  );

  async function loadConsole() {
    const result = await api.gameAdminConsole(gameCode);
    setConsoleData(result);
    setActions(result.recentActions);
    setActionsCursor(null);
    setActionsLoaded(false);
  }

  async function loadMembers(search = query, cursor?: string) {
    setMembersLoading(true);
    try {
      const result = await api.gameAdminMembers(gameCode, {
        q: search.trim() || undefined,
        cursor,
        limit: 30,
      });
      setMembers((current) => (cursor ? [...current, ...result.items] : result.items));
      setNextCursor(result.nextCursor);
    } finally {
      setMembersLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setActionsLoaded(false);
    setActionsCursor(null);
    void Promise.all([api.gameAdminConsole(gameCode), api.gameAdminMembers(gameCode)])
      .then(([consoleResult, memberResult]) => {
        if (!active) return;
        setConsoleData(consoleResult);
        setActions(consoleResult.recentActions);
        setMembers(memberResult.items);
        setNextCursor(memberResult.nextCursor);
      })
      .catch((cause) => {
        if (active) setError((cause as Error).message || '控制台加载失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [gameCode]);

  useEffect(() => {
    if (loading) return;
    const timer = window.setTimeout(() => {
      void loadMembers(query).catch((cause) =>
        setError((cause as Error).message || '成员加载失败'),
      );
    }, 260);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    if (tab !== 'audit' || actionsLoaded) return;
    let active = true;
    void api
      .gameAdminActions(gameCode)
      .then((result) => {
        if (!active) return;
        setActions(result.items);
        setActionsCursor(result.nextCursor);
        setActionsLoaded(true);
      })
      .catch((cause) => {
        if (active) setError((cause as Error).message || '操作记录加载失败');
      });
    return () => {
      active = false;
    };
  }, [actionsLoaded, gameCode, tab]);

  async function loadMoreActions() {
    if (!actionsCursor) return;
    const result = await api.gameAdminActions(gameCode, actionsCursor);
    setActions((current) => [...current, ...result.items]);
    setActionsCursor(result.nextCursor);
  }

  function openMember(member: GameAdminMember) {
    setSelected(member);
    setDuration('60');
    setReason('');
    setError('');
  }

  async function submitMute() {
    if (!selected || reason.trim().length < 2) return;
    setBusy(true);
    setError('');
    try {
      await api.gameAdminMute(gameCode, selected.user.id, {
        durationMinutes: duration === 'permanent' ? null : Number(duration),
        reason: reason.trim(),
        requestId: crypto.randomUUID(),
      });
      setNotice(`${memberName(selected)} 已被禁言`);
      setSelected(null);
      await Promise.all([loadMembers(query), loadConsole()]);
    } catch (cause) {
      setError((cause as Error).message || '禁言失败');
    } finally {
      setBusy(false);
    }
  }

  async function submitUnmute() {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      await api.gameAdminUnmute(gameCode, selected.user.id, {
        reason: reason.trim() || '管理员手动解除禁言',
        requestId: crypto.randomUUID(),
      });
      setNotice(`${memberName(selected)} 已解除禁言`);
      setSelected(null);
      await Promise.all([loadMembers(query), loadConsole()]);
    } catch (cause) {
      setError((cause as Error).message || '解除禁言失败');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="gam-page"><div className="gam-loading"><span /><p>正在校验权限与群成员…</p></div></div>;
  }

  if (!consoleData) {
    return (
      <div className="gam-page">
        <header className="gam-nav"><button type="button" onClick={() => goBack(navigate, location, '/game-admin')} aria-label="返回">‹</button><strong>管理员中心</strong><i /></header>
        <div className="gam-empty"><h2>无法打开控制台</h2><p>{error || '授权不存在或已停用'}</p><button onClick={() => navigate('/game-admin')}>返回</button></div>
      </div>
    );
  }

  return (
    <div className="gam-page gam-console">
      <header className="gam-nav">
        <button type="button" onClick={() => goBack(navigate, location, '/game-admin')} aria-label="返回">‹</button>
        <span><small>{gameCode}</small><strong>{consoleData.room.title}</strong></span>
        <button type="button" className="gam-room-link" onClick={() => navigate(`/game/${consoleData.room.id}/play`)}>进群</button>
      </header>

      <main>
        <section className="gam-console-hero">
          <div>
            <small>SHARED OPERATING BUDGET</small>
            <span><i>RM</i><strong>{rm(consoleData.budget.balanceCents)}</strong></span>
            <p>红包只能从本游戏预算扣款；余额由平台财务统一调拨。</p>
          </div>
          {canSendPacket && (
            <button type="button" onClick={() => navigate(`/game-admin/${encodeURIComponent(gameCode)}/send-packet`)}>
              <span>发</span>
              <strong>发送管理员红包</strong>
              <small>每次需验证支付密码</small>
            </button>
          )}
        </section>

        <section className="gam-kpis">
          <article><small>当前载入成员</small><strong>{members.length}</strong></article>
          <article><small>90 秒内在线</small><strong>{onlineCount}</strong></article>
          <article><small>已禁言</small><strong>{members.filter((item) => item.mute.active).length}</strong></article>
        </section>

        {error && <div className="gam-alert error">{error}<button onClick={() => setError('')}>关闭</button></div>}
        {notice && <div className="gam-alert success">{notice}<button onClick={() => setNotice('')}>关闭</button></div>}

        <div className="gam-tabs">
          <button className={tab === 'members' ? 'active' : ''} onClick={() => setTab('members')}>
            <strong>成员管理</strong><small>在线与禁言</small>
          </button>
          <button className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}>
            <strong>操作记录</strong><small>我的审计轨迹</small>
          </button>
        </div>

        {tab === 'members' ? (
          <section className="gam-member-panel">
            <label className="gam-search">
              <span>⌕</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 UID、昵称或 Telegram" />
              {query && <button type="button" onClick={() => setQuery('')}>×</button>}
            </label>
            <div className="gam-member-list">
              {members.map((member) => (
                <button
                  type="button"
                  key={member.id}
                  className={member.mute.active ? 'muted' : ''}
                  onClick={() => openMember(member)}
                >
                  <span className="gam-member-avatar">
                    {member.user.avatarUrl
                      ? <img src={member.user.avatarUrl} alt="" />
                      : memberName(member).slice(0, 1)}
                    <i className={member.online ? 'online' : ''} />
                  </span>
                  <span>
                    <strong>
                      {memberName(member)}
                      {member.isGameAdmin && <em>管理员</em>}
                    </strong>
                    <small>UID {member.user.uid}{member.user.tgUsername ? ` · @${member.user.tgUsername}` : ''}</small>
                  </span>
                  <span className="gam-member-state">
                    <strong>{muteLabel(member.mute)}</strong>
                    <small>{member.online ? '当前在线' : displayTime(member.lastSeenAt)}</small>
                  </span>
                  <b>›</b>
                </button>
              ))}
              {!members.length && !membersLoading && <div className="gam-empty compact"><h2>没有找到成员</h2><p>换一个关键词再试</p></div>}
            </div>
            {nextCursor && (
              <button className="gam-load-more" disabled={membersLoading} onClick={() => void loadMembers(query, nextCursor)}>
                {membersLoading ? '载入中…' : '载入更多成员'}
              </button>
            )}
          </section>
        ) : (
          <section className="gam-audit-list">
            {actions.map((action) => (
              <article key={action.id}>
                <span className={`gam-action-icon ${action.action.toLowerCase()}`}>
                  {action.action === 'PACKET_SEND' ? '包' : action.action === 'MEMBER_MUTE' ? '禁' : '解'}
                </span>
                <span>
                  <small>{displayTime(action.createdAt)}</small>
                  <strong>{actionCopy[action.action] || action.action}</strong>
                  <p>
                    {action.targetUser
                      ? `${action.targetUser.nickname || `UID ${action.targetUser.uid}`}`
                      : action.metadata?.amountCents
                        ? `金额 RM ${rm(String(action.metadata.amountCents))}`
                        : '已记录完整操作快照'}
                  </p>
                </span>
              </article>
            ))}
            {!actions.length && <div className="gam-empty compact"><h2>暂无操作记录</h2></div>}
            {actionsCursor && (
              <button className="gam-load-more" onClick={() => void loadMoreActions()}>载入更多记录</button>
            )}
          </section>
        )}
      </main>

      {selected && (
        <div className="gam-member-sheet" role="dialog" aria-modal="true">
          <button className="gam-sheet-backdrop" type="button" onClick={() => !busy && setSelected(null)} aria-label="关闭" />
          <section>
            <div className="gam-sheet-handle" />
            <header>
              <span className="gam-member-avatar">
                {selected.user.avatarUrl
                  ? <img src={selected.user.avatarUrl} alt="" />
                  : memberName(selected).slice(0, 1)}
              </span>
              <span><small>UID {selected.user.uid}</small><strong>{memberName(selected)}</strong></span>
              <em className={selected.online ? 'online' : ''}>{selected.online ? '在线' : '离线'}</em>
            </header>

            {selected.isGameAdmin ? (
              <div className="gam-protected">
                <strong>受保护的游戏管理员</strong>
                <p>管理员之间不能互相禁言。如需限制其权限，请联系平台 SUPER 停用授权。</p>
              </div>
            ) : !canMute ? (
              <div className="gam-protected"><strong>没有禁言权限</strong><p>当前授权只允许查看成员。</p></div>
            ) : selected.mute.active ? (
              <>
                <div className="gam-current-mute">
                  <small>当前状态</small>
                  <strong>{muteLabel(selected.mute)}</strong>
                  <p>{selected.mute.reason || '未填写原因'}</p>
                </div>
                <label className="gam-sheet-reason">
                  <span>解除说明（可选）</span>
                  <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={120} placeholder="管理员手动解除禁言" />
                </label>
                <button className="gam-sheet-cta unmute" disabled={busy} onClick={() => void submitUnmute()}>
                  {busy ? '处理中…' : '立即解除禁言'}
                </button>
              </>
            ) : (
              <>
                <div className="gam-duration">
                  {[
                    ['10', '10 分钟'],
                    ['60', '1 小时'],
                    ['1440', '24 小时'],
                    ['permanent', '永久'],
                  ].map(([value, label]) => (
                    <button key={value} className={duration === value ? 'active' : ''} onClick={() => setDuration(value)}>{label}</button>
                  ))}
                </div>
                <label className="gam-sheet-reason">
                  <span>禁言原因</span>
                  <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={120} placeholder="至少 2 个字；玩家会看到此原因" />
                </label>
                <p className="gam-mute-scope">禁言只限制普通消息、表情、贴纸、个人红包和打赏；下注、抢包及其他游戏指令不受影响。</p>
                <button className="gam-sheet-cta" disabled={busy || reason.trim().length < 2} onClick={() => void submitMute()}>
                  {busy ? '处理中…' : '确认禁言'}
                </button>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
