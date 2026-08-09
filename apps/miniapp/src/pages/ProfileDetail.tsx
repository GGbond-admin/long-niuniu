import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { Session } from '../App';
import { IconChevronRight } from '../components/Icons';
import { DEFAULT_AVATAR_URL } from '../lib/avatars';

function formatJoinedAt(value?: string) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString('zh-MY', {
      timeZone: 'Asia/Kuala_Lumpur',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    return value;
  }
}

export default function ProfileDetail({
  session,
  onNicknameChange,
}: {
  session: Session;
  onNicknameChange?: (nickname: string) => void;
}) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nickname, setNickname] = useState(session.nickname);
  const [draft, setDraft] = useState(session.nickname);
  const [uid, setUid] = useState(session.uid);
  const [inviteCode, setInviteCode] = useState(session.uid);
  const [joinedAt, setJoinedAt] = useState('—');
  const [joinedDays, setJoinedDays] = useState(1);
  const [avatarUrl, setAvatarUrl] = useState(session.avatarUrl || DEFAULT_AVATAR_URL);
  const [tgBound, setTgBound] = useState(false);
  const [copiedUid, setCopiedUid] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .me()
      .then((result) => {
        if (cancelled) return;
        const nextNickname = result.user.nickname || session.nickname;
        setNickname(nextNickname);
        setDraft(nextNickname);
        setUid(result.user.uid);
        setInviteCode(result.user.inviteCode || result.user.uid);
        setJoinedAt(formatJoinedAt(result.user.createdAt));
        setJoinedDays(result.stats?.joinedDays ?? 1);
        setAvatarUrl(result.user.avatarUrl || session.avatarUrl || DEFAULT_AVATAR_URL);
        setTgBound(!!result.user.tgId && result.user.tgId !== '—');
        setError('');
      })
      .catch((reason) => {
        if (!cancelled) setError((reason as Error).message || '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session.nickname, session.avatarUrl, session.uid]);

  async function copyUid() {
    try {
      await navigator.clipboard?.writeText(uid);
      setCopiedUid(true);
      window.setTimeout(() => setCopiedUid(false), 1500);
    } catch {
      setCopiedUid(false);
    }
  }

  async function saveNickname() {
    const next = draft.trim();
    if (!next || next === nickname) {
      setEditing(false);
      setDraft(nickname);
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api.setNickname(next);
      setNickname(result.user.nickname);
      setDraft(result.user.nickname);
      onNicknameChange?.(result.user.nickname);
      setEditing(false);
      setMessage('昵称已更新');
    } catch (reason) {
      setError((reason as Error).message || '修改失败');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="loading">加载中…</div>;

  return (
    <div className="page subpage profile-detail-page">
      <header className="subpage-header">
        <button type="button" onClick={() => navigate(-1)} aria-label="返回">
          ‹
        </button>
        <div>
          <h1>个人资料</h1>
        </div>
        <span />
      </header>

      <section className="profile-detail-head">
        <img className="profile-detail-avatar" src={avatarUrl} alt="" />
        {editing ? (
          <div className="profile-detail-edit">
            <input
              className="profile-detail-input"
              value={draft}
              maxLength={24}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="请输入昵称"
              autoFocus
            />
            <div className="profile-detail-edit-actions">
              <button type="button" className="text-action" disabled={busy} onClick={() => void saveNickname()}>
                {busy ? '保存中' : '保存'}
              </button>
              <button
                type="button"
                className="text-action muted-action"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setDraft(nickname);
                }}
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="profile-detail-name" onClick={() => setEditing(true)}>
            <strong>{nickname || '未设置昵称'}</strong>
            <span>点击修改昵称</span>
          </button>
        )}
      </section>

      {error && <div className="inline-alert error">{error}</div>}
      {message && <div className="inline-alert">{message}</div>}

      <section className="profile-menu">
        <button type="button" className="profile-menu-item" onClick={() => void copyUid()}>
          <span className="profile-menu-label">UID</span>
          <span className="profile-menu-value">{uid}</span>
          <em>{copiedUid ? '已复制' : '复制'}</em>
        </button>

        <button type="button" className="profile-menu-item" onClick={() => navigate('/invite')}>
          <span className="profile-menu-label">邀请码</span>
          <span className="profile-menu-value">{inviteCode}</span>
          <IconChevronRight className="profile-menu-chevron" size={16} />
        </button>

        <div className="profile-menu-item static">
          <span className="profile-menu-label">加入时间</span>
          <span className="profile-menu-value">
            {joinedAt}
            <small>已加入 {joinedDays} 天</small>
          </span>
        </div>

        <button type="button" className="profile-menu-item" onClick={() => navigate('/profile/telegram')}>
          <span className="profile-menu-label">Telegram</span>
          <span className="profile-menu-value">{tgBound ? '已绑定' : '未绑定'}</span>
          <IconChevronRight className="profile-menu-chevron" size={16} />
        </button>
      </section>
    </div>
  );
}
