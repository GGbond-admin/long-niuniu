import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import ChatComposer from '../components/ChatComposer';

type Message = Awaited<ReturnType<typeof api.chatMessages>>['items'][number];
type Sticker = Awaited<ReturnType<typeof api.stickers>>['items'][number];

function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
      || left.id.localeCompare(right.id),
  );
}

export default function SupportChat() {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const didInitialScrollRef = useRef(false);
  const initializedRef = useRef(false);
  const streamRef = useRef<HTMLElement>(null);
  const preserveScrollRef = useRef<{ height: number; top: number } | null>(null);
  // 用户滚动时记录是否接近底部；发送自己的消息后强制贴底一次
  const nearBottomRef = useRef(true);
  const forceScrollRef = useRef(false);

  function trackScroll() {
    const el = streamRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  async function load() {
    try {
      const result = await api.chatMessages();
      if (!initializedRef.current) {
        initializedRef.current = true;
        setMessages(result.items);
        setNextCursor(result.nextCursor);
      } else {
        // 轮询只合并新消息，不能把用户已加载的历史页覆盖掉。
        setMessages((current) => mergeMessages(current, result.items));
      }
      setError('');
    } catch (err) {
      setError((err as Error).message || '消息加载失败');
    } finally {
      setReady(true);
    }
  }

  useEffect(() => {
    void load();
    void api
      .stickers()
      .then((result) => setStickers(result.items))
      .catch(() => undefined);
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const preserve = preserveScrollRef.current;
    if (preserve) {
      preserveScrollRef.current = null;
      requestAnimationFrame(() => {
        const el = streamRef.current;
        if (el) el.scrollTop = preserve.top + (el.scrollHeight - preserve.height);
      });
      return;
    }
    const isInitial = !didInitialScrollRef.current;
    // 仅进房、用户本就贴近底部、或刚发送自己的消息时才自动贴底，避免上翻历史被拽回
    if (!isInitial && !nearBottomRef.current && !forceScrollRef.current) return;
    forceScrollRef.current = false;
    const behavior: ScrollBehavior = isInitial ? 'auto' : 'smooth';
    requestAnimationFrame(() => {
      endRef.current?.scrollIntoView({ behavior, block: 'end' });
      didInitialScrollRef.current = true;
      nearBottomRef.current = true;
    });
  }, [messages, ready]);

  async function loadOlder() {
    if (!nextCursor || loadingOlder) return;
    const el = streamRef.current;
    if (el) preserveScrollRef.current = { height: el.scrollHeight, top: el.scrollTop };
    setLoadingOlder(true);
    setError('');
    try {
      const result = await api.chatMessages(nextCursor);
      setMessages((current) => mergeMessages(current, result.items));
      setNextCursor(result.nextCursor);
    } catch (err) {
      preserveScrollRef.current = null;
      setError((err as Error).message || '历史消息加载失败');
    } finally {
      setLoadingOlder(false);
    }
  }

  /** 返回 false 表示发送失败，输入框保留内容 */
  async function sendText(content: string): Promise<boolean> {
    if (!content) return false;
    setBusy(true);
    setError('');
    try {
      await api.sendChat({ type: 'TEXT', content });
      forceScrollRef.current = true;
      await load();
      return true;
    } catch (err) {
      setError((err as Error).message || '发送失败，请重试');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function sendSticker(stickerId: string) {
    setBusy(true);
    setError('');
    try {
      await api.sendChat({ type: 'STICKER', stickerId });
      forceScrollRef.current = true;
      await load();
    } catch (err) {
      setError((err as Error).message || '发送失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  function goBack() {
    try {
      sessionStorage.setItem('miniapp-tab', 'chat');
    } catch {
      // ignore
    }
    navigate('/');
  }

  return (
    <div className="chat-screen">
      <header className="chat-header">
        <button type="button" className="chat-back" onClick={goBack} aria-label="返回">
          ‹
        </button>
        <div className="chat-header-copy">
          <strong>至尊牛牛客服</strong>
          <small>
            <i />
            在线服务
          </small>
        </div>
      </header>

      <main className="message-stream" ref={streamRef} onScroll={trackScroll}>
        <div className="chat-date">加密客服会话</div>
        {!ready && <div className="empty-inline">加载中…</div>}
        {ready && nextCursor && (
          <button
            type="button"
            className="chat-load-older"
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
          >
            {loadingOlder ? '加载中…' : '加载更早消息'}
          </button>
        )}
        {error && !messages.length && <div className="inline-alert error">{error}</div>}
        {messages.map((message) => (
          <div
            className={`message ${message.senderType === 'USER' ? 'mine' : 'theirs'}`}
            key={message.id}
          >
            {message.type === 'STICKER' && message.assetUrl ? (
              <img
                className="sticker-message"
                src={message.assetUrl}
                alt={message.content ?? '动画表情'}
              />
            ) : (
              <p style={{ whiteSpace: 'pre-wrap' }}>{message.content}</p>
            )}
            <time>
              {new Date(message.createdAt).toLocaleTimeString('zh-MY', {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
              })}
            </time>
          </div>
        ))}
        <div ref={endRef} />
      </main>

      <footer className="chat-screen-footer">
        {error && messages.length > 0 && <div className="chat-error-bar">{error}</div>}
        <ChatComposer
          onSend={sendText}
          busy={busy}
          placeholder="输入消息…"
          stickers={stickers}
          onSendSticker={(id) => void sendSticker(id)}
          defaultToolTab="emoji"
        />
      </footer>
    </div>
  );
}
