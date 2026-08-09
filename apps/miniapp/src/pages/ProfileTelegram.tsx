import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

export default function ProfileTelegram() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tgId, setTgId] = useState('');
  const [tgDisplayName, setTgDisplayName] = useState('');
  const [tgUsername, setTgUsername] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((result) => {
        if (cancelled) return;
        setTgId(result.user.tgId || '');
        setTgDisplayName(result.user.tgDisplayName || '');
        setTgUsername(result.user.tgUsername || '');
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
  }, []);

  async function copyTgId() {
    if (!tgId) return;
    try {
      await navigator.clipboard?.writeText(tgId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  if (loading) return <div className="loading">加载中…</div>;

  const bound = !!tgId;

  return (
    <div className="page subpage profile-detail-page">
      <header className="subpage-header">
        <button type="button" onClick={() => navigate(-1)} aria-label="返回">
          ‹
        </button>
        <div>
          <h1>Telegram 账号</h1>
        </div>
        <span />
      </header>

      {error && <div className="inline-alert error">{error}</div>}

      <section className="profile-menu">
        <div className="profile-menu-item static">
          <span className="profile-menu-label">绑定状态</span>
          <span className="profile-menu-value">{bound ? '已通过 Telegram 登录' : '未绑定'}</span>
        </div>

        <button
          type="button"
          className="profile-menu-item"
          disabled={!bound}
          onClick={() => void copyTgId()}
        >
          <span className="profile-menu-label">Telegram ID</span>
          <span className="profile-menu-value">{tgId || '—'}</span>
          <em>{copied ? '已复制' : bound ? '复制' : ''}</em>
        </button>

        <div className="profile-menu-item static">
          <span className="profile-menu-label">Telegram 名称</span>
          <span className="profile-menu-value">{tgDisplayName || '—'}</span>
        </div>

        <div className="profile-menu-item static">
          <span className="profile-menu-label">Telegram 用户名</span>
          <span className="profile-menu-value">{tgUsername ? `@${tgUsername}` : '未设置'}</span>
        </div>
      </section>

      <p className="profile-detail-note">
        使用 Telegram 登录时会自动保存以上信息；展示昵称可在个人资料中单独修改。
      </p>
    </div>
  );
}
