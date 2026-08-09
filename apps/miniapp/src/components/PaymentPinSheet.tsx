import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import PaymentPinInput from './PaymentPinInput';

export default function PaymentPinSheet({
  open,
  title,
  description,
  amount,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  amount?: string;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onConfirm: (pin: string) => void;
}) {
  const [pin, setPin] = useState('');
  const panelRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  busyRef.current = busy;
  onCloseRef.current = onClose;

  useEffect(() => {
    if (open) setPin('');
  }, [open]);

  useEffect(() => {
    if (error) setPin('');
  }, [error]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const appRoot = document.getElementById('root');
    appRoot?.setAttribute('inert', '');

    const focusableSelector =
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
      );
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    const focusFrame = window.requestAnimationFrame(() => {
      const pinInput = panelRef.current?.querySelector<HTMLInputElement>('.payment-pin-native');
      (pinInput ?? panelRef.current?.querySelector<HTMLElement>(focusableSelector))?.focus();
    });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown);
      appRoot?.removeAttribute('inert');
      previousFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div
      className="payment-pin-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pay-pin-title"
      aria-describedby="pay-pin-description"
    >
      <button
        type="button"
        className="payment-pin-backdrop"
        tabIndex={-1}
        aria-label="关闭支付密码"
        disabled={busy}
        onClick={onClose}
      />
      <section ref={panelRef} className="payment-pin-panel">
        <div className="payment-pin-handle" aria-hidden />
        <header>
          <span className="payment-pin-shield" aria-hidden>✓</span>
          <div>
            <small>安全验证</small>
            <h2 id="pay-pin-title">{title}</h2>
          </div>
          <button type="button" disabled={busy} onClick={onClose} aria-label="关闭">×</button>
        </header>
        <p id="pay-pin-description">{description}</p>
        {amount && <strong className="payment-pin-amount">{amount}</strong>}
        <PaymentPinInput
          value={pin}
          onChange={setPin}
          disabled={busy}
          autoFocus
          label="请输入六位支付密码"
        />
        {error && <div className="payment-pin-error" role="alert">{error}</div>}
        <button
          type="button"
          className="payment-pin-confirm"
          disabled={busy || pin.length !== 6}
          onClick={() => onConfirm(pin)}
        >
          {busy ? '验证中…' : '确认支付'}
        </button>
        <small className="payment-pin-safe-note">支付密码仅用于本次验证，不会保存在设备中</small>
      </section>
    </div>,
    document.body,
  );
}
