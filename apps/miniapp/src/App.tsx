import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  api,
  DEVICE_SESSION_INVALID_EVENT,
  getToken,
  setToken,
} from './api';
import { getBotUsername, getDeviceId, getInitData, getRefUid, tg } from './telegram';
import { getCachedSession, setCachedSession, type Session } from './sessionStore';
import BindInviter from './pages/BindInviter';
import BindDevice from './pages/BindDevice';
import KycForm from './pages/KycForm';
import Tabs from './pages/Tabs';
import Promotion from './pages/Promotion';
import InviteFriends from './pages/InviteFriends';
import GameDetail from './pages/GameDetail';
import GameRoom from './pages/GameRoom';
import PacketDetail from './pages/PacketDetail';
import SendRedPacket from './pages/SendRedPacket';
import TipSupport from './pages/TipSupport';
import Leaderboards from './pages/Leaderboards';
import Rewards from './pages/Rewards';
import SupportChat from './pages/SupportChat';
import WalletOrders from './pages/WalletOrders';
import FundDetails from './pages/FundDetails';
import Deposit from './pages/Deposit';
import Withdraw from './pages/Withdraw';
import WithdrawAccounts from './pages/WithdrawAccounts';
import LegalDoc from './pages/LegalDoc';
import SystemNotices from './pages/SystemNotices';
import ProfileDetail from './pages/ProfileDetail';
import ProfileTelegram from './pages/ProfileTelegram';
import Settings from './pages/Settings';
import PaymentPinSettings from './pages/PaymentPinSettings';
import DeviceManagement from './pages/DeviceManagement';
import LegalCenter from './pages/LegalCenter';
import SupportInboxToast from './components/SupportInboxToast';

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
  if (!roomId) return <div className="loading">正在进入游戏…</div>;
  const path =
    destination === 'rules'
      ? `/game/${roomId}`
      : `/game/${roomId}/${destination}`;
  return <Navigate to={path} replace />;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(() => getCachedSession());
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  const bootRef = useRef(false);

  useEffect(() => {
    let reloading = false;
    const recoverDeviceSession = () => {
      if (reloading) return;
      reloading = true;
      setToken(null);
      setCachedSession(null);
      setSession(null);
      window.location.reload();
    };
    window.addEventListener(DEVICE_SESSION_INVALID_EVENT, recoverDeviceSession);
    return () =>
      window.removeEventListener(DEVICE_SESSION_INVALID_EVENT, recoverDeviceSession);
  }, []);

  useEffect(() => {
    const app = tg();
    app?.ready();
    app?.expand();
    app?.disableVerticalSwipes?.();

    // Fast Refresh / 严格模式重挂载时不要重复打登录并把界面打回「加载中…」
    if (bootRef.current && getCachedSession() && getToken()) return;
    bootRef.current = true;

    const initData = getInitData();
    if (!initData) {
      setError('请从 Telegram 打开小程序');
      return;
    }
    api
      .login(initData, getDeviceId(), getBotUsername() ?? undefined)
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
      .catch((e) => {
        if (!getCachedSession()) setError(e.message);
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

  if (error) return <div className="loading">{error}</div>;
  if (!session) return <div className="loading">加载中…</div>;

  return (
    <>
      <Routes>
        <Route path="/bind-inviter" element={<BindInviter session={session} onDone={refresh} />} />
        <Route path="/bind-device" element={<BindDevice onDone={refresh} />} />
        <Route path="/kyc" element={<KycForm onDone={refresh} />} />
        <Route path="/promotion" element={<Promotion />} />
        <Route path="/invite" element={<InviteFriends />} />
        <Route path="/game/:roomId" element={<GameDetail kycStatus={session.onboarding.kycStatus} />} />
        <Route path="/game/:roomId/play" element={<GameRoom />} />
        <Route path="/game/:roomId/packet" element={<PacketDetail />} />
        <Route
          path="/game/:roomId/send-packet"
          element={
            <SendRedPacket
              paymentPinSet={session.security.paymentPinSet}
              ownerUid={session.uid}
            />
          }
        />
        <Route path="/game/:roomId/tip" element={<TipSupport ownerUid={session.uid} />} />
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
      <SupportInboxToast />
    </>
  );
}
