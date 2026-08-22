import { useEffect, useRef, type ReactNode } from 'react';

type AdminDialogProps = {
  open: boolean;
  title: string;
  copy?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onClose: () => void;
  onConfirm?: () => void;
  children?: ReactNode;
};

export default function AdminDialog({
  open,
  title,
  copy,
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger,
  busy,
  disabled,
  onClose,
  onConfirm,
  children,
}: AdminDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = panelRef.current?.querySelector<HTMLElement>('textarea, input, button');
    focusable?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="desk-overlay" role="presentation" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className="desk-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="desk-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <small>需要确认</small>
          <h3 id="desk-dialog-title">{title}</h3>
          {copy ? <p>{copy}</p> : null}
        </header>
        {children ? <div className="desk-dialog-body">{children}</div> : null}
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            {cancelLabel}
          </button>
          {onConfirm ? (
            <button
              type="button"
              className={danger ? 'danger' : 'primary'}
              disabled={busy || disabled}
              onClick={onConfirm}
            >
              {busy ? '处理中…' : confirmLabel}
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
