import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  type Location,
} from 'react-router-dom';
import {
  api,
  DEVICE_SESSION_INVALID_EVENT,
  getToken,
  setToken,
} from './api';
import {
  getBotUsername,
  getDeviceId,
  getInitData,
  getRefUid,
  initTelegramFullscreen,
  openTgLink,
  tg,
} from './telegram';
import { getCachedSession, setCachedSession, type Session } from './sessionStore';
import Tabs from './pages/Tabs';
import BrandSplash from './components/BrandSplash';
import SupportInboxToast from './components/SupportInboxToast';

const BindInviter = lazy(() => import('./pages/BindInviter'));
const BindDevice = lazy(() => import('./pages/BindDevice'));
const KycForm = lazy(() => import('./pages/KycForm'));
const Promotion = lazy(() => import('./pages/Promotion'));
const InviteFriends = lazy(() => import('./pages/InviteFriends'));
const AgentReport = lazy(() => import('./pages/AgentReport'));
const AgentPlayers = lazy(() => import('./pages/AgentPlayers'));
const AgentSubagents = lazy(() => import('./pages/AgentSubagents'));
const GameDetail = lazy(() => import('./pages/GameDetail'));
const GameRoom = lazy(() => import('./pages/GameRoom'));
const PacketDetail = lazy(() => import('./pages/PacketDetail'));
const SendRedPacket = lazy(() => import('./pages/SendRedPacket'));
const TipSupport = lazy(() => import('./pages/TipSupport'));
const Leaderboards = lazy(() => import('./pages/Leaderboards'));
const Rewards = lazy(() => import('./pages/Rewards'));
const SupportChat = lazy(() => import('./pages/SupportChat'));
const WalletOrders = lazy(() => import('./pages/WalletOrders'));
const FundDetails = lazy(() => import('./pages/FundDetails'));
const Deposit = lazy(() => import('./pages/Deposit'));
const Withdraw = lazy(() => import('./pages/Withdraw'));
const WithdrawAccounts = lazy(() => import('./pages/WithdrawAccounts'));
const LegalDoc = lazy(() => import('./pages/LegalDoc'));
const SystemNotices = lazy(() => import('./pages/SystemNotices'));
const ProfileDetail = lazy(() => import('./pages/ProfileDetail'));
const ProfileTelegram = lazy(() => import('./pages/ProfileTelegram'));
const Settings = lazy(() => import('./pages/Settings'));
const PaymentPinSettings = lazy(() => import('./pages/PaymentPinSettings'));
const DeviceManagement = lazy(() => import('./pages/DeviceManagement'));
const LegalCenter = lazy(() => import('./pages/LegalCenter'));
const GameAdminHome = lazy(() => import('./pages/GameAdminHome'));
const GameAdminConsole = lazy(() => import('./pages/GameAdminConsole'));
const GameAdminSendPacket = lazy(() => import('./pages/GameAdminSendPacket'));

export type { Session } from './sessionStore';

function DefaultGameRedirect({
  destination,
}: {
  destination: 'rules' | 'rewards' | 'leaderboards';
}) {
  const [roomId, setRoomId] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .lobby()
      .then((lobby) => {
        if (alive) setRoomId(lobby.games[0]?.id ?? '');
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (failed) return <Navigate to="/" replace />;
  if (!roomId) return <BrandSplash hint="正在进入游戏…" />;
  const path =
    destination === 'rules'
      ? `/game/${roomId}`
      : `/game/${roomId}/${destination}`;
  return <Navigate to={path} replace />;
}

function RoomFullscreenOverlay({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector =
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || document.querySelector('.payment-pin-sheet')) return;
      const overlay = overlayRef.current;
      if (!overlay) return;
      const controls = Array.from(
        overlay.querySelectorAll<HTMLElement>(focusableSelector),
      );
      if (!controls.length) {
        event.preventDefault();
        overlay.focus({ preventScroll: true });
        return;
      }
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !overlay.contains(active))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (active === last || !overlay.contains(active))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', trapFocus);
    const focusFrame = window.requestAnimationFrame(() => {
      const firstControl =
        overlayRef.current?.querySelector<HTMLElement>(focusableSelector);
      (firstControl ?? overlayRef.current)?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', trapFocus);
      window.requestAnimationFrame(() => {
        const fallback = document.querySelector<HTMLElement>(
          '.game-room:not([inert]) button[aria-label="更多"]',
        );
        const target =
          previousFocus?.isConnected && previousFocus !== document.body
            ? previousFocus
            : fallback;
        target?.focus({ preventScroll: true });
      });
    };
  }, []);

  return (
    <div
      ref={overlayRef}
      className="room-fullscreen-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
    >
      {children}
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(() =>
    getToken() ? getCachedSession() : null,
  );
  const [error, setError] = useState('');
  // 设备不匹配时被挡在登录外，进不了站内客服，需要给出 Bot 私聊出口
  const [errorNeedsSupport, setErrorNeedsSupport] = useState(false);
  // DEVICE_MISMATCH 时允许凭支付密码自助换绑到本机
  const [canSelfRebind, setCanSelfRebind] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const backgroundLocation = (
    location.state as { backgroundLocation?: Location } | null
  )?.backgroundLocation;
  const bootRef = useRef(false);

  useEffect(() => {
    let reloading = false;
    const recoverDeviceSession = (event: Event) => {
      if (reloading) return;
      const code = (event as CustomEvent<{ code?: string }>).detail?.code;
      // 设备被后台解绑：token 对绑定流程仍有效，直接引导重新绑定，避免刷新循环
      if (code === 'DEVICE_REBIND_REQUIRED') {
        setSession((current) => {
          if (!current) return current;
          const next = {
            ...current,
            onboarding: { ...current.onboarding, deviceBound: false },
          };
          setCachedSession(next);
          return next;
        });
        navigate('/bind-device', { replace: true });
        return;
      }
      // 旧机/存储异常时反复 DEVICE_* 会把页面刷成死循环；短窗口内只提示一次
      const stampKey = 'nn_device_recover_at';
      const now = Date.now();
      try {
        const last = Number(sessionStorage.getItem(stampKey) || '0');
        if (last && now - last < 12_000) {
          setToken(null);
          setCachedSession(null);
          setSession(null);
          setError('设备会话异常，请完全关闭小程序后重新打开');
          return;
        }
        sessionStorage.setItem(stampKey, String(now));
      } catch {
        // ignore storage errors
      }
      reloading = true;
      setToken(null);
      setCachedSession(null);
      setSession(null);
      window.location.reload();
    };
    window.addEventListener(DEVICE_SESSION_INVALID_EVENT, recoverDeviceSession);
    return () =>
      window.removeEventListener(DEVICE_SESSION_INVALID_EVENT, recoverDeviceSession);
  }, [navigate]);

  useEffect(() => {
    const app = tg();
    app?.ready();
    app?.expand();
    app?.disableVerticalSwipes?.();
    initTelegramFullscreen();
  }, []);

  useEffect(() => {
    const app = tg();
    const nativeBack = app?.BackButton;
    const nativeClass = 'tg-native-back-visible';
    if (!app || !nativeBack) {
      document.body.classList.remove(nativeClass);
      return;
    }

    const onNativeBack = () => {
      // 每个页面现有的返回函数包含确认、离房、目标 Tab 等业务语义；
      // Telegram 原生按钮只接管视觉入口，实际复用当前最上层页面的返回行为。
      const pageBack = Array.from(
        document.querySelectorAll<HTMLButtonElement>('button[aria-label="返回"]'),
      )
        .reverse()
        .find(
          (button) =>
            button.isConnected
            && !button.disabled
            && !button.closest('[inert], [aria-hidden="true"]'),
        );
      if (pageBack) {
        pageBack.click();
        return;
      }
      if (location.key !== 'default') navigate(-1);
      else navigate('/', { replace: true });
    };

    // BackButton 需要 Bot API 6.1+；老客户端 show() 只告警不抛错，
    // 若不显式判版本会误加隐藏类，把页内返回键也藏掉导致无法返回。
    let backButtonSupported = false;
    try {
      backButtonSupported = app.isVersionAtLeast?.('6.1') === true;
    } catch {
      backButtonSupported = false;
    }

    const syncNativeBack = () => {
      // 全屏（Bot API 8.0+）下同样生效：左上角胶囊会从「关闭」切换成返回箭头，
      // iOS 与安卓行为一致；主页保持隐藏，让用户可以直接关闭小程序。
      const shouldShow = backButtonSupported && location.pathname !== '/';
      if (!shouldShow) {
        document.body.classList.remove(nativeClass);
        try {
          nativeBack.hide();
        } catch {
          // 老客户端保留页面内返回键兜底
        }
        return;
      }
      try {
        nativeBack.show();
        document.body.classList.add(nativeClass);
      } catch {
        document.body.classList.remove(nativeClass);
      }
    };

    nativeBack.onClick(onNativeBack);
    app.onEvent?.('fullscreenChanged', syncNativeBack);
    syncNativeBack();
    return () => {
      nativeBack.offClick(onNativeBack);
      app.offEvent?.('fullscreenChanged', syncNativeBack);
      document.body.classList.remove(nativeClass);
      try {
        nativeBack.hide();
      } catch {
        // ignore
      }
    };
  }, [location.key, location.pathname, navigate]);

  useEffect(() => {
    // Fast Refresh / 严格模式重挂载时不要重复打登录并把界面打回「加载中…」
    if (bootRef.current && getCachedSession() && getToken()) return;
    bootRef.current = true;

    const initData = getInitData();
    if (!initData) {
      setError('请从 Telegram 打开小程序');
      return;
    }
    let deviceId = '';
    try {
      deviceId = getDeviceId();
    } catch (e) {
      setError(e instanceof Error ? e.message : '设备标识初始化失败');
      return;
    }
    api
      .login(initData, deviceId, getBotUsername() ?? undefined)
      .then((res) => {
        setToken(res.token);
        const s: Session = {
          ...res.user,
          onboarding: res.onboarding,
          security: res.security,
          pendingInviterUid: res.pendingInviterUid ?? getRefUid(),
        };
        setCachedSession(s);
        setSession(s);
        // 注册准入只要求邀请人 + 设备；实名认证改为进入主界面后由钱包触发。
        if (!s.onboarding.inviterBound) navigate('/bind-inviter', { replace: true });
        else if (!s.onboarding.deviceBound) navigate('/bind-device', { replace: true });
      })
      .catch(async (e) => {
        const code = (e as { code?: string }).code;
        if (code === 'DEVICE_MISMATCH') {
          // 也可能是本机缓存被清导致设备标识变化；提供支付密码自助换绑 + 客服兜底
          setToken(null);
          setCachedSession(null);
          setSession(null);
          setError(
            '此账号已绑定其他设备。若您正在使用原设备，可能是本机缓存被清除',
          );
          setErrorNeedsSupport(true);
          setCanSelfRebind(true);
          return;
        }
        // 登录失败时不能默默沿用本地缓存：token 可能已过期，后续操作会莫名失败。
        // 先验证旧 token，仍有效则继续；无效则清空会话并给出可重试的错误。
        if (getCachedSession() && getToken()) {
          try {
            await api.me();
            return;
          } catch {
            setToken(null);
            setCachedSession(null);
            setSession(null);
          }
        }
        setError((e as Error).message || '登录失败，请重试');
      });
  }, [navigate]);

  const refresh = useCallback(async () => {
    const me = await api.me();
    setSession((s) => {
      if (!s) return s;
      const next = {
        ...s,
        uid: me.user.uid,
        nickname: me.user.nickname,
        avatarUrl: me.user.avatarUrl,
        onboarding: me.onboarding,
        security: me.security,
      };
      setCachedSession(next);
      return next;
    });
  }, []);

  const completePaymentPin = useCallback(async () => {
    const current = getCachedSession();
    if (current) {
      const next = {
        ...current,
        security: {
          ...current.security,
          paymentPinSet: true,
          paymentPinLockedUntil: null,
        },
      };
      setCachedSession(next);
      setSession(next);
    }
    await refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    if (!session || !getToken()) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refresh().catch(() => undefined);
    };
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [session, refresh]);

  useEffect(() => {
    if (!session) return;
    const idle = window.setTimeout(() => {
      void import('./pages/GameRoom');
    }, 3_500);
    return () => window.clearTimeout(idle);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    if (!session.onboarding.inviterBound) {
      if (location.pathname !== '/bind-inviter') navigate('/bind-inviter', { replace: true });
      return;
    }
    if (!session.onboarding.deviceBound) {
      if (location.pathname !== '/bind-device') navigate('/bind-device', { replace: true });
      return;
    }
    const canOpenWithoutPin =
      location.pathname === '/settings/payment-pin' ||
      location.pathname === '/settings/legal' ||
      location.pathname === '/settings/banks' ||
      location.pathname === '/kyc' ||
      location.pathname === '/support' ||
      location.pathname.startsWith('/legal/');
    if (
      session.onboarding.kycStatus === 'APPROVED' &&
      !session.security.paymentPinSet &&
      !canOpenWithoutPin
    ) {
      navigate('/settings/payment-pin', {
        replace: true,
        state: { returnTo: `${location.pathname}${location.search}` },
      });
    }
  }, [location.pathname, location.search, navigate, session]);

  if (error) {
    const botUsername = getBotUsername();
    return (
      <div className="loading">
        <div>
          <p style={{ marginBottom: 14 }}>{error}</p>
          {canSelfRebind && <SelfRebindForm />}
          <button
            className="primary-action"
            type="button"
            onClick={() => window.location.reload()}
          >
            重试
          </button>
          {errorNeedsSupport && botUsername && (
            <button
              className="primary-action"
              type="button"
              style={{ marginTop: 10 }}
              onClick={() => openTgLink(`https://t.me/${botUsername}`)}
            >
              联系客服
            </button>
          )}
        </div>
      </div>
    );
  }
  if (!session) return <BrandSplash />;

  return (
    <Suspense fallback={<BrandSplash />}>
      <Routes location={backgroundLocation ?? location}>
        <Route path="/bind-inviter" element={<BindInviter session={session} onDone={refresh} />} />
        <Route path="/bind-device" element={<BindDevice onDone={refresh} />} />
        <Route path="/kyc" element={<KycForm onDone={refresh} />} />
        <Route path="/promotion" element={<Promotion />} />
        <Route path="/invite" element={<InviteFriends />} />
        <Route path="/agent/report" element={<AgentReport />} />
        <Route path="/agent/players" element={<AgentPlayers />} />
        <Route path="/agent/sharing" element={<AgentSubagents />} />
        <Route path="/game-admin" element={<GameAdminHome />} />
        <Route path="/game-admin/:gameCode" element={<GameAdminConsole />} />
        <Route
          path="/game-admin/:gameCode/send-packet"
          element={
            <GameAdminSendPacket
              paymentPinSet={session.security.paymentPinSet}
              ownerUid={session.uid}
            />
          }
        />
        <Route path="/game/:roomId" element={<GameDetail kycStatus={session.onboarding.kycStatus} />} />
        <Route
          path="/game/:roomId/play"
          element={<GameRoom session={session} freezeFeed={!!backgroundLocation} />}
        />
        <Route path="/game/:roomId/packet" element={<PacketDetail />} />
        <Route path="/game/:roomId/packets/:packetId" element={<PacketDetail />} />
        <Route
          path="/game/:roomId/send-packet"
          element={
            <SendRedPacket
              paymentPinSet={session.security.paymentPinSet}
              ownerUid={session.uid}
            />
          }
        />
        <Route
          path="/game/:roomId/tip"
          element={
            <TipSupport
              ownerUid={session.uid}
              paymentPinSet={session.security.paymentPinSet}
            />
          }
        />
        <Route path="/game/:roomId/rewards" element={<Rewards />} />
        <Route path="/game/:roomId/leaderboards" element={<Leaderboards />} />
        <Route path="/game-rules" element={<DefaultGameRedirect destination="rules" />} />
        <Route path="/rewards" element={<DefaultGameRedirect destination="rewards" />} />
        <Route path="/leaderboards" element={<DefaultGameRedirect destination="leaderboards" />} />
        <Route path="/support" element={<SupportChat />} />
        <Route path="/wallet/orders" element={<WalletOrders />} />
        <Route path="/wallet/funds" element={<FundDetails />} />
        <Route
          path="/wallet/deposit"
          element={
            <Deposit
              kycStatus={session.onboarding.kycStatus}
              ownerUid={session.uid}
            />
          }
        />
        <Route
          path="/wallet/withdraw"
          element={
            <Withdraw
              kycStatus={session.onboarding.kycStatus}
              paymentPinSet={session.security.paymentPinSet}
              ownerUid={session.uid}
            />
          }
        />
        <Route
          path="/wallet/withdraw/accounts"
          element={
            <WithdrawAccounts
              kycStatus={session.onboarding.kycStatus}
              purpose="select"
              returnTo="/wallet/withdraw"
            />
          }
        />
        <Route path="/notices" element={<SystemNotices />} />
        <Route path="/legal/:type" element={<LegalDoc />} />
        <Route path="/settings" element={<Settings session={session} />} />
        <Route path="/settings/device" element={<DeviceManagement />} />
        <Route path="/settings/legal" element={<LegalCenter />} />
        <Route
          path="/settings/banks"
          element={
            <WithdrawAccounts
              kycStatus={session.onboarding.kycStatus}
              purpose="manage"
              returnTo="/settings"
            />
          }
        />
        <Route
          path="/settings/payment-pin"
          element={<PaymentPinSettings session={session} onDone={completePaymentPin} />}
        />
        <Route
          path="/profile/telegram"
          element={<ProfileTelegram />}
        />
        <Route
          path="/profile"
          element={
            <ProfileDetail
              session={session}
              onNicknameChange={(nickname) =>
                setSession((s) => {
                  if (!s) return s;
                  const next = { ...s, nickname };
                  setCachedSession(next);
                  return next;
                })
              }
            />
          }
        />
        <Route
          path="/*"
          element={
            <Tabs
              session={session}
              onAvatarChange={(avatarUrl: string) =>
                setSession((s) => {
                  if (!s) return s;
                  const next = { ...s, avatarUrl };
                  setCachedSession(next);
                  return next;
                })
              }
            />
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {backgroundLocation && (
        <Routes>
          <Route path="/game/:roomId/packet" element={<PacketDetail overlay />} />
          <Route
            path="/game/:roomId/packets/:packetId"
            element={<PacketDetail overlay />}
          />
          <Route path="/game/:roomId/rewards" element={<Rewards />} />
          <Route path="/game/:roomId/leaderboards" element={<Leaderboards />} />
          <Route
            path="/game/:roomId/send-packet"
            element={
              <RoomFullscreenOverlay label="发红包">
                <SendRedPacket
                  paymentPinSet={session.security.paymentPinSet}
                  ownerUid={session.uid}
                />
              </RoomFullscreenOverlay>
            }
          />
          <Route
            path="/game/:roomId/tip"
            element={
              <RoomFullscreenOverlay label="打赏">
                <TipSupport
                  ownerUid={session.uid}
                  paymentPinSet={session.security.paymentPinSet}
                />
              </RoomFullscreenOverlay>
            }
          />
        </Routes>
      )}
      {!backgroundLocation && <SupportInboxToast />}
    </Suspense>
  );
}

/**
 * 登录被 DEVICE_MISMATCH 挡住时的自助换绑：Telegram 身份 + 支付密码双验证。
 * 成功后旧设备全部下线、换绑后 24 小时暂停提现；7 天内限一次。
 */
function SelfRebindForm() {
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    if (busy || pin.length !== 6) return;
    setBusy(true);
    setErr('');
    try {
      await api.deviceRebind(
        getInitData() ?? '',
        getDeviceId(),
        pin,
        getBotUsername() ?? undefined,
      );
      // 清掉设备恢复保护戳，避免刷新后误判为死循环
      try {
        sessionStorage.removeItem('nn_device_recover_at');
      } catch {
        // ignore storage errors
      }
      window.location.reload();
    } catch (e) {
      setErr((e as Error).message || '换绑失败，请重试');
      setPin('');
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        className="primary-action"
        type="button"
        style={{ marginBottom: 10 }}
        onClick={() => setOpen(true)}
      >
        我是本人，自助换绑到本机
      </button>
    );
  }
  return (
    <div style={{ marginBottom: 14, textAlign: 'left' }}>
      <p style={{ fontSize: 13, marginBottom: 8 }}>
        输入支付密码验证身份后，账号将换绑到当前设备（旧设备自动退出，换绑后 24
        小时内暂停提现）：
      </p>
      <input
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        placeholder="6 位支付密码"
        value={pin}
        onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '12px 14px',
          borderRadius: 12,
          border: '1px solid rgba(232,213,168,.3)',
          background: 'rgba(255,255,255,.06)',
          color: 'inherit',
          fontSize: 18,
          letterSpacing: '0.4em',
          textAlign: 'center',
          marginBottom: 8,
        }}
      />
      {err && (
        <p style={{ color: '#e66', fontSize: 12, marginBottom: 8 }}>{err}</p>
      )}
      <button
        className="primary-action"
        type="button"
        disabled={busy || pin.length !== 6}
        onClick={() => void submit()}
        style={{ marginBottom: 10 }}
      >
        {busy ? '验证中…' : '确认换绑'}
      </button>
    </div>
  );
}
