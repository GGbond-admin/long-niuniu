import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import {
  getCachedGameAdminAssignments,
  getSeenAgentReportPoolId,
  setCachedGameAdminAssignments,
} from '../sessionStore';
import type { Session } from '../App';
import {
  IconChevronRight,
  IconList,
  IconPieChart,
  IconQrCode,
  IconRank,
  IconSettings,
  IconShare,
  IconTrend,
  IconUsers,
} from '../components/Icons';
import {
  AVATAR_CATEGORIES,
  DEFAULT_AVATAR_URL,
  PRESET_AVATARS,
  avatarByUrl,
  isCustomAvatarUrl,
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
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [avatarError, setAvatarError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [bankText, setBankText] = useState('未添加');
  const [agent, setAgent] = useState<Awaited<ReturnType<typeof api.agentMe>>['agent']>(null);
  const [gameAdminAssignments, setGameAdminAssignments] = useState(
    () => getCachedGameAdminAssignments() ?? [],
  );
  const kyc = session.onboarding.kycStatus;

  useEffect(() => {
    if (!active) return;
    api.me().then(setDetails).catch(() => undefined);
    // 代理专属入口：仅代理或以上级别可见（非代理返回 null）
    api
      .agentMe()
      .then((result) => setAgent(result.agent))
      .catch(() => setAgent(null));
    api
      .gameAdminMe()
      .then((result) => {
        setGameAdminAssignments(result.items);
        setCachedGameAdminAssignments(result.items);
      })
      .catch(() => {
        setGameAdminAssignments([]);
        setCachedGameAdminAssignments([]);
      });
  }, [active]);

  useEffect(() => {
    setSelectedUrl(session.avatarUrl || DEFAULT_AVATAR_URL);
    setPendingFile(null);
  }, [session.avatarUrl]);

  useEffect(() => {
    if (!selectedUrl.startsWith('blob:')) return;
    return () => URL.revokeObjectURL(selectedUrl);
  }, [selectedUrl]);

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
  const selectedLabel =
    pendingFile || isCustomAvatarUrl(selectedUrl) || selectedUrl.startsWith('blob:')
      ? '自定义头像'
      : (avatarByUrl(selectedUrl)?.label ?? '3D 形象');
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

  function closePicker() {
    setPickerOpen(false);
    setPendingFile(null);
    setAvatarError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function pickLocalFile(file: File | undefined) {
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/i.test(file.type) && !/\.(jpe?g|png|webp)$/i.test(file.name)) {
      setAvatarError('仅支持 JPG、PNG 或 WEBP 图片');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setAvatarError('图片不能超过 5MB');
      return;
    }
    setAvatarError('');
    setPendingFile(file);
    setSelectedUrl(URL.createObjectURL(file));
  }

  async function saveAvatar() {
    if (!pendingFile && selectedUrl === (session.avatarUrl || DEFAULT_AVATAR_URL) && session.avatarUrl) {
      closePicker();
      return;
    }
    setSaving(true);
    setAvatarError('');
    try {
      let nextUrl = selectedUrl || DEFAULT_AVATAR_URL;
      if (pendingFile) {
        const uploaded = await api.uploadAvatar(pendingFile);
        nextUrl = uploaded.url;
      }
      const result = await api.setAvatar(nextUrl);
      onAvatarChange?.(result.user.avatarUrl ?? nextUrl);
      closePicker();
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
              setPendingFile(null);
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

      {gameAdminAssignments.length > 0 && (
        <section className="profile-section gam-profile-entry">
          <button type="button" onClick={() => navigate('/game-admin')}>
            <span className="gam-profile-icon">盾</span>
            <span>
              <small>GAME OPERATIONS</small>
              <strong>游戏管理员中心</strong>
              <p>
                已授权 {gameAdminAssignments.length} 个游戏 · 管理成员、预算与管理员红包
              </p>
            </span>
            <em>进入控制台</em>
            <IconChevronRight size={17} />
          </button>
        </section>
      )}

      {agent && (
        <section className="profile-section ag-exclusive">
          <div className="ag-exclusive-head">
            <strong>代理专属</strong>
            <small>仅代理或以上级别可见 · 占成 {agent.sharePoints}/{agent.bucketBase}</small>
          </div>
          <div className="ag-exclusive-grid">
            <button type="button" onClick={() => navigate('/agent/report?tab=report')}>
              {agent.latestReport
                && getSeenAgentReportPoolId(agent.id) !== agent.latestReport.poolId ? (
                <i className="ag-badge-new">NEW</i>
              ) : null}
              <span className="ag-exclusive-icon">
                <IconRank size={17} />
              </span>
              <strong>称桶报表</strong>
            </button>
            <button type="button" onClick={() => navigate('/agent/sharing')}>
              <span className="ag-exclusive-icon">
                <IconPieChart size={17} />
              </span>
              <strong>分成管理</strong>
            </button>
            <button type="button" onClick={() => navigate('/agent/players')}>
              <span className="ag-exclusive-icon">
                <IconUsers size={17} />
              </span>
              <strong>玩家列表</strong>
            </button>
            <button type="button" onClick={() => navigate('/invite')}>
              <span className="ag-exclusive-icon">
                <IconQrCode size={17} />
              </span>
              <strong>推荐二维码</strong>
            </button>
          </div>
          <button
            type="button"
            className="ag-exclusive-banner"
            onClick={() => navigate('/agent/report')}
          >
            <span>
              <strong>专属代理中心</strong>
              <small>
                {agent.latestReport
                  ? `${agent.latestReport.room?.title ?? '称桶报表'} · ${agent.latestReport.poolCode ?? '最新批次'}`
                  : `名下玩家 ${agent.playerCount} · 下级代理 ${agent.subagentCount}`}
                ，查看团队数据与收益
              </small>
            </span>
            <em>立即查看</em>
          </button>
        </section>
      )}

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
              onClick={closePicker}
            />
            <div className="avatar-sheet-panel">
              <div className="avatar-sheet-head">
                <h2>选择头像</h2>
                <button
                  type="button"
                  className="avatar-sheet-close"
                  onClick={closePicker}
                >
                  ✕
                </button>
              </div>

              <div className="avatar-preview">
                <img src={selectedUrl || DEFAULT_AVATAR_URL} alt="" />
                <div>
                  <small>当前选择</small>
                  <strong>{selectedLabel}</strong>
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
                <button
                  type="button"
                  className={`avatar-option avatar-upload ${pendingFile ? 'selected' : ''}`}
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="上传自己的头像"
                >
                  {pendingFile ? (
                    <img src={selectedUrl} alt="" />
                  ) : (
                    <span>
                      <em>+</em>
                      上传
                    </span>
                  )}
                </button>
                {filteredAvatars.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`avatar-option ${!pendingFile && selectedUrl === item.url ? 'selected' : ''}`}
                    onClick={() => {
                      setPendingFile(null);
                      setSelectedUrl(item.url);
                    }}
                    aria-label={item.label}
                  >
                    <img src={item.url} alt="" />
                  </button>
                ))}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                hidden
                onChange={(event) => {
                  pickLocalFile(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />

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
