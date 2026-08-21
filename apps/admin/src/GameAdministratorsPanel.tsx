import { useEffect, useMemo, useRef, useState } from 'react';
import { del, patch, post, put, request, rm, uploadAdminFile } from './api';

type AdminRole = 'SUPER' | 'OPERATOR' | 'REVIEWER' | 'FINANCE';
type Permission = 'SEND_BUDGET_PACKET' | 'MUTE_MEMBERS';

type Candidate = {
  id: string;
  uid: string;
  nickname: string | null;
  tgUsername: string | null;
  tgDisplayName: string | null;
  avatarUrl: string | null;
  kycStatus: string;
  paymentPinSet: boolean;
  assignment: {
    id: string;
    status: 'ACTIVE' | 'DISABLED';
    permissions: Permission[];
  } | null;
};

type Assignment = {
  id: string;
  gameCode: string;
  userId: string;
  permissions: Permission[];
  status: 'ACTIVE' | 'DISABLED';
  createdAt: string;
  updatedAt: string;
  user: Candidate & {
    status: string;
    kyc: { status: string } | null;
    paymentPin: { isSet: boolean } | null;
  };
};

type SupportHost = {
  id: string;
  uid: string;
  nickname: string | null;
  tgUsername: string | null;
  tgDisplayName: string | null;
  avatarUrl: string | null;
  status: string;
};

type Overview = {
  room: { id: string; gameCode: string; title: string; status: string };
  supportHost: SupportHost | null;
  assignments: Assignment[];
  budget: {
    id: string | null;
    gameCode: string;
    balanceCents: string;
    updatedAt: string | null;
  };
  ledger: Array<{
    id: string;
    direction: 'CREDIT' | 'DEBIT';
    amountCents: string;
    balanceAfterCents: string;
    refType: string;
    memo: string | null;
    createdAt: string;
  }>;
  actions: Array<{
    id: string;
    action: string;
    metadata: Record<string, unknown> | null;
    createdAt: string;
    assignment: { user: { uid: string; nickname: string | null } };
    targetUser: { uid: string; nickname: string | null } | null;
  }>;
};

const SUPPORT_HOST_LABEL = '客服小妹';
const SUPPORT_HOST_AVATAR = '/avatars/support-girl.jpg';

const permissionCopy: Record<Permission, { label: string; detail: string }> = {
  SEND_BUDGET_PACKET: {
    label: '预算红包',
    detail: '使用本游戏共享预算发红包',
  },
  MUTE_MEMBERS: {
    label: '成员禁言',
    detail: '禁言或解除本互动群成员',
  },
};

const actionCopy: Record<string, string> = {
  PACKET_SEND: '发送管理员红包',
  MEMBER_MUTE: '禁言成员',
  MEMBER_UNMUTE: '解除禁言',
};

function displayName(user: Pick<Candidate, 'uid' | 'nickname' | 'tgDisplayName' | 'tgUsername'>) {
  return user.nickname || user.tgDisplayName || user.tgUsername || `UID ${user.uid}`;
}

function GameAdminLookEditor({
  user,
  busy,
  onCancel,
  onSaved,
  onError,
}: {
  user: Pick<Candidate, 'id' | 'uid' | 'nickname' | 'tgDisplayName' | 'tgUsername' | 'avatarUrl'>;
  busy: boolean;
  onCancel: () => void;
  onSaved: (next: { nickname: string | null; avatarUrl: string | null }) => void;
  onError: (message: string) => void;
}) {
  const [nickname, setNickname] = useState(user.nickname ?? '');
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl ?? '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function uploadAvatar(file: File) {
    if (!file.type.startsWith('image/')) {
      onError('请上传 JPG、PNG 或 WEBP 图片');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      onError('图片不能超过 5MB');
      return;
    }
    setUploading(true);
    onError('');
    try {
      const result = await uploadAdminFile<{ url: string }>('/api/admin/uploads/avatar', file);
      setAvatarUrl(result.url);
    } catch (cause) {
      onError((cause as Error).message || '头像上传失败');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function save() {
    const nextName = nickname.trim();
    if (nextName.length < 1 || nextName.length > 24) {
      onError('展示名称需为 1～24 个字');
      return;
    }
    if (/[\u0000-\u001f\u007f]/.test(nextName)) {
      onError('展示名称包含无效字符');
      return;
    }
    const nextAvatar = avatarUrl.trim();
    if (!nextAvatar) {
      onError('请上传自定义头像');
      return;
    }
    setSaving(true);
    onError('');
    try {
      await patch(`/api/admin/users/${user.id}/profile`, {
        nickname: nextName,
        avatarUrl: nextAvatar,
        reason: '群管理员展示名称与头像调整',
      });
      onSaved({ nickname: nextName, avatarUrl: nextAvatar });
    } catch (cause) {
      onError((cause as Error).message || '保存失败');
    } finally {
      setSaving(false);
    }
  }

  const locked = busy || saving || uploading;

  return (
    <div className="ga-look-editor">
      <div className="ga-look-preview">
        <span className="ga-avatar lg">
          {avatarUrl ? <img src={avatarUrl} alt="" /> : displayName(user).slice(0, 1)}
        </span>
        <div>
          <strong>{nickname.trim() || displayName(user)}</strong>
          <small>自定义名称与头像会同步到互动群，不会使用系统头像库。</small>
        </div>
      </div>
      <label>
        <span>群内展示名称</span>
        <input
          value={nickname}
          maxLength={24}
          disabled={locked}
          onChange={(event) => setNickname(event.target.value)}
          placeholder="自定义名字，1～24 个字"
        />
      </label>
      <div className="ga-look-upload">
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void uploadAvatar(file);
          }}
        />
        <button type="button" disabled={locked} onClick={() => fileRef.current?.click()}>
          {uploading ? '上传中…' : avatarUrl ? '更换自定义头像' : '上传自定义头像'}
        </button>
        <small>JPG / PNG / WEBP，最大 5MB</small>
      </div>
      <div className="ga-look-actions">
        <button type="button" onClick={onCancel} disabled={locked}>
          取消
        </button>
        <button type="button" className="primary" disabled={locked} onClick={() => void save()}>
          {saving ? '保存中…' : '保存外观'}
        </button>
      </div>
    </div>
  );
}

function formatTime(value: string | null) {
  return value
    ? new Date(value).toLocaleString('zh-MY', {
        timeZone: 'Asia/Kuala_Lumpur',
        hour12: false,
      })
    : '—';
}

export default function GameAdministratorsPanel({
  gameCode,
  role,
}: {
  gameCode: string;
  role: AdminRole;
}) {
  const canManageAssignments = role === 'SUPER';
  const canManageBudget = role === 'SUPER' || role === 'FINANCE';
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [newPermissions, setNewPermissions] = useState<Permission[]>([
    'SEND_BUDGET_PACKET',
    'MUTE_MEMBERS',
  ]);
  const [budgetAction, setBudgetAction] = useState<'fund' | 'reclaim'>('fund');
  const [budgetAmount, setBudgetAmount] = useState('');
  const [budgetReason, setBudgetReason] = useState('');
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [hostQuery, setHostQuery] = useState('');
  const [hostCandidates, setHostCandidates] = useState<Candidate[]>([]);
  const [hostCandidateLoading, setHostCandidateLoading] = useState(false);
  const [hostPick, setHostPick] = useState<Candidate | null>(null);
  const budgetRequestRef = useRef<{
    fingerprint: string;
    requestId: string;
  } | null>(null);

  async function load(signal?: AbortSignal) {
    const result = await request<Overview>(
      `/api/admin/games/${encodeURIComponent(gameCode)}/game-admins/overview`,
      { signal },
    );
    setOverview(result);
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void load(controller.signal)
      .catch((cause) => {
        if (!controller.signal.aborted) setError((cause as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameCode]);

  useEffect(() => {
    if (!canManageAssignments) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setCandidateLoading(true);
      const params = new URLSearchParams({ limit: '12' });
      if (query.trim()) params.set('q', query.trim());
      void request<{ items: Candidate[] }>(
        `/api/admin/games/${encodeURIComponent(gameCode)}/game-admin-candidates?${params}`,
        { signal: controller.signal },
      )
        .then((result) => setCandidates(result.items))
        .catch((cause) => {
          if (!controller.signal.aborted) setError((cause as Error).message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setCandidateLoading(false);
        });
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [canManageAssignments, gameCode, query]);

  useEffect(() => {
    if (!canManageAssignments) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setHostCandidateLoading(true);
      const params = new URLSearchParams({ limit: '8' });
      if (hostQuery.trim()) params.set('q', hostQuery.trim());
      void request<{ items: Candidate[] }>(
        `/api/admin/games/${encodeURIComponent(gameCode)}/game-admin-candidates?${params}`,
        { signal: controller.signal },
      )
        .then((result) => setHostCandidates(result.items))
        .catch((cause) => {
          if (!controller.signal.aborted) setError((cause as Error).message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setHostCandidateLoading(false);
        });
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [canManageAssignments, gameCode, hostQuery]);

  const activeCount = useMemo(
    () => overview?.assignments.filter((item) => item.status === 'ACTIVE').length ?? 0,
    [overview],
  );

  function toggleNewPermission(permission: Permission) {
    setNewPermissions((current) =>
      current.includes(permission)
        ? current.filter((item) => item !== permission)
        : [...current, permission],
    );
  }

  async function bindSupportHostAccount() {
    if (!hostPick) return;
    setBusy('support-host');
    setError('');
    setNotice('');
    try {
      await put(`/api/admin/games/${encodeURIComponent(gameCode)}/support-host`, {
        userId: hostPick.id,
      });
      setNotice(`${displayName(hostPick)} 已绑定为客服小妹，打赏后会自动致谢`);
      setHostPick(null);
      setHostQuery('');
      await load();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function unbindSupportHostAccount() {
    if (!window.confirm('确认解除客服小妹绑定？解除后打赏将不再自动致谢。')) return;
    setBusy('support-host');
    setError('');
    setNotice('');
    try {
      await del(`/api/admin/games/${encodeURIComponent(gameCode)}/support-host`);
      setNotice('已解除客服小妹绑定');
      await load();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function addAssignment() {
    if (!selected || !newPermissions.length) return;
    setBusy('add');
    setError('');
    setNotice('');
    try {
      await post(
        `/api/admin/games/${encodeURIComponent(gameCode)}/game-admins`,
        { userId: selected.id, permissions: newPermissions },
      );
      setNotice(`${displayName(selected)} 已获得游戏管理员权限`);
      setSelected(null);
      setQuery('');
      await load();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function updateAssignment(
    assignment: Assignment,
    change: { permissions?: Permission[]; status?: 'ACTIVE' | 'DISABLED' },
  ) {
    if (change.permissions && !change.permissions.length) {
      setError('至少保留一项权限；如需撤销请停用该管理员');
      return;
    }
    setBusy(assignment.id);
    setError('');
    setNotice('');
    try {
      await patch(
        `/api/admin/games/${encodeURIComponent(gameCode)}/game-admins/${assignment.id}`,
        change,
      );
      setNotice('管理员授权已更新');
      await load();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function mutateBudget() {
    if (!budgetAmount || budgetReason.trim().length < 4) return;
    const label = budgetAction === 'fund' ? '拨入' : '回收';
    if (!window.confirm(`确认${label} RM ${budgetAmount}？此操作会写入不可变账务流水。`)) return;
    const fingerprint = JSON.stringify([
      gameCode,
      budgetAction,
      budgetAmount,
      budgetReason.trim(),
    ]);
    if (budgetRequestRef.current?.fingerprint !== fingerprint) {
      budgetRequestRef.current = {
        fingerprint,
        requestId: crypto.randomUUID(),
      };
    }
    const mutationRequestId = budgetRequestRef.current.requestId;
    setBusy('budget');
    setError('');
    setNotice('');
    try {
      await post(
        `/api/admin/games/${encodeURIComponent(gameCode)}/game-budget/${budgetAction}`,
        {
          amount: budgetAmount,
          reason: budgetReason.trim(),
          requestId: mutationRequestId,
        },
      );
      budgetRequestRef.current = null;
      setNotice(`预算已${label} RM ${budgetAmount}`);
      setBudgetAmount('');
      setBudgetReason('');
      await load();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy('');
    }
  }

  if (loading) {
    return (
      <div className="ga-page ga-loading" aria-busy="true">
        <span />
        <p>正在加载游戏管理员与预算…</p>
      </div>
    );
  }

  if (!overview) {
    return <div className="ga-page"><div className="ga-alert error">{error || '加载失败'}</div></div>;
  }

  return (
    <div className="ga-page">
      <section className="ga-hero">
        <div>
          <small>GAME AUTHORITY · {gameCode}</small>
          <h2>群管理员与运营预算</h2>
          <p>Telegram 用户按游戏授权。管理员只能操作本互动群，不会获得平台后台权限。</p>
        </div>
        <div className="ga-hero-metrics">
          <article>
            <span>有效管理员</span>
            <strong>{activeCount}</strong>
            <small>共 {overview.assignments.length} 条授权</small>
          </article>
          <article className="budget">
            <span>可用运营预算</span>
            <strong><i>RM</i>{rm(overview.budget.balanceCents)}</strong>
            <small>{formatTime(overview.budget.updatedAt)} 更新</small>
          </article>
        </div>
      </section>

      {error && <div className="ga-alert error" role="alert">{error}<button onClick={() => setError('')}>关闭</button></div>}
      {notice && <div className="ga-alert success" role="status">{notice}<button onClick={() => setNotice('')}>关闭</button></div>}

      <section className="ga-card ga-support-host">
        <header>
          <div><small>00 · SUPPORT</small><h3>客服小妹</h3></div>
          <span>{overview.supportHost ? '已绑定账号' : '待绑定'}</span>
        </header>
        <div className="ga-support-host-body">
          <span className="ga-avatar xl">
            <img src={overview.supportHost?.avatarUrl || SUPPORT_HOST_AVATAR} alt="" />
          </span>
          <div>
            <strong>{SUPPORT_HOST_LABEL}</strong>
            {overview.supportHost ? (
              <small>
                绑定 UID {overview.supportHost.uid}
                {overview.supportHost.tgUsername ? ` · @${overview.supportHost.tgUsername}` : ''}
                · 玩家打赏后该账号自动发送感谢语
              </small>
            ) : (
              <small>这是互动群固定席位。绑定真人 Telegram 账号后，打赏会由该账号自动致谢。</small>
            )}
          </div>
          {canManageAssignments && overview.supportHost && (
            <button
              type="button"
              className="danger-text"
              disabled={busy === 'support-host'}
              onClick={() => void unbindSupportHostAccount()}
            >
              {busy === 'support-host' ? '处理中…' : '解除绑定'}
            </button>
          )}
        </div>
        {canManageAssignments && (
          <div className="ga-add">
            <label>
              <span>{overview.supportHost ? '更换绑定账号' : '搜索并绑定账号'}</span>
              <input
                value={hostQuery}
                onChange={(event) => {
                  setHostQuery(event.target.value);
                  setHostPick(null);
                }}
                placeholder="UID、昵称或 @Telegram"
              />
            </label>
            <div className="ga-candidates">
              {hostCandidateLoading ? <p>搜索中…</p> : hostCandidates.map((candidate) => (
                <button
                  type="button"
                  key={candidate.id}
                  className={hostPick?.id === candidate.id ? 'selected' : ''}
                  onClick={() => setHostPick(candidate)}
                >
                  <span className="ga-avatar">
                    {candidate.avatarUrl
                      ? <img src={candidate.avatarUrl} alt="" />
                      : displayName(candidate).slice(0, 1)}
                  </span>
                  <span>
                    <strong>{displayName(candidate)}</strong>
                    <small>UID {candidate.uid}{candidate.tgUsername ? ` · @${candidate.tgUsername}` : ''}</small>
                  </span>
                  <em className={overview.supportHost?.id === candidate.id ? 'ready' : 'limited'}>
                    {overview.supportHost?.id === candidate.id ? '当前绑定' : '可绑定'}
                  </em>
                </button>
              ))}
            </div>
            {hostPick && (
              <div className="ga-grant">
                <p>
                  绑定后该账号展示为「{SUPPORT_HOST_LABEL}」，并使用专属头像。玩家打赏时，她会自动发其中一句感谢语。
                </p>
                <button
                  type="button"
                  className="primary"
                  disabled={busy === 'support-host'}
                  onClick={() => void bindSupportHostAccount()}
                >
                  {busy === 'support-host' ? '绑定中…' : `绑定 ${displayName(hostPick)}`}
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      <div className="ga-grid">
        <section className="ga-card ga-assignments">
          <header>
            <div><small>01 · AUTHORIZATION</small><h3>管理员授权</h3></div>
            <span>{canManageAssignments ? 'SUPER 可编辑' : '当前角色只读'}</span>
          </header>

          {canManageAssignments && (
            <div className="ga-add">
              <label>
                <span>搜索系统用户</span>
                <input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setSelected(null);
                  }}
                  placeholder="UID、昵称或 @Telegram"
                />
              </label>
              <div className="ga-candidates">
                {candidateLoading ? <p>搜索中…</p> : candidates.map((candidate) => {
                  const packetReady =
                    candidate.kycStatus === 'APPROVED' && candidate.paymentPinSet;
                  return (
                    <button
                      type="button"
                      key={candidate.id}
                      className={selected?.id === candidate.id ? 'selected' : ''}
                      onClick={() => {
                        setSelected(candidate);
                        setNewPermissions(packetReady
                          ? ['SEND_BUDGET_PACKET', 'MUTE_MEMBERS']
                          : ['MUTE_MEMBERS']);
                      }}
                    >
                      <span className="ga-avatar">
                        {candidate.avatarUrl
                          ? <img src={candidate.avatarUrl} alt="" />
                          : displayName(candidate).slice(0, 1)}
                      </span>
                      <span>
                        <strong>{displayName(candidate)}</strong>
                        <small>UID {candidate.uid}{candidate.tgUsername ? ` · @${candidate.tgUsername}` : ''}</small>
                      </span>
                      <em className={packetReady ? 'ready' : 'limited'}>
                        {candidate.assignment?.status === 'ACTIVE'
                          ? '已授权'
                          : packetReady
                            ? '可发预算红包'
                            : '仅可授予禁言'}
                      </em>
                    </button>
                  );
                })}
              </div>
              {selected && (
                <div className="ga-grant">
                  <div>
                    {(Object.keys(permissionCopy) as Permission[]).map((permission) => {
                      const unavailable =
                        permission === 'SEND_BUDGET_PACKET'
                        && (selected.kycStatus !== 'APPROVED' || !selected.paymentPinSet);
                      return (
                        <label key={permission} className={unavailable ? 'disabled' : ''}>
                          <input
                            type="checkbox"
                            checked={newPermissions.includes(permission)}
                            disabled={unavailable}
                            onChange={() => toggleNewPermission(permission)}
                          />
                          <span>
                            <strong>{permissionCopy[permission].label}</strong>
                            <small>{unavailable ? '需实名并设置支付密码' : permissionCopy[permission].detail}</small>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy === 'add' || !newPermissions.length}
                    onClick={() => void addAssignment()}
                  >
                    {busy === 'add' ? '授权中…' : selected.assignment ? '更新并启用' : '授予管理员权限'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingUserId(selected.id)}
                  >
                    改名字/头像
                  </button>
                </div>
              )}
              {selected && editingUserId === selected.id && (
                <GameAdminLookEditor
                  user={selected}
                  busy={false}
                  onCancel={() => setEditingUserId(null)}
                  onError={setError}
                  onSaved={(next) => {
                    setSelected({ ...selected, ...next });
                    setCandidates((items) =>
                      items.map((item) => (item.id === selected.id ? { ...item, ...next } : item)),
                    );
                    setEditingUserId(null);
                    setNotice(`${next.nickname || displayName(selected)} 的群内名称和头像已更新`);
                    void load();
                  }}
                />
              )}
            </div>
          )}

          <div className="ga-assignment-list">
            {overview.assignments.map((assignment) => (
              <article key={assignment.id} className={assignment.status.toLowerCase()}>
                <div className="ga-person">
                  <span className="ga-avatar">
                    {assignment.user.avatarUrl
                      ? <img src={assignment.user.avatarUrl} alt="" />
                      : displayName(assignment.user).slice(0, 1)}
                  </span>
                  <span>
                    <strong>{displayName(assignment.user)}</strong>
                    <small>UID {assignment.user.uid}{assignment.user.tgUsername ? ` · @${assignment.user.tgUsername}` : ''}</small>
                  </span>
                  <em>{assignment.status === 'ACTIVE' ? '有效' : '已停用'}</em>
                </div>
                <div className="ga-permissions">
                  {(Object.keys(permissionCopy) as Permission[]).map((permission) => (
                    <label key={permission}>
                      <input
                        type="checkbox"
                        checked={assignment.permissions.includes(permission)}
                        disabled={!canManageAssignments || busy === assignment.id}
                        onChange={() => {
                          const permissions = assignment.permissions.includes(permission)
                            ? assignment.permissions.filter((item) => item !== permission)
                            : [...assignment.permissions, permission];
                          void updateAssignment(assignment, { permissions });
                        }}
                      />
                      <span>{permissionCopy[permission].label}</span>
                    </label>
                  ))}
                </div>
                <footer>
                  <small>更新于 {formatTime(assignment.updatedAt)}</small>
                  {canManageAssignments && (
                    <span className="ga-assignment-actions">
                      <button
                        type="button"
                        disabled={busy === assignment.id}
                        onClick={() => setEditingUserId(
                          editingUserId === assignment.user.id ? null : assignment.user.id,
                        )}
                      >
                        {editingUserId === assignment.user.id ? '收起外观' : '改名字/头像'}
                      </button>
                      <button
                        type="button"
                        disabled={busy === assignment.id}
                        className={assignment.status === 'ACTIVE' ? 'danger-text' : ''}
                        onClick={() => void updateAssignment(assignment, {
                          status: assignment.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE',
                        })}
                      >
                        {assignment.status === 'ACTIVE' ? '停用权限' : '恢复权限'}
                      </button>
                    </span>
                  )}
                </footer>
                {canManageAssignments && editingUserId === assignment.user.id && (
                  <GameAdminLookEditor
                    user={assignment.user}
                    busy={busy === assignment.id}
                    onCancel={() => setEditingUserId(null)}
                    onError={setError}
                    onSaved={(next) => {
                      setEditingUserId(null);
                      setNotice(`${next.nickname || displayName(assignment.user)} 的群内名称和头像已更新`);
                      void load();
                    }}
                  />
                )}
              </article>
            ))}
            {!overview.assignments.length && <p className="ga-empty">尚未设置游戏管理员</p>}
          </div>
        </section>

        <aside className="ga-side">
          <section className="ga-card ga-budget">
            <header>
              <div><small>02 · TREASURY</small><h3>共享运营预算</h3></div>
              <span>{canManageBudget ? '可调拨' : '只读'}</span>
            </header>
            <div className="ga-balance">
              <small>AVAILABLE BALANCE</small>
              <strong><i>RM</i>{rm(overview.budget.balanceCents)}</strong>
              <p>管理员发包金额由本人决定，但不能超过此余额；每笔发包仍需本人支付密码。</p>
            </div>
            {canManageBudget && (
              <div className="ga-budget-form">
                <div className="ga-segmented">
                  <button className={budgetAction === 'fund' ? 'active' : ''} onClick={() => setBudgetAction('fund')}>拨入预算</button>
                  <button className={budgetAction === 'reclaim' ? 'active' : ''} onClick={() => setBudgetAction('reclaim')}>回收预算</button>
                </div>
                <label><span>金额（RM）</span><input inputMode="decimal" value={budgetAmount} onChange={(event) => setBudgetAmount(event.target.value.replace(/[^\d.]/g, '').slice(0, 24))} placeholder="0.00" /></label>
                <label><span>调拨原因</span><textarea value={budgetReason} onChange={(event) => setBudgetReason(event.target.value)} maxLength={200} placeholder="至少 4 字，将写入审计日志" /></label>
                <button className="primary" disabled={busy === 'budget' || !budgetAmount || budgetReason.trim().length < 4} onClick={() => void mutateBudget()}>
                  {busy === 'budget' ? '账务处理中…' : `确认${budgetAction === 'fund' ? '拨入' : '回收'}`}
                </button>
              </div>
            )}
          </section>

          <section className="ga-card ga-ledger">
            <header><div><small>03 · LEDGER</small><h3>预算流水</h3></div><span>最近 {overview.ledger.length} 笔</span></header>
            <div>
              {overview.ledger.map((entry) => (
                <article key={entry.id}>
                  <span className={entry.direction.toLowerCase()}>{entry.direction === 'CREDIT' ? '入' : '出'}</span>
                  <div><strong>{entry.memo || entry.refType}</strong><small>{formatTime(entry.createdAt)} · 余额 RM {rm(entry.balanceAfterCents)}</small></div>
                  <b className={entry.direction.toLowerCase()}>{entry.direction === 'CREDIT' ? '+' : '−'} RM {rm(entry.amountCents)}</b>
                </article>
              ))}
              {!overview.ledger.length && <p className="ga-empty">暂无预算流水</p>}
            </div>
          </section>
        </aside>
      </div>

      <section className="ga-card ga-audit">
        <header><div><small>04 · GAME ADMIN AUDIT</small><h3>管理员操作记录</h3></div><span>只记录游戏内高风险动作</span></header>
        <div className="table-wrap">
          <table>
            <thead><tr><th>时间</th><th>管理员</th><th>动作</th><th>目标</th><th>详情</th></tr></thead>
            <tbody>
              {overview.actions.map((action) => (
                <tr key={action.id}>
                  <td>{formatTime(action.createdAt)}</td>
                  <td><strong>{action.assignment.user.nickname || `UID ${action.assignment.user.uid}`}</strong></td>
                  <td><span className="ga-action">{actionCopy[action.action] || action.action}</span></td>
                  <td>{action.targetUser ? action.targetUser.nickname || `UID ${action.targetUser.uid}` : '—'}</td>
                  <td><small>{action.metadata ? JSON.stringify(action.metadata) : '—'}</small></td>
                </tr>
              ))}
              {!overview.actions.length && <tr><td colSpan={5}><p className="ga-empty">暂无管理员操作记录</p></td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
