import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { Session } from '../App';
import { LegalLinks } from './LegalDoc';

export default function BindInviter({ session, onDone }: { session: Session; onDone: () => Promise<void> }) {
  const [uid, setUid] = useState(session.pendingInviterUid ?? '');
  const [preview, setPreview] = useState<{ uid: string; nickname: string; avatarUrl?: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (session.pendingInviterUid) handlePreview(session.pendingInviterUid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!scanning || !videoRef.current) return;
    let controls: { stop(): void } | undefined;
    void import('@zxing/browser')
      .then(({ BrowserQRCodeReader }) => {
        const reader = new BrowserQRCodeReader();
        return reader.decodeFromVideoDevice(undefined, videoRef.current!, (result) => {
          if (!result) return;
          const text = result.getText();
          const matched =
            /ref_(\d{6,20})/.exec(text)?.[1] ?? (/^\d{6,20}$/.test(text) ? text : null);
          if (!matched) {
            setError('二维码中没有有效的邀请 UID');
            return;
          }
          setUid(matched);
          setScanning(false);
          controls?.stop();
          void handlePreview(matched);
        });
      })
      .then((nextControls) => {
        controls = nextControls;
      })
      .catch(() => {
        setScanning(false);
        setError('无法打开相机，请检查权限或手动输入 UID');
      });
    return () => controls?.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning]);

  async function handlePreview(value?: string) {
    const target = (value ?? uid).trim();
    if (!target) return;
    setError('');
    try {
      const res = await api.inviterPreview(target);
      setPreview(res.inviter);
    } catch {
      setPreview(null);
      setError('邀请人不存在，请核对 UID');
    }
  }

  async function handleBind() {
    if (!preview || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.bindInviter(preview.uid);
      await onDone();
      navigate('/bind-device', { replace: true });
    } catch (e) {
      const code = (e as Error & { code?: string }).code ?? (e as Error).message;
      if (code === 'ALREADY_BOUND') {
        await onDone();
        navigate('/bind-device', { replace: true });
        return;
      }
      const messages: Record<string, string> = {
        CANNOT_BIND_SELF: '不能绑定自己',
        INVITER_NOT_FOUND: '邀请人不存在或已停用',
        CIRCULAR_REFERRAL: '不能形成循环邀请关系',
      };
      setError(messages[code] ?? '绑定失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page subpage bi-page">
      <header className="bi-hero">
        <div className="bi-hero-glow" aria-hidden />
        <span className="bi-step">注册 · 第 1 步</span>
        <h1>绑定邀请人</h1>
        <p>输入邀请人 UID，或扫描对方邀请二维码完成关联</p>
      </header>

      <section className="bi-card">
        <p className="bi-warn">绑定后不可更换，请确认后再继续。</p>

        <label className="bi-field">
          <span>邀请人 UID</span>
          <input
            value={uid}
            placeholder="请输入 6 位以上数字 UID"
            onChange={(e) => {
              setUid(e.target.value.replace(/\D/g, '').slice(0, 20));
              setPreview(null);
              setError('');
            }}
            onBlur={() => void handlePreview()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handlePreview();
            }}
            inputMode="numeric"
            autoComplete="off"
            autoFocus
          />
        </label>

        <button
          type="button"
          className={`bi-scan ${scanning ? 'active' : ''}`}
          onClick={() => {
            setError('');
            setScanning((value) => !value);
          }}
        >
          {scanning ? '关闭扫码' : '扫描邀请二维码'}
        </button>

        {scanning && (
          <div className="bi-scanner">
            <video ref={videoRef} muted playsInline />
            <span>将二维码对准取景框</span>
          </div>
        )}

        {preview && (
          <div className="bi-preview">
            {preview.avatarUrl ? (
              <img src={preview.avatarUrl} alt="" />
            ) : (
              <div className="bi-preview-fallback" aria-hidden>
                {preview.nickname?.[0] ?? '牛'}
              </div>
            )}
            <div>
              <strong>{preview.nickname}</strong>
              <small>UID {preview.uid}</small>
            </div>
            <em>已确认</em>
          </div>
        )}

        {error && <div className="bi-error">{error}</div>}
      </section>

      {!preview ? (
        <button
          type="button"
          className="bi-cta"
          disabled={!uid.trim()}
          onClick={() => void handlePreview()}
        >
          下一步
        </button>
      ) : (
        <button type="button" className="bi-cta" disabled={busy} onClick={() => void handleBind()}>
          {busy ? '绑定中…' : '确认绑定'}
        </button>
      )}

      <p className="bi-legal">
        继续即表示您已阅读并同意
        <LegalLinks />
        。
      </p>
    </div>
  );
}
