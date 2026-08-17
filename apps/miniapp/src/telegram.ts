export interface TgWebApp {
  initData: string;
  initDataUnsafe: { start_param?: string; user?: { id: number; first_name?: string } };
  ready(): void;
  expand(): void;
  /** Bot API 7.7+：关闭垂直轻扫，减少整页下拉/橡皮筋 */
  disableVerticalSwipes?: () => void;
  openTelegramLink(url: string): void;
  openLink?(url: string, options?: { try_instant_view?: boolean }): void;
  colorScheme: 'light' | 'dark';
  version?: string;
  platform?: string;
  isVersionAtLeast?(version: string): boolean;
  /** Bot API 8.0+：真全屏（盖住状态栏与 Telegram 顶栏） */
  requestFullscreen?(): void;
  exitFullscreen?(): void;
  isFullscreen?: boolean;
  safeAreaInset?: { top: number; bottom: number; left: number; right: number };
  contentSafeAreaInset?: { top: number; bottom: number; left: number; right: number };
  onEvent?(event: string, handler: () => void): void;
  offEvent?(event: string, handler: () => void): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
  }
}

export function tg(): TgWebApp | null {
  return window.Telegram?.WebApp ?? null;
}

function writeCssVar(name: string, px: number) {
  document.documentElement.style.setProperty(name, `${Math.max(0, Math.round(px))}px`);
}

/** 把 Telegram JS 安全区写进 CSS 变量，避免只靠官方脚本注入时偶发为 0 */
function syncTelegramSafeArea(app: TgWebApp) {
  const safe = app.safeAreaInset;
  const content = app.contentSafeAreaInset;
  if (safe) {
    writeCssVar('--tg-safe-area-inset-top', safe.top);
    writeCssVar('--tg-safe-area-inset-bottom', safe.bottom);
    writeCssVar('--tg-safe-area-inset-left', safe.left);
    writeCssVar('--tg-safe-area-inset-right', safe.right);
  }
  if (content) {
    writeCssVar('--tg-content-safe-area-inset-top', content.top);
    writeCssVar('--tg-content-safe-area-inset-bottom', content.bottom);
    writeCssVar('--tg-content-safe-area-inset-left', content.left);
    writeCssVar('--tg-content-safe-area-inset-right', content.right);
  }
}

let disposeTelegramLayout: (() => void) | null = null;

/**
 * 手机端进入即请求真全屏（Bot API 8.0+，Telegram 客户端 ≥ 11.0）。
 * 桌面端保持普通展开：桌面 requestFullscreen 会弹成独立全屏窗口，体验反而差。
 * 同时同步 visualViewport 高度，软键盘出现时聊天输入栏始终留在可视区内。
 */
export function initTelegramFullscreen() {
  // React StrictMode / Fast Refresh 会重复初始化；先移除旧监听，避免一次事件触发多次布局写入。
  disposeTelegramLayout?.();
  disposeTelegramLayout = null;

  const viewport = window.visualViewport;
  let viewportFrame = 0;
  const syncViewport = () => {
    viewportFrame = 0;
    writeCssVar('--app-viewport-height', viewport?.height ?? window.innerHeight);
  };
  const scheduleViewportSync = () => {
    if (viewportFrame) window.cancelAnimationFrame(viewportFrame);
    viewportFrame = window.requestAnimationFrame(syncViewport);
  };
  viewport?.addEventListener('resize', scheduleViewportSync);
  viewport?.addEventListener('scroll', scheduleViewportSync);
  window.addEventListener('resize', scheduleViewportSync);
  syncViewport();

  const app = tg();
  if (!app) {
    disposeTelegramLayout = () => {
      viewport?.removeEventListener('resize', scheduleViewportSync);
      viewport?.removeEventListener('scroll', scheduleViewportSync);
      window.removeEventListener('resize', scheduleViewportSync);
      if (viewportFrame) window.cancelAnimationFrame(viewportFrame);
    };
    return;
  }

  const syncLayout = () => {
    document.body.classList.toggle('tg-fullscreen', app.isFullscreen === true);
    syncTelegramSafeArea(app);
    scheduleViewportSync();
  };
  const telegramEvents = [
    'fullscreenChanged',
    'fullscreenFailed',
    'safeAreaChanged',
    'contentSafeAreaChanged',
  ];
  for (const event of telegramEvents) app.onEvent?.(event, syncLayout);
  disposeTelegramLayout = () => {
    for (const event of telegramEvents) app.offEvent?.(event, syncLayout);
    viewport?.removeEventListener('resize', scheduleViewportSync);
    viewport?.removeEventListener('scroll', scheduleViewportSync);
    window.removeEventListener('resize', scheduleViewportSync);
    if (viewportFrame) window.cancelAnimationFrame(viewportFrame);
  };
  syncLayout();

  const isMobile = app.platform === 'android' || app.platform === 'android_x' || app.platform === 'ios';
  let supported = false;
  try {
    supported = app.isVersionAtLeast?.('8.0') === true && typeof app.requestFullscreen === 'function';
  } catch {
    supported = false;
  }
  if (!isMobile || !supported || app.isFullscreen) return;
  try {
    app.requestFullscreen?.();
  } catch {
    // 老客户端/不支持的环境：保持 expand() 的效果即可
  }
}

export function getInitData(): string {
  const real = tg()?.initData ?? '';
  if (real) return real;
  // 开发模式：浏览器直开时用模拟身份（?devuser=1001&devname=xxx），仅后端 development 环境接受
  if (import.meta.env.DEV) {
    const q = new URLSearchParams(location.search);
    const id = q.get('devuser') ?? localStorage.getItem('nn_dev_user') ?? String(Math.floor(1000 + Math.random() * 9000));
    localStorage.setItem('nn_dev_user', id);
    const name = q.get('devname');
    return `dev:${id}${name ? `:${name}` : ''}`;
  }
  return '';
}

/** 旧安卓 WebView（Chrome < 92）无 crypto.randomUUID，需手动生成 */
function createDeviceUuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  } catch {
    // fall through
  }
  return `nn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** 设备指纹：localStorage UUID（服务端配合会话绑定校验） */
export function getDeviceId(): string {
  const KEY = 'nn_device_id';
  try {
    const existing = localStorage.getItem(KEY);
    if (existing && existing.length >= 8) return existing;
    const id = createDeviceUuid();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    // 无痕/禁用存储时仍保证登录可用（重启后会变，需重新绑设备）
    return createDeviceUuid();
  }
}

export function getBotUsername(): string | null {
  const key = 'nn_bot_username';
  const value = new URLSearchParams(location.search).get('bot')?.replace(/^@/, '') ?? '';
  if (/^[A-Za-z0-9_]{5,64}$/.test(value)) {
    localStorage.setItem(key, value);
    return value;
  }
  const stored = localStorage.getItem(key) ?? '';
  return /^[A-Za-z0-9_]{5,64}$/.test(stored) ? stored : null;
}

/** 在 Telegram 客户端内打开 t.me 邀请等链接；浏览器 fallback 到新窗 */
export function openTgLink(url: string) {
  if (!url) return;
  const app = tg();
  if (app?.openTelegramLink) {
    try {
      app.openTelegramLink(url);
      return;
    } catch {
      // fall through
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** 打开外部链接（如 TNG 红包）；优先 WebApp.openLink */
export function openExternalLink(url: string) {
  if (!url) return;
  const app = tg();
  if (app?.openLink) {
    try {
      app.openLink(url);
      return;
    } catch {
      // fall through
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** 深链 ref 参数：Telegram start_param 或 URL ?ref= */
export function getRefUid(): string | null {
  const sp = tg()?.initDataUnsafe?.start_param;
  const fromTg = sp && /^ref_(\d{6,20})$/.exec(sp)?.[1];
  if (fromTg) return fromTg;
  return new URLSearchParams(location.search).get('ref');
}
