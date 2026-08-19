import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { backToTab } from '../lib/nav';

type NoticeItem = Awaited<ReturnType<typeof api.notices>>['items'][number];

export default function SystemNotices() {
  const navigate = useNavigate();
  const location = useLocation();
  const [items, setItems] = useState<NoticeItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [markingAll, setMarkingAll] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function load() {
    const data = await api.notices();
    setItems(data.items);
    setUnread(data.unread);
  }

  useEffect(() => {
    load()
      .catch((err) => setError((err as Error).message || '加载失败'))
      .finally(() => setLoading(false));
  }, []);

  async function openNotice(item: NoticeItem) {
    setExpanded((cur) => (cur === item.id ? null : item.id));
    if (!item.read) {
      try {
        await api.readNotice(item.id);
        setItems((list) =>
          list.map((row) => (row.id === item.id ? { ...row, read: true } : row)),
        );
        setUnread((n) => Math.max(0, n - 1));
      } catch {
        // ignore mark-read failures
      }
    }
  }

  async function markAll() {
    if (markingAll) return;
    setMarkingAll(true);
    try {
      await api.readAllNotices();
      setItems((list) => list.map((row) => ({ ...row, read: true })));
      setUnread(0);
    } catch {
      setError('标记已读失败，请稍后重试');
    } finally {
      setMarkingAll(false);
    }
  }

  return (
    <div className="page subpage">
      <header className="subpage-header">
        <button
          type="button"
          onClick={() => backToTab(navigate, location, 'chat')}
          aria-label="返回"
        >
          ‹
        </button>
        <div>
          <h1>系统通知</h1>
        </div>
        {unread > 0 ? (
          <button
            type="button"
            className="text-action"
            disabled={markingAll}
            onClick={() => void markAll()}
          >
            {markingAll ? '处理中…' : '全部已读'}
          </button>
        ) : (
          <span />
        )}
      </header>

      <p className="muted notice-hint">
        实名、奖励与资金状态会同步至此处；重要事项也可能通过 Telegram Bot 私聊提醒。
      </p>

      {loading && <div className="empty-inline">加载中…</div>}
      {error && <div className="inline-alert error">{error}</div>}

      {!loading && !error && (
        <div className="notice-list">
          {items.length === 0 ? (
            <div className="empty-inline">暂无系统通知</div>
          ) : (
            items.map((item) => {
              const open = expanded === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`notice-card${item.read ? '' : ' unread'}${open ? ' open' : ''}`}
                  onClick={() => void openNotice(item)}
                >
                  <div className="notice-card-top">
                    {!item.read && <i className="unread-dot" aria-hidden />}
                    <strong>{item.title}</strong>
                    <time>
                      {new Date(item.publishedAt).toLocaleString('zh-MY', {
                        hour12: false,
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </div>
                  <p className={open ? '' : 'clamp'}>{item.body}</p>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
