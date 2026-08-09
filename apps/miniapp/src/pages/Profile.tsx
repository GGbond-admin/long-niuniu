import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { Session } from '../App';
import {
  IconChevronRight,
  IconList,
  IconSettings,
  IconShare,
  IconTrend,
} from '../components/Icons';
import {
  AVATAR_CATEGORIES,
  DEFAULT_AVATAR_URL,
  PRESET_AVATARS,
  avatarByUrl,
  type AvatarCategory,
} from '../lib/avatars';

const kycLabel: Record<string, string> = {
  APPROVED: '已通过',
  PENDING: '审核中',
  REJECTED: '已驳回',
  NONE: '未提交',
};

export default function Profile({
  session,
  onAvatarChange,
  active = true,
}: {
  session: Session;
  onAvatarChange?: (avatarUrl: string) => void;
  active?: boolean;
}) {
  const navigate = useNavigate();
  const [details, setDetails] = useState<Awaited<ReturnType<typeof api.me>> | null>(null);
  const [copied, setCopied] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [avatarCategory, setAvatarCategory] = useState<AvatarCategory | 'all'>('all');
  const [selectedUrl, setSelectedUrl] = useState(session.avatarUrl || DEFAULT_AVATAR_URL);
  const [saving, setSaving] = useState(false);
  const [avatarError, setAvatarError] = useState('');
  const [bankText, setBankText] = useState('未添加');
  const kyc = session.onboarding.kycStatus;

  useEffect(() => {
    if (!active) return;
    api.me().then(setDetails).catch(() => undefined);
  }, [active]);

  useEffect(() => {
    setSelectedUrl(session.avatarUrl || DEFAULT_AVATAR_URL);
  }, [session.avatarUrl]);

  useEffect(() => {
    if (!active) return;
    if (kyc !== 'APPROVED') {
      setBankText(kyc === 'PENDING' ? '实名审核中' : '需先实名');
      return;
    }
    api
      .withdrawAccounts()
      .then((result) => {
        const preferred =
          result.items.find((item) => item.isDefault && item.status === 'APPROVED') ??
          result.items.find((item) => item.status === 'APPROVED') ??
          result.items[0];
        setBankText(
          preferred
            ? `${preferred.institution} · ${preferred.accountNoMasked}`
            : '未添加',
        );
      })
      .catch(() => setBankText('未添加'));
  }, [active, kyc]);

  const filteredAvatars = useMemo(
    () =>
      avatarCategory === 'all'
        ? PRESET_AVATARS
        : PRESET_AVATARS.filter((item) => item.category === avatarCategory),
    [avatarCategory],
  );
  const selectedAvatar = avatarByUrl(selectedUrl);
  const joinedDays = details?.stats?.joinedDays ?? 1;
  const gamesPlayed = details?.stats?.gamesPlayed ?? 0;
  const displayAvatar = session.avatarUrl || DEFAULT_AVATAR_URL;

  async function copyUid() {
    try {
      await navigator.clipboard?.writeText(session.uid);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }

  async function saveAvatar() {
    const nextUrl = selectedUrl || DEFAULT_AVATAR_URL;
    if (nextUrl === (session.avatarUrl || DEFAULT_AVATAR_URL) && session.avatarUrl) {
      setPickerOpen(false);
      return;
    }
    setSaving(true);
    setAvatarError('');
    try {
      const result = await api.setAvatar(nextUrl);
      onAvatarChange?.(result.user.avatarUrl ?? nextUrl);
      setPickerOpen(false);
    } catch (reason) {
      setAvatarError((reason as Error).message || '更换失败');
    } finally {
      setSaving(false);
    }
  }

  function openFunds() {
    if (kyc === 'NONE' || kyc === 'REJECTED') {
      navigate('/kyc');
      return;
    }
    navigate('/wallet/funds');
  }

  return (
    <div className="page profile-page">
      <section className="member-card profile-member-card">
        <div className="member-card-glow" aria-hidden />

        <div className="profile-member-hero">
          <button
            type="button"
            className="member-avatar-wrap member-avatar-btn profile-hero-avatar"
            onClick={() => {
              setSelectedUrl(session.avatarUrl || DEFAULT_AVATAR_URL);
              setAvatarCategory('all');
              setAvatarError('');
              setPickerOpen(true);
            }}
            aria-label="更换头像"
          >
            <img className="member-avatar" src={displayAvatar} alt="" />
            <span className="member-avatar-edit">更换</span>
          </button>

          <p className="member-club">PRIVATE MEMBER</p>

          <button
            type="button"
            className="member-name-btn"
            onClick={() => navigate('/profile')}
            aria-label="查看个人资料"
          >
            <h1>{session.nickname}</h1>
            <IconChevronRight size={16} />
          </button>

          <button className="uid-chip" type="button" onClick={() => void copyUid()}>
            <span className="uid-chip-id">UID {session.uid}</span>
            <span className="uid-chip-action">{copied ? '已复制' : '复制'}</span>
          </button>
        </div>

        <div className="profile-stat-strip">
          <div className="profile-stat-cell">
            <small>已加入</small>
            <strong>
              {joinedDays}
              <em>天</em>
            </strong>
          </div>
          <span className="profile-stat-split" aria-hidden />
          <div className="profile-stat-cell">
            <small>累计游戏</small>
            <strong>
              {gamesPlayed}
              <em>局</em>
            </strong>
          </div>
          <span className="profile-stat-split" aria-hidden />
          <button type="button" className="profile-stat-cell profile-stat-link" onClick={() => navigate('/kyc')}>
            <small>身份认证</small>
            <strong>
              <i className={`status-dot ${kyc.toLowerCase()}`} />
              {kyc === 'APPROVED' ? '已通过' : kycLabel[kyc]}
            </strong>
          </button>
        </div>

        <button
          className="profile-bank-row"
          type="button"
          onClick={() =>
            kyc === 'APPROVED' || kyc === 'PENDING'
              ? navigate('/settings/banks', { state: { returnTo: '/' } })
              : navigate('/kyc')
          }
        >
          <div>
            <small>提现账户</small>
            <strong>{bankText}</strong>
          </div>
          <IconChevronRight size={16} />
        </button>
      </section>

      <section className="profile-section">
        <div className="profile-action-row">
          <button className="profile-action-chip" type="button" onClick={() => navigate('/invite')}>
            <span className="promo-tile-icon">
              <IconShare size={18} />
            </span>
            <strong>邀请好友</strong>
            <span>专属二维码</span>
          </button>
          <button className="profile-action-chip" type="button" onClick={() => navigate('/promotion')}>
            <span className="promo-tile-icon">
              <IconTrend size={18} />
            </span>
            <strong>我的推广</strong>
            <span>三级返水</span>
          </button>
          <button className="profile-action-chip" type="button" onClick={openFunds}>
            <span className="promo-tile-icon">
              <IconList size={18} />
            </span>
            <strong>资金明细</strong>
            <span>充值 · 提现</span>
          </button>
        </div>
      </section>

      <section className="profile-section profile-settings-section">
        <button
          type="button"
          className="profile-settings-entry"
          onClick={() => navigate('/settings')}
        >
          <span className="profile-settings-icon"><IconSettings size={21} /></span>
          <span>
            <strong>设置与安全</strong>
            <small>实名 · 提现账户 · 支付密码</small>
          </span>
          <em
            className={
              kyc === 'APPROVED' && !session.security.paymentPinSet ? 'attention' : ''
            }
          >
            {kyc === 'APPROVED' && !session.security.paymentPinSet
              ? '待完善'
              : session.security.paymentPinSet
                ? '已保护'
                : '设置'}
          </em>
          <IconChevronRight size={17} />
        </button>
      </section>

      {pickerOpen &&
        createPortal(
          <div className="avatar-sheet" role="dialog" aria-modal="true" aria-label="选择头像">
            <button
              type="button"
              className="avatar-sheet-backdrop"
              onClick={() => setPickerOpen(false)}
            />
            <div className="avatar-sheet-panel">
              <div className="avatar-sheet-head">
                <h2>选择头像</h2>
                <button
                  type="button"
                  className="avatar-sheet-close"
                  onClick={() => setPickerOpen(false)}
                >
                  ✕
                </button>
              </div>

              <div className="avatar-preview">
                <img src={selectedUrl || DEFAULT_AVATAR_URL} alt="" />
                <div>
                  <small>当前选择</small>
                  <strong>{selectedAvatar?.label ?? '3D 形象'}</strong>
                </div>
              </div>

              <div className="avatar-cats">
                {AVATAR_CATEGORIES.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className={avatarCategory === item.key ? 'active' : ''}
                    onClick={() => setAvatarCategory(item.key)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <div className="avatar-grid">
                {filteredAvatars.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`avatar-option ${selectedUrl === item.url ? 'selected' : ''}`}
                    onClick={() => setSelectedUrl(item.url)}
                    aria-label={item.label}
                  >
                    <img src={item.url} alt="" />
                  </button>
                ))}
              </div>

              <div className="avatar-sheet-footer">
                {avatarError && <div className="inline-alert error">{avatarError}</div>}
                <button
                  type="button"
                  className="avatar-save"
                  disabled={saving || !selectedUrl}
                  onClick={() => void saveAvatar()}
                >
                  {saving ? '保存中…' : '确认更换'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
