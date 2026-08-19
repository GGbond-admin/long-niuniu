export interface TgBackButton {
  isVisible?: boolean;
  show(): void;
  hide(): void;
  onClick(handler: () => void): void;
  offClick(handler: () => void): void;
}

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
  /** 当前可见高度（键盘弹出时通常会变矮） */
  viewportHeight?: number;
  viewportStableHeight?: number;
  safeAreaInset?: { top: number; bottom: number; left: number; right: number };
  contentSafeAreaInset?: { top: number; bottom: number; left: number; right: number };
  /** Telegram 顶栏原生返回键；二级页面显示，主页隐藏并保留「关闭」 */
  BackButton?: TgBackButton;
  onEvent?(event: string, handler: ((payload?: { isStateStable?: boolean }) => void) | (() => void)): void;
  offEvent?(event: string, handler: ((payload?: { isStateStable?: boolean }) => void) | (() => void)): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
  }
}

export function tg(): TgWebApp | null {
  return window.Telegram?.WebApp ?? null;
}

function isLocalDevHost(): boolean {
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/** Telegram 未注入时等一小会儿，避免 React 抢先渲染后误报「请从 Telegram 打开小程序」。 */
export function waitForTelegramWebApp(timeoutMs = 1200): Promise<void> {
  if (tg() || import.meta.env.DEV || isLocalDevHost()) return Promise.resolve();
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const tick = () => {
      if (tg() || Date.now() - startedAt >= timeoutMs) {
        resolve();
        return;
      }
      window.setTimeout(tick, 40);
    };
    tick();
  });
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
let viewportFrame = 0;
let composerFocused = false;
let exitedFullscreenForKeyboard = false;
let restoreFullscreenTimer = 0;
let preserveTelegramHeader = false;

function clearFullscreenRestoreTimer() {
  if (!restoreFullscreenTimer) return;
  window.clearTimeout(restoreFullscreenTimer);
  restoreFullscreenTimer = 0;
}

function isMobileTelegram(app: TgWebApp) {
  return app.platform === 'android' || app.platform === 'android_x' || app.platform === 'ios';
}

function canRequestFullscreen(app: TgWebApp) {
  try {
    return app.isVersionAtLeast?.('8.0') === true && typeof app.requestFullscreen === 'function';
  } catch {
    return false;
  }
}

function readVisibleViewport() {
  const app = tg();
  const vv = window.visualViewport;
  const inner = window.innerHeight;
  const telegramHeight =
    typeof app?.viewportHeight === 'number' && app.viewportHeight > 0 ? app.viewportHeight : null;
  const visualHeight = vv && vv.height > 0 ? vv.height : null;
  const offsetTop = vv ? Math.max(0, vv.offsetTop) : 0;

  let height = visualHeight ?? telegramHeight ?? inner;
  // Telegram 安卓键盘经常不改 visualViewport，只改 WebApp.viewportHeight
  if (telegramHeight && height - telegramHeight > 40) {
    height = telegramHeight;
  }
  if (offsetTop + height > inner + 1) {
    height = Math.max(240, inner - offsetTop);
  }

  return {
    height: Math.max(240, Math.round(height)),
    offsetTop: Math.round(offsetTop),
  };
}

function syncViewport() {
  viewportFrame = 0;
  const { height, offsetTop } = readVisibleViewport();
  writeCssVar('--app-viewport-height', height);
  writeCssVar('--app-viewport-offset-top', offsetTop);

  const activeElement = document.activeElement;
  const editableFocused =
    activeElement instanceof HTMLInputElement ||
    activeElement instanceof HTMLTextAreaElement ||
    activeElement?.getAttribute('contenteditable') === 'true';
  const viewportSuggestsKeyboard =
    offsetTop > 24 ||
    window.innerHeight - height > 80 ||
    (typeof tg()?.viewportStableHeight === 'number' &&
      typeof tg()?.viewportHeight === 'number' &&
      tg()!.viewportStableHeight! - tg()!.viewportHeight! > 80);
  const keyboardLikelyOpen =
    composerFocused || (editableFocused && viewportSuggestsKeyboard);
  document.body.classList.toggle('kb-open', keyboardLikelyOpen);
}

function scheduleViewportSync() {
  if (viewportFrame) window.cancelAnimationFrame(viewportFrame);
  viewportFrame = window.requestAnimationFrame(syncViewport);
}

function requestMobileFullscreen(app: TgWebApp) {
  if (
    preserveTelegramHeader
    || !isMobileTelegram(app)
    || !canRequestFullscreen(app)
    || app.isFullscreen
    || composerFocused
  ) {
    return;
  }
  try {
    app.requestFullscreen?.();
  } catch {
    // 老客户端/不支持的环境：保持 expand() 的效果即可
  }
}

/**
 * 输入框聚焦时退出真全屏并锁到可视区域。
 * Telegram 全屏 + 软键盘叠在一起时，安卓/iOS WebView 经常整页黑屏，输入栏和发送键被挡住。
 */
export function setChatInputFocus(focused: boolean) {
  composerFocused = focused;
  const app = tg();
  if (focused) {
    clearFullscreenRestoreTimer();
    if (app?.isFullscreen) {
      exitedFullscreenForKeyboard = true;
      try {
        app.exitFullscreen?.();
      } catch {
        // ignore
      }
    }
    document.body.classList.add('kb-open');
    scheduleViewportSync();
    return;
  }

  document.body.classList.remove('kb-open');
  scheduleViewportSync();
  if (!exitedFullscreenForKeyboard || !app) return;
  clearFullscreenRestoreTimer();
  restoreFullscreenTimer = window.setTimeout(() => {
    restoreFullscreenTimer = 0;
    if (composerFocused) return;
    exitedFullscreenForKeyboard = false;
    requestMobileFullscreen(app);
    scheduleViewportSync();
  }, 280);
}

/**
 * 聊天组件因路由切换被卸载时只清理键盘状态，不再请求恢复全屏。
 * 否则全屏切换会在榜单/奖励页期间改写可视高度，返回房间后底部被整体顶起。
 */
export function disposeChatInputFocus() {
  composerFocused = false;
  clearFullscreenRestoreTimer();
  exitedFullscreenForKeyboard = false;
  document.body.classList.remove('kb-open');
  scheduleViewportSync();
}

/**
 * 同步 Telegram 安全区与可视高度。
 * preserveTelegramHeader=true 时保留 Telegram 标准顶栏，供原生返回键使用；
 * 否则手机端可继续请求 Bot API 8.0+ 真全屏。
 * 同时同步 visualViewport / Telegram viewport，软键盘出现时聊天输入栏始终留在可视区内。
 */
export function initTelegramFullscreen(options?: {
  preserveTelegramHeader?: boolean;
}) {
  preserveTelegramHeader = options?.preserveTelegramHeader === true;
  // React StrictMode / Fast Refresh 会重复初始化；先移除旧监听，避免一次事件触发多次布局写入。
  disposeTelegramLayout?.();
  disposeTelegramLayout = null;

  const viewport = window.visualViewport;
  viewport?.addEventListener('resize', scheduleViewportSync);
  viewport?.addEventListener('scroll', scheduleViewportSync);
  window.addEventListener('resize', scheduleViewportSync);
  window.addEventListener('orientationchange', scheduleViewportSync);
  syncViewport();

  const app = tg();
  if (!app) {
    disposeTelegramLayout = () => {
      viewport?.removeEventListener('resize', scheduleViewportSync);
      viewport?.removeEventListener('scroll', scheduleViewportSync);
      window.removeEventListener('resize', scheduleViewportSync);
      window.removeEventListener('orientationchange', scheduleViewportSync);
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
    'viewportChanged',
  ];
  for (const event of telegramEvents) app.onEvent?.(event, syncLayout);
  disposeTelegramLayout = () => {
    for (const event of telegramEvents) app.offEvent?.(event, syncLayout);
    viewport?.removeEventListener('resize', scheduleViewportSync);
    viewport?.removeEventListener('scroll', scheduleViewportSync);
    window.removeEventListener('resize', scheduleViewportSync);
    window.removeEventListener('orientationchange', scheduleViewportSync);
    if (viewportFrame) window.cancelAnimationFrame(viewportFrame);
  };
  syncLayout();
  if (preserveTelegramHeader && app.isFullscreen) {
    try {
      app.exitFullscreen?.();
    } catch {
      // 客户端不支持退出时维持当前模式，页面内返回键仍会作为兜底保留。
    }
  } else {
    requestMobileFullscreen(app);
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
let volatileDeviceId: string | null = null;

export function getDeviceId(): string {
  const KEY = 'nn_device_id';
  try {
    const existing = localStorage.getItem(KEY);
    if (existing && existing.length >= 8) {
      volatileDeviceId = existing;
      return existing;
    }
    const id = volatileDeviceId ?? createDeviceUuid();
    localStorage.setItem(KEY, id);
    volatileDeviceId = id;
    return id;
  } catch {
    // 存储不可用时至少保证当前 WebView 生命周期内设备 ID 稳定。
    volatileDeviceId ??= createDeviceUuid();
    return volatileDeviceId;
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
