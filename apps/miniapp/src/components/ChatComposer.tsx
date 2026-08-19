import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { CHAT_EMOJIS } from '../constants/emojis';
import { disposeChatInputFocus, setChatInputFocus } from '../telegram';

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
  /** 当前是否可执行投骰，用于收紧不可用状态的面板 */
  diceAvailable?: boolean;
  /** 默认打开的工具页 */
  defaultToolTab?: 'dice' | 'emoji' | 'sticker';
  /** 右侧 + 菜单（不含发红包时由调用方自行过滤） */
  plusActions?: PlusAction[];
  maxLength?: number;
  /** 掷骰阶段等：高亮工具按钮 */
  toolsHighlight?: boolean;
  /** 竞庄/下注阶段：输入数字时显示金额预览，发送键改为对应动作 */
  amountMode?: 'bet' | 'bid' | null;
  /** 当前最高竞标额（分）。有值时校验玩家至少加价 RM100。 */
  bidHighCents?: number | null;
  /** 被群管理员禁言时，仅保留合法游戏指令输入，隐藏表情、贴纸和扩展动作。 */
  restrictedToGameCommands?: boolean;
  /** 头像艾特或选择回复时，请求插入文字并唤起输入框。 */
  inputRequest?: { id: number; insertText?: string };
  /** 当前选择的回复目标，仅用于输入区预览。 */
  replyPreview?: { nickname: string; content: string } | null;
  onCancelReply?: () => void;
};

function ToolGridIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="2" />
      <rect x="14" y="3.5" width="6.5" height="6.5" rx="2" />
      <rect x="3.5" y="14" width="6.5" height="6.5" rx="2" />
      <rect x="14" y="14" width="6.5" height="6.5" rx="2" />
    </svg>
  );
}

function KeyboardIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="2.75" y="5.25" width="18.5" height="13.5" rx="3" />
      <path d="M6.25 9h.01M9.5 9h.01M12.75 9h.01M16 9h.01M18.5 9h.01" />
      <path d="M6.25 12.25h.01M9.5 12.25h.01M12.75 12.25h.01M16 12.25h.01M18.5 12.25h.01" />
      <path d="M7.25 15.5h9.5" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4.25 5.1 20 12 4.25 18.9l2.25-5.35L14 12 6.5 10.45 4.25 5.1Z" />
    </svg>
  );
}

function DiceToolIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
      <circle cx="8.25" cy="8.25" r="1" />
      <circle cx="15.75" cy="8.25" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="8.25" cy="15.75" r="1" />
      <circle cx="15.75" cy="15.75" r="1" />
    </svg>
  );
}

function EmojiToolIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 10h.01M15.5 10h.01" />
      <path d="M8.5 14.25c1.05 1.25 2.18 1.75 3.5 1.75s2.45-.5 3.5-1.75" />
    </svg>
  );
}

function StickerToolIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 3.75h8.9c2.84 0 5.35 2.35 5.35 5.25v5.9a5.35 5.35 0 0 1-5.35 5.35H9A5.25 5.25 0 0 1 3.75 15V5A1.25 1.25 0 0 1 5 3.75Z" />
      <path d="M19.15 14.6h-3.3a1.25 1.25 0 0 0-1.25 1.25v4.3" />
      <path d="M8.1 9.25h.01M14.9 9.25h.01M8.8 13.1c.9.8 1.97 1.2 3.2 1.2" />
    </svg>
  );
}

function formatComposerRm(cents: number, wholeOnly = false) {
  return (cents / 100).toLocaleString('en-MY', {
    minimumFractionDigits: wholeOnly ? 0 : 2,
    maximumFractionDigits: wholeOnly ? 0 : 2,
  });
}

function readComposerAmount(value: string, amountMode: 'bet' | 'bid'): {
  kind: 'withdraw' | 'all_in' | 'amount';
  cents: number;
} | null {
  const trimmed = value.trim();
  if (trimmed === '0') {
    return amountMode === 'bet' ? { kind: 'withdraw', cents: 0 } : null;
  }
  const match = trimmed.match(/^(sh\s*)?(\d+)(?:\.(\d{1,2}))?$/i);
  if (!match) return null;
  if (amountMode === 'bid' && (match[1] || match[3] !== undefined)) return null;
  const whole = Number(match[2]);
  const fraction = Number((match[3] ?? '').padEnd(2, '0'));
  const cents = whole * 100 + fraction;
  if (!Number.isSafeInteger(cents) || cents <= 0) return null;
  return { kind: match[1] ? 'all_in' : 'amount', cents };
}

/**
 * 统一聊天底部：工具/键盘切换 + 输入 + 发送 + 可选 +
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
  diceAvailable = false,
  defaultToolTab = 'emoji',
  plusActions,
  maxLength = 200,
  toolsHighlight = false,
  amountMode = null,
  bidHighCents = null,
  restrictedToGameCommands = false,
  inputRequest,
  replyPreview = null,
  onCancelReply,
}: Props) {
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [panel, setPanel] = useState<'tools' | 'plus' | null>(null);
  const [toolTab, setToolTab] = useState<'dice' | 'emoji' | 'sticker'>(
    dicePanel ? defaultToolTab : 'emoji',
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const handledInputRequestRef = useRef<number | null>(null);
  const showPlus = !restrictedToGameCommands && (plusActions?.length ?? 0) > 0;
  const showDice = !!dicePanel;
  const sendBusy = busy || submitting;
  const normalizedValue = value.trim().replace(/,/g, '');
  const invalidBidDecimal =
    amountMode === 'bid' && /^\d+\.\d*$/.test(normalizedValue);
  const parsedAmount = amountMode
    ? readComposerAmount(value, amountMode)
    : null;
  const minimumBidCents =
    amountMode === 'bid'
    && typeof bidHighCents === 'number'
    && Number.isSafeInteger(bidHighCents)
    && bidHighCents > 0
      ? bidHighCents + 10_000
      : null;
  const invalidBidIncrement =
    parsedAmount?.kind === 'amount'
    && minimumBidCents !== null
    && parsedAmount.cents < minimumBidCents;
  const sendLabel = sendBusy
    ? '发送中'
    : parsedAmount?.kind === 'withdraw'
      ? '撤回'
      : parsedAmount?.kind === 'all_in'
        ? '梭哈'
        : parsedAmount
          ? amountMode === 'bid'
            ? '上庄'
            : '下注'
          : '发送';
  const amountPreview: {
    title: string;
    detail: string;
    invalid?: boolean;
  } | null = invalidBidDecimal
    ? {
        title: '竞庄金额只支持整数',
        detail: '请删除小数点及小数部分',
        invalid: true,
      }
    : invalidBidIncrement
      ? {
          title: `下一口最低 RM ${formatComposerRm(minimumBidCents!, true)}`,
          detail: `当前最高 RM ${formatComposerRm(bidHighCents!, true)} · 至少加 RM 100`,
          invalid: true,
        }
    : parsedAmount
      ? parsedAmount.kind === 'withdraw'
        ? { title: '撤回本局下注', detail: '冻结金额原路退回' }
        : parsedAmount.kind === 'all_in'
          ? { title: `梭哈 RM ${formatComposerRm(parsedAmount.cents)}`, detail: '按梭哈规则提交' }
          : {
              title: `${amountMode === 'bid' ? '竞庄' : '下注'} RM ${formatComposerRm(
                parsedAmount.cents,
                amountMode === 'bid',
              )}`,
              detail: '点右侧按钮提交',
            }
      : null;

  useEffect(() => {
    return disposeChatInputFocus;
  }, []);

  useEffect(() => {
    if (!disabled) return;
    setInputFocused(false);
    setPanel(null);
    inputRef.current?.blur();
    setChatInputFocus(false);
  }, [disabled]);

  useEffect(() => {
    if (!restrictedToGameCommands) return;
    setPanel(null);
    if (showDice && diceAvailable) setToolTab('dice');
  }, [restrictedToGameCommands, showDice, diceAvailable]);

  useEffect(() => {
    if (
      !inputRequest
      || handledInputRequestRef.current === inputRequest.id
      || disabled
    ) {
      return;
    }
    handledInputRequestRef.current = inputRequest.id;
    setPanel(null);
    if (inputRequest.insertText) {
      setValue((current) => {
        const separator = current && !/\s$/.test(current) ? ' ' : '';
        return `${current}${separator}${inputRequest.insertText}`.slice(0, maxLength);
      });
    }
    requestAnimationFrame(() => {
      const input = inputRef.current;
      input?.focus();
      if (!input) return;
      try {
        input.setSelectionRange(input.value.length, input.value.length);
      } catch {
        // ignore old WebView selection errors
      }
    });
  }, [disabled, inputRequest, maxLength]);

  function markInputFocus(focused: boolean) {
    setInputFocused(focused);
    setChatInputFocus(focused);
    if (!focused) return;
    requestAnimationFrame(() => {
      inputRef.current?.scrollIntoView({ block: 'end', inline: 'nearest' });
    });
  }

  function insertEmoji(emoji: string) {
    if (disabled || restrictedToGameCommands) return;
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
    if (disabled || sendBusy || !content || invalidBidDecimal || invalidBidIncrement) return;
    setPanel(null);
    try {
      const result = onSend(content);
      if (result instanceof Promise) {
        setSubmitting(true);
        void result
          .then((ok) => {
            if (ok !== false) {
              setValue((current) => (current.trim() === content ? '' : current));
            } else {
              requestAnimationFrame(() => inputRef.current?.focus());
            }
          })
          .catch(() => {
            requestAnimationFrame(() => inputRef.current?.focus());
          })
          .finally(() => setSubmitting(false));
        return;
      }
      if (result !== false) setValue('');
    } catch {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  function toggleTools() {
    if (panel === 'tools') {
      setPanel(null);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    inputRef.current?.blur();
    setPanel('tools');
    if (toolsHighlight && showDice) setToolTab('dice');
    else if (!showDice && toolTab === 'dice') setToolTab('emoji');
  }

  return (
    <div className="chat-composer-shell">
      {replyPreview && (
        <div className="composer-reply-preview" role="status">
          <div>
            <strong>回复 {replyPreview.nickname}</strong>
            <span>{replyPreview.content}</span>
          </div>
          <button type="button" aria-label="取消回复" onClick={onCancelReply}>
            ×
          </button>
        </div>
      )}
      {amountPreview && (
        <div
          className={`composer-amount-preview${amountPreview.invalid ? ' invalid' : ''}`}
          role="status"
        >
          <strong>{amountPreview.title}</strong>
          <small>{amountPreview.detail}</small>
        </div>
      )}
      <form
        className={`game-room-composer${inputFocused ? ' keyboard-open' : ''}${restrictedToGameCommands ? ' command-only' : ''}`}
        onSubmit={submit}
      >
        <button
          type="button"
          className={`composer-icon ${panel === 'tools' ? 'active' : ''} ${toolsHighlight && panel !== 'tools' ? 'highlight' : ''}`}
          aria-label={panel === 'tools' ? '收起工具，显示键盘' : '打开工具'}
          onClick={toggleTools}
          disabled={
            sendBusy
            || (restrictedToGameCommands && !(showDice && diceAvailable))
          }
        >
          {panel === 'tools' ? <KeyboardIcon /> : <ToolGridIcon />}
        </button>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value.slice(0, maxLength))}
          onFocus={() => {
            setPanel(null);
            markInputFocus(true);
          }}
          onBlur={() => markInputFocus(false)}
          placeholder={placeholder}
          aria-label={
            replyPreview
              ? `回复 ${replyPreview.nickname}`
              : amountMode === 'bid'
                ? '竞庄金额'
                : amountMode === 'bet'
                  ? '下注金额'
                  : '消息输入框'
          }
          disabled={disabled}
          aria-busy={sendBusy}
          aria-invalid={invalidBidDecimal || invalidBidIncrement || undefined}
          maxLength={maxLength}
          inputMode={amountMode === 'bid' ? 'numeric' : 'text'}
          enterKeyHint="send"
          autoComplete="off"
          autoCorrect="off"
        />
        {inputFocused || !showPlus ? (
          <button
            type="submit"
            className={`composer-send${sendBusy ? ' busy' : ''}`}
            aria-label={sendLabel}
            title={sendLabel}
            disabled={
              disabled
              || sendBusy
              || !value.trim()
              || invalidBidDecimal
              || invalidBidIncrement
            }
            onPointerDown={(event) => event.preventDefault()}
          >
            <SendIcon />
          </button>
        ) : (
          <button
            type="button"
            className={`composer-icon composer-more ${panel === 'plus' ? 'active' : ''}`}
            aria-label="更多"
            disabled={sendBusy}
            onClick={() => {
              if (panel === 'plus') {
                setPanel(null);
                requestAnimationFrame(() => inputRef.current?.focus());
                return;
              }
              inputRef.current?.blur();
              setPanel('plus');
            }}
          >
            ＋
          </button>
        )}
      </form>

      {panel === 'tools' && (
        <div className="tool-drawer">
          <div className={`tool-tabs${showDice ? ' has-dice' : ''}`} role="tablist">
            {showDice && (
              <button
                type="button"
                className={toolTab === 'dice' ? 'active' : ''}
                onClick={() => setToolTab('dice')}
                aria-label="骰子"
                aria-selected={toolTab === 'dice'}
                role="tab"
              >
                <DiceToolIcon />
                <span>骰子</span>
              </button>
            )}
            {!restrictedToGameCommands && (
              <>
                <button
                  type="button"
                  className={toolTab === 'emoji' ? 'active' : ''}
                  onClick={() => setToolTab('emoji')}
                  aria-label="表情"
                  aria-selected={toolTab === 'emoji'}
                  role="tab"
                >
                  <EmojiToolIcon />
                  <span>表情</span>
                </button>
                <button
                  type="button"
                  className={toolTab === 'sticker' ? 'active' : ''}
                  onClick={() => setToolTab('sticker')}
                  aria-label="贴纸"
                  aria-selected={toolTab === 'sticker'}
                  role="tab"
                >
                  <StickerToolIcon />
                  <span>贴纸</span>
                </button>
              </>
            )}
          </div>

          {showDice && toolTab === 'dice' && (
            <div
              className={`dice-panel ${diceAvailable ? 'ready' : 'unavailable'}`}
              role="tabpanel"
              aria-label="骰子"
            >
              {dicePanel}
            </div>
          )}

          {toolTab === 'emoji' && (
            <div className="expression-panel emoji-panel" role="tabpanel" aria-label="表情">
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
            <div className="expression-panel sticker-panel" role="tabpanel" aria-label="贴纸">
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
