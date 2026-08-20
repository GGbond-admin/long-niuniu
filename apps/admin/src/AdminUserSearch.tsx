import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { request, rm } from './api';

export type AdminUserHit = {
  id: string;
  uid: string;
  nickname: string | null;
  tgUsername?: string | null;
  tgDisplayName?: string | null;
  status: 'ACTIVE' | 'BANNED' | string;
  wallet?: { availableCents?: string | number } | null;
};

export function adminUserName(user: AdminUserHit): string {
  return (
    user.nickname?.trim() ||
    user.tgDisplayName?.trim() ||
    (user.tgUsername ? `@${user.tgUsername}` : '') ||
    `UID ${user.uid}`
  );
}

export default function AdminUserSearch({
  value,
  placeholder = '搜索 UID、昵称或 Telegram',
  onChange,
}: {
  value: AdminUserHit | null;
  placeholder?: string;
  onChange: (user: AdminUserHit | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<AdminUserHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuBox, setMenuBox] = useState({ top: 0, left: 0, width: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    setQuery(value ? adminUserName(value) : '');
  }, [value?.id]);

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const maxHeight = 280;
      const gap = 6;
      const below = window.innerHeight - rect.bottom - 12;
      const openUp = below < maxHeight && rect.top > below;
      setMenuBox({
        top: openUp ? Math.max(12, rect.top - maxHeight - gap) : rect.bottom + gap,
        left: rect.left,
        width: rect.width,
      });
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, query, items.length]);

  useEffect(() => {
    function closeOnOutsideClick(event: PointerEvent) {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, []);

  useEffect(() => {
    if (!open) {
      setLoading(false);
      return;
    }
    let controller: AbortController | undefined;
    const timer = window.setTimeout(
      async () => {
        controller = new AbortController();
        setLoading(true);
        setLoadError('');
        try {
          const params = new URLSearchParams({ page: '1', pageSize: '8' });
          if (query.trim()) params.set('q', query.trim());
          const result = await request<{ items: AdminUserHit[] }>(`/api/admin/users?${params}`, {
            signal: controller.signal,
          });
          setItems(result.items);
          setActiveIndex(0);
        } catch (error) {
          if ((error as Error).name !== 'AbortError') {
            setItems([]);
            setLoadError('用户读取失败，请重新搜索');
          }
        } finally {
          if (!controller.signal.aborted) setLoading(false);
        }
      },
      query.trim() ? 220 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller?.abort();
    };
  }, [open, query]);

  function select(user: AdminUserHit) {
    onChange(user);
    setQuery(adminUserName(user));
    setOpen(false);
    window.requestAnimationFrame(() => {
      (rootRef.current?.querySelector('input') as HTMLInputElement | null)?.blur();
    });
  }

  const menu = open
    ? createPortal(
        <div
          ref={menuRef}
          className="pp-user-options admin-user-menu"
          id={listId}
          role="listbox"
          style={{ top: menuBox.top, left: menuBox.left, width: menuBox.width }}
        >
          <header>
            <span>{query.trim() ? '搜索结果' : '最近注册用户'}</span>
            <small>可搜 UID、昵称或 Telegram</small>
          </header>
          {loadError ? (
            <div className="pp-user-empty error">{loadError}</div>
          ) : !loading && items.length === 0 ? (
            <div className="pp-user-empty">没有找到匹配用户，请换关键词</div>
          ) : (
            items.map((user, index) => (
              <button
                type="button"
                role="option"
                id={`${listId}-${index}`}
                key={user.id}
                aria-selected={value?.id === user.id}
                className={activeIndex === index ? 'active' : ''}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => select(user)}
              >
                <span className="pp-user-avatar">{adminUserName(user).slice(0, 1).toUpperCase()}</span>
                <span className="pp-user-identity">
                  <strong>{adminUserName(user)}</strong>
                  <small>
                    UID {user.uid}
                    {user.tgUsername ? ` · @${user.tgUsername}` : ''}
                    {user.status === 'BANNED' ? ' · 已封禁' : ''}
                  </small>
                </span>
                <span className="pp-user-option-meta">
                  <strong>RM {rm(user.wallet?.availableCents ?? 0)}</strong>
                  <small className="available">可用余额</small>
                </span>
              </button>
            ))
          )}
        </div>,
        document.body,
      )
    : null;

  return (
    <div className="pp-user-picker admin-user-search" ref={rootRef}>
      <div className={`pp-user-search ${value ? 'selected' : ''}`}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>
        <input
          value={query}
          role="combobox"
          aria-label={placeholder}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          autoComplete="off"
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            if (value) onChange(null);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) => Math.min(index + 1, Math.max(items.length - 1, 0)));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex((index) => Math.max(index - 1, 0));
            } else if (event.key === 'Enter' && open && items[activeIndex]) {
              event.preventDefault();
              select(items[activeIndex]);
            } else if (event.key === 'Escape') {
              setOpen(false);
            }
          }}
        />
        {loading && <span className="pp-user-spinner" aria-label="正在读取用户" />}
        {value && !loading && (
          <button
            type="button"
            className="pp-user-clear"
            aria-label="清除已选用户"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onChange(null);
              setQuery('');
              setOpen(true);
            }}
          >
            ×
          </button>
        )}
      </div>
      {menu}
    </div>
  );
}
