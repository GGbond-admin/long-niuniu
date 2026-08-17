import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';

type ToastPayload = {
  id: string;
  preview: string;
  unread: number;
};

export default function SupportInboxToast() {
  const navigate = useNavigate();
  const location = useLocation();
  const [toast, setToast] = useState<ToastPayload | null>(null);
  const baseline = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const onSupportPath = location.pathname.startsWith('/support');
  const onGameRoomPath = /^\/game\/[^/]+\/play\/?$/.test(location.pathname);

  useEffect(() => {
    if (onSupportPath || onGameRoomPath) {
      setToast(null);
      return;
    }
    let cancelled = false;

    async function poll() {
      try {
        const result = await api.chatPreview();
        if (cancelled) return;
        const unread = Number(result.unread ?? 0);
        if (baseline.current === null) {
          baseline.current = unread;
          return;
        }
        const grew = unread > baseline.current;
        baseline.current = unread;
        if (!grew || unread <= 0) return;
        if (location.pathname.startsWith('/support')) return;

        const latest = result.latest;
        const fromStaff =
          latest?.senderType === 'SUPPORT' || latest?.senderType === 'SYSTEM';
        if (!fromStaff) return;

        const preview =
          latest.type === 'STICKER'
            ? '[动画表情]'
            : String(latest.content ?? '客服发来一条新消息').slice(0, 56);

        if (hideTimer.current) window.clearTimeout(hideTimer.current);
        setToast({ id: latest.id, preview, unread });
        hideTimer.current = window.setTimeout(() => setToast(null), 12_000);
      } catch {
        // ignore
      }
    }

    void poll();
    const timer = window.setInterval(() => void poll(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [location.pathname, onGameRoomPath, onSupportPath]);

  if (!toast || onSupportPath || onGameRoomPath) return null;

  return (
    <div className="support-inbox-toast" role="status" aria-live="polite">
      <button
        type="button"
        className="support-inbox-toast-body"
        onClick={() => {
          setToast(null);
          navigate('/support');
        }}
      >
        <small>客服消息{toast.unread > 1 ? ` · ${toast.unread}` : ''}</small>
        <strong>至尊牛牛客服</strong>
        <span>{toast.preview}</span>
        <em>点击查看 ›</em>
      </button>
      <button
        type="button"
        className="support-inbox-toast-close"
        aria-label="关闭"
        onClick={() => setToast(null)}
      >
        ✕
      </button>
    </div>
  );
}
