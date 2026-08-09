import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { QRCodeCanvas } from 'qrcode.react';
import { api } from '../api';
import BrandLogo from '../components/BrandLogo';
import { tg } from '../telegram';
import { LegalLinks } from './LegalDoc';

export default function InviteFriends() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.inviteLink>> | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<'uid' | 'link' | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api
      .inviteLink()
      .then((result) => {
        setData(result);
        setError('');
      })
      .catch((reason) => {
        setError(
          (reason as { code?: string }).code === 'NO_DEFAULT_BOT'
            ? '尚未配置默认 Bot，请先在运营后台「Bot 管理」添加并启用默认入口'
            : `加载失败：${(reason as Error).message}`,
        );
      });
  }, []);

  function flash(kind: 'uid' | 'link') {
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1500);
  }

  if (error) {
    return (
      <div className="page subpage iv-page">
        <header className="subpage-header">
          <button type="button" onClick={() => navigate(-1)} aria-label="返回">
            ‹
          </button>
          <div>
            <h1>邀请好友</h1>
          </div>
          <span />
        </header>
        <div className="inline-alert error">{error}</div>
      </div>
    );
  }

  if (!data) return <div className="loading">加载中…</div>;

  function saveQr() {
    const canvas = document.querySelector<HTMLCanvasElement>('#invite-qr canvas');
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `zhizun-niuniu-${data!.uid}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }

  function share() {
    const url = `https://t.me/share/url?url=${encodeURIComponent(data!.deepLink)}&text=${encodeURIComponent('加入至尊牛牛，与我一起参与牌局')}`;
    tg()?.openTelegramLink(url);
  }

  return (
    <div className="page subpage iv-page">
      <header className="subpage-header">
        <button type="button" onClick={() => navigate(-1)} aria-label="返回">
          ‹
        </button>
        <div>
          <h1>邀请好友</h1>
        </div>
        <span />
      </header>

      <section className="iv-hero">
        <div className="iv-hero-glow" aria-hidden />
        <span className="iv-eyebrow">邀请有礼</span>
        <h2>分享专属链接，坐享直属返水</h2>
        <p>好友绑定并参与有效牌局后，返水自动计入您的账户</p>
      </section>

      <section className="iv-card">
        <div className="iv-profile">
          {data.avatarUrl ? (
            <img className="iv-avatar" src={data.avatarUrl} alt="" />
          ) : (
            <BrandLogo size={56} className="iv-avatar iv-avatar-logo" />
          )}
          <div className="iv-profile-copy">
            <strong>{data.nickname}</strong>
            <button
              type="button"
              className="iv-uid"
              onClick={() => {
                navigator.clipboard?.writeText(data.uid);
                flash('uid');
              }}
            >
              UID {data.uid}
              <em>{copied === 'uid' ? '已复制' : '复制'}</em>
            </button>
          </div>
        </div>

        <div className="iv-qr-shell">
          <div className="iv-qr-frame" id="invite-qr">
            <QRCodeCanvas value={data.deepLink} size={188} level="H" marginSize={1} />
          </div>
          <div className="iv-qr-caption">
            <strong>扫码加入至尊牛牛</strong>
            <span>使用 Telegram 打开即可绑定邀请关系</span>
          </div>
        </div>

        <div className="iv-actions">
          <button type="button" className="iv-btn ghost" onClick={saveQr}>
            保存二维码
          </button>
          <button type="button" className="iv-btn ghost" onClick={share}>
            Telegram 分享
          </button>
          <button
            type="button"
            className="iv-btn primary"
            onClick={() => {
              navigator.clipboard?.writeText(data.deepLink);
              flash('link');
            }}
          >
            {copied === 'link' ? '邀请链接已复制 ✓' : '复制专属邀请链接'}
          </button>
        </div>
      </section>

      <section className="iv-rules">
        <div className="iv-rules-head">
          <small>怎么绑定</small>
          <h3>绑定方式</h3>
        </div>
        <ol>
          <li>
            <b>1</b>
            <span>好友点击专属链接，邀请 UID 自动填入</span>
          </li>
          <li>
            <b>2</b>
            <span>也可在绑定页扫码，或手动输入您的 UID</span>
          </li>
          <li>
            <b>3</b>
            <span>邀请关系一经确认，不可自行更换</span>
          </li>
        </ol>
      </section>

      <p className="iv-legal">
        邀请好友即表示您已了解
        <LegalLinks />
        。
      </p>
    </div>
  );
}
