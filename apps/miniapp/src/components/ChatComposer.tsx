import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { CHAT_EMOJIS } from '../constants/emojis';

export type ChatSticker = { id: string; name: string; url: string };

type PlusAction = {
  key: string;
  icon: ReactNode;
  iconClass?: string;
  label: string;
  onClick: () => void;
};

type Props = {
  /**
   * 发送回调：返回 false（或 resolve false）表示发送未成功，保留输入内容。
   * 草稿状态由本组件内部维护，避免父级（整页）每次按键都重渲染。
   */
  onSend: (content: string) => boolean | void | Promise<boolean | void>;
  disabled?: boolean;
  busy?: boolean;
  placeholder?: string;
  stickers: ChatSticker[];
  onSendSticker: (stickerId: string) => void;
  /** 游戏房投骰等内容，放在骰子页 */
  dicePanel?: ReactNode;
  /** 默认打开的工具页 */
  defaultToolTab?: 'dice' | 'emoji' | 'sticker';
  /** 右侧 + 菜单（不含发红包时由调用方自行过滤） */
  plusActions?: PlusAction[];
  maxLength?: number;
  /** 掷骰阶段等：高亮工具按钮 */
  toolsHighlight?: boolean;
};

/**
 * 统一聊天底部：🎮/⌨️ 工具栏 + 输入 + 发送 + 可选 +
 * 表情插入输入框；贴纸直接发送。
 */
export default function ChatComposer({
  onSend,
  disabled = false,
  busy = false,
  placeholder = '发送消息…',
  stickers,
  onSendSticker,
  dicePanel,
  defaultToolTab = 'emoji',
  plusActions,
  maxLength = 200,
  toolsHighlight = false,
}: Props) {
  const [value, setValue] = useState('');
  const [panel, setPanel] = useState<'tools' | 'plus' | null>(null);
  const [toolTab, setToolTab] = useState<'dice' | 'emoji' | 'sticker'>(
    dicePanel ? defaultToolTab : 'emoji',
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const showPlus = (plusActions?.length ?? 0) > 0;
  const showDice = !!dicePanel;

  function insertEmoji(emoji: string) {
    if (disabled) return;
    const el = inputRef.current;
    if (el) {
      const start = el.selectionStart ?? value.length;
      const end = el.selectionEnd ?? value.length;
      const next = `${value.slice(0, start)}${emoji}${value.slice(end)}`.slice(0, maxLength);
      const caret = Math.min(start + emoji.length, next.length);
      setValue(next);
      requestAnimationFrame(() => {
        try {
          el.setSelectionRange(caret, caret);
        } catch {
          // ignore
        }
      });
      return;
    }
    setValue(`${value}${emoji}`.slice(0, maxLength));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const content = value.trim();
    if (disabled || busy || !content) return;
    setPanel(null);
    const result = onSend(content);
    if (result instanceof Promise) {
      void result.then((ok) => {
        if (ok !== false) setValue('');
      });
      return;
    }
    if (result !== false) setValue('');
  }

  function toggleTools() {
    if (panel === 'tools') {
      setPanel(null);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    setPanel('tools');
    if (toolsHighlight && showDice) setToolTab('dice');
    else if (!showDice && toolTab === 'dice') setToolTab('emoji');
  }

  return (
    <div className="chat-composer-shell">
      <form className="game-room-composer" onSubmit={submit}>
        <button
          type="button"
          className={`composer-icon ${panel === 'tools' ? 'active' : ''} ${toolsHighlight && panel !== 'tools' ? 'highlight' : ''}`}
          aria-label={panel === 'tools' ? '收起工具，显示键盘' : '打开工具'}
          onClick={toggleTools}
        >
          {panel === 'tools' ? '⌨️' : '🎮'}
        </button>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value.slice(0, maxLength))}
          placeholder={placeholder}
          disabled={disabled}
          maxLength={maxLength}
        />
        <button type="submit" disabled={disabled || busy || !value.trim()}>
          发送
        </button>
        {showPlus && (
          <button
            type="button"
            className={`composer-icon ${panel === 'plus' ? 'active' : ''}`}
            aria-label="更多"
            onClick={() => setPanel(panel === 'plus' ? null : 'plus')}
          >
            ＋
          </button>
        )}
      </form>

      {panel === 'tools' && (
        <div className="tool-drawer">
          <div className="tool-tabs">
            {showDice && (
              <button
                type="button"
                className={toolTab === 'dice' ? 'active' : ''}
                onClick={() => setToolTab('dice')}
                aria-label="骰子"
              >
                🎲
              </button>
            )}
            <button
              type="button"
              className={toolTab === 'emoji' ? 'active' : ''}
              onClick={() => setToolTab('emoji')}
              aria-label="表情"
            >
              😀
            </button>
            <button
              type="button"
              className={toolTab === 'sticker' ? 'active' : ''}
              onClick={() => setToolTab('sticker')}
              aria-label="贴纸"
            >
              ✦
            </button>
          </div>

          {showDice && toolTab === 'dice' && <div className="dice-panel">{dicePanel}</div>}

          {toolTab === 'emoji' && (
            <div className="expression-panel emoji-panel">
              {disabled ? (
                <div className="empty-inline">当前不可发言</div>
              ) : (
                CHAT_EMOJIS.map((emoji) => (
                  <button key={emoji} type="button" onClick={() => insertEmoji(emoji)}>
                    {emoji}
                  </button>
                ))
              )}
            </div>
          )}

          {toolTab === 'sticker' && (
            <div className="expression-panel sticker-panel">
              {disabled ? (
                <div className="empty-inline">当前不可发言</div>
              ) : stickers.length === 0 ? (
                <div className="empty-inline">暂无动画贴纸</div>
              ) : (
                stickers.map((sticker) => (
                  <button
                    key={sticker.id}
                    type="button"
                    onClick={() => {
                      onSendSticker(sticker.id);
                      setPanel(null);
                    }}
                  >
                    <img src={sticker.url} alt={sticker.name} />
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {panel === 'plus' && showPlus && (
        <div className="plus-drawer">
          <div className="plus-actions">
            {plusActions!.map((action) => (
              <button
                key={action.key}
                type="button"
                onClick={() => {
                  setPanel(null);
                  action.onClick();
                }}
              >
                <span className={`plus-icon ${action.iconClass ?? ''}`.trim()}>{action.icon}</span>
                {action.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
