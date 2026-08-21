import { useEffect, useId, useRef, useState } from 'react';
import { request, rm } from '../api';
import { userOptionAvailability, type UserPickerMode } from './userOptionAvailability';

export type { UserPickerMode };

export type UserOption = {
  id: string;
  uid: string;
  nickname: string | null;
  tgUsername: string | null;
  tgDisplayName: string | null;
  status: 'ACTIVE' | 'BANNED';
  availableCents: string;
  agent: { id: string; label: string; status: string } | null;
  binding: { agentId: string; agentLabel: string } | null;
};

export function userOptionName(user: UserOption): string {
  return (
    user.nickname?.trim() ||
    user.tgDisplayName?.trim() ||
    (user.tgUsername ? `@${user.tgUsername}` : '') ||
    `UID ${user.uid}`
  );
}

export default function UserPicker({
  value,
  mode,
  currentAgentId,
  placeholder,
  inlineResults = false,
  tone = 'light',
  onChange,
}: {
  value: UserOption | null;
  mode: UserPickerMode;
  currentAgentId?: string;
  placeholder: string;
  inlineResults?: boolean;
  tone?: 'light' | 'dark';
  onChange: (user: UserOption | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<UserOption[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    setQuery(value ? userOptionName(value) : '');
  }, [value?.id]);

  useEffect(() => {
    function closeOnOutsideClick(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
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
          const params = new URLSearchParams({ limit: '8', purpose: mode });
          if (query.trim()) params.set('q', query.trim());
          const result = await request<{ items: UserOption[] }>(
            `/api/admin/profit-pool/user-options?${params}`,
            { signal: controller.signal },
          );
          setItems(result.items);
          setActiveIndex(
            result.items.findIndex(
              (user) => userOptionAvailability(user, mode, currentAgentId).allowed,
            ),
          );
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
  }, [currentAgentId, mode, open, query]);

  function select(user: UserOption) {
    if (!userOptionAvailability(user, mode, currentAgentId).allowed) return;
    onChange(user);
    setQuery(userOptionName(user));
    setOpen(false);
  }

  function moveActive(delta: number) {
    const eligible = items
      .map((user, index) =>
        userOptionAvailability(user, mode, currentAgentId).allowed ? index : -1,
      )
      .filter((index) => index >= 0);
    if (!eligible.length) return;
    const position = eligible.indexOf(activeIndex);
    const next =
      position < 0
        ? delta > 0
          ? 0
          : eligible.length - 1
        : (position + delta + eligible.length) % eligible.length;
    setActiveIndex(eligible[next]);
  }

  return (
    <div
      className={`pp-user-picker ${inlineResults ? 'inline-results' : ''} ${tone === 'dark' ? 'is-dark' : ''}`}
      ref={rootRef}
    >
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
          aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
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
              moveActive(1);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              moveActive(-1);
            } else if (event.key === 'Enter' && open && activeIndex >= 0) {
              event.preventDefault();
              select(items[activeIndex]);
            } else if (event.key === 'Escape') {
              if (open) {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
              }
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

      {value && (
        <div className="pp-user-selected">
          <span>{userOptionName(value).slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{userOptionName(value)}</strong>
            <small>
              UID {value.uid}
              {value.tgUsername ? ` · @${value.tgUsername}` : ''}
              {value.binding && mode === 'agent' ? ` · 现属 ${value.binding.agentLabel}` : ''}
            </small>
          </div>
          <em>余额 RM {rm(value.availableCents)}</em>
          <b>{value.binding && mode === 'agent' ? '将解绑' : '已选择'}</b>
        </div>
      )}

      {open && (
        <div className="pp-user-options" id={listId} role="listbox">
          <header>
            <span>
              {query.trim()
                ? '搜索结果'
                : mode === 'agent'
                  ? '可直接设为第一层'
                  : '最近注册用户'}
            </span>
            <small>
              {mode === 'agent'
                ? '已归属的用户也可搜索后选择，提交时会先解绑'
                : '可搜索 UID、昵称或 Telegram'}
            </small>
          </header>
          {loadError ? (
            <div className="pp-user-empty error">{loadError}</div>
          ) : !loading && items.length === 0 ? (
            <div className="pp-user-empty">
              {mode === 'agent' && !query.trim()
                ? '暂时没有未归属用户。请搜索 UID，已归属其他代理的人也可以选。'
                : '没有找到匹配用户，请换关键词'}
            </div>
          ) : (
            items.map((user, index) => {
              const availability = userOptionAvailability(user, mode, currentAgentId);
              return (
                <button
                  type="button"
                  role="option"
                  id={`${listId}-${index}`}
                  key={user.id}
                  aria-selected={value?.id === user.id}
                  disabled={!availability.allowed}
                  className={activeIndex === index ? 'active' : ''}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    select(user);
                  }}
                  onMouseEnter={() => availability.allowed && setActiveIndex(index)}
                  onClick={() => select(user)}
                >
                  <span className="pp-user-avatar">
                    {userOptionName(user).slice(0, 1).toUpperCase()}
                  </span>
                  <span className="pp-user-identity">
                    <strong>{userOptionName(user)}</strong>
                    <small>
                      UID {user.uid}
                      {user.tgUsername ? ` · @${user.tgUsername}` : ''}
                    </small>
                  </span>
                  <span className="pp-user-option-meta">
                    <strong>RM {rm(user.availableCents)}</strong>
                    <small className={availability.allowed ? 'available' : ''}>
                      {availability.reason}
                    </small>
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
