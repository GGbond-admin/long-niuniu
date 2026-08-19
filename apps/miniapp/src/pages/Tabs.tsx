import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Session } from '../App';
import { api } from '../api';
import { IconHome, IconMessage, IconUser, IconWallet } from '../components/Icons';
import Lobby from './Lobby';

const ChatHub = lazy(() => import('./ChatHub'));
const Profile = lazy(() => import('./Profile'));
const Wallet = lazy(() => import('./Wallet'));

type TabKey = 'lobby' | 'wallet' | 'chat' | 'me';
type TabIcon = ComponentType<{ size?: number; className?: string }>;

const TAB_KEY = 'miniapp-tab';

const TABS: Array<[TabKey, TabIcon, string]> = [
  ['lobby', IconHome, '大厅'],
  ['wallet', IconWallet, '钱包'],
  ['chat', IconMessage, '消息'],
  ['me', IconUser, '我的'],
];

function readTab(): TabKey {
  try {
    const value = sessionStorage.getItem(TAB_KEY);
    if (value === 'lobby' || value === 'wallet' || value === 'chat' || value === 'me') return value;
  } catch {
    // ignore
  }
  return 'lobby';
}

export default function Tabs({
  session,
  onAvatarChange,
}: {
  session: Session;
  onAvatarChange?: (avatarUrl: string) => void;
}) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>(readTab);
  const [inboxUnread, setInboxUnread] = useState(0);
  const [visited, setVisited] = useState<Record<TabKey, boolean>>(() => {
    const initial = readTab();
    return {
      lobby: initial === 'lobby',
      wallet: initial === 'wallet',
      chat: initial === 'chat',
      me: initial === 'me',
    };
  });
  const kyc = session.onboarding.kycStatus;

  function selectTab(key: TabKey) {
    // P-KYC-00：首次点钱包触发实名；未提交/驳回直接进实名页
    if (key === 'wallet' && (kyc === 'NONE' || kyc === 'REJECTED')) {
      navigate('/kyc');
      return;
    }
    setTab(key);
    setVisited((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
    try {
      sessionStorage.setItem(TAB_KEY, key);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    try {
      sessionStorage.setItem(TAB_KEY, tab);
    } catch {
      // ignore
    }
  }, [tab]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void Promise.all([
        api.chatPreview().catch(() => ({ unread: 0 })),
        api.noticesPreview().catch(() => ({ unread: 0 })),
      ]).then(([chat, notices]) => {
        if (cancelled) return;
        setInboxUnread(Number(chat.unread ?? 0) + Number(notices.unread ?? 0));
      });
    let timer = 0;
    const start = window.setTimeout(() => {
      void load();
      timer = window.setInterval(load, 8_000);
    }, 2_400);
    return () => {
      cancelled = true;
      window.clearTimeout(start);
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="ui-shell">
      {/* 保活已访问过的 Tab，避免点底部导航时整页卸载/重挂看起来像「刷新」 */}
      {visited.lobby && (
        <div className="tab-panel" hidden={tab !== 'lobby'} aria-hidden={tab !== 'lobby'}>
          <Lobby active={tab === 'lobby'} />
        </div>
      )}
      {visited.wallet && (
        <div className="tab-panel" hidden={tab !== 'wallet'} aria-hidden={tab !== 'wallet'}>
          <Suspense fallback={<div className="loading">加载中…</div>}>
            <Wallet
              kycStatus={kyc}
              active={tab === 'wallet'}
              onGoLobby={() => selectTab('lobby')}
            />
          </Suspense>
        </div>
      )}
      {visited.chat && (
        <div className="tab-panel" hidden={tab !== 'chat'} aria-hidden={tab !== 'chat'}>
          <Suspense fallback={<div className="loading">加载中…</div>}>
            <ChatHub active={tab === 'chat'} />
          </Suspense>
        </div>
      )}
      {visited.me && (
        <div className="tab-panel" hidden={tab !== 'me'} aria-hidden={tab !== 'me'}>
          <Suspense fallback={<div className="loading">加载中…</div>}>
            <Profile session={session} onAvatarChange={onAvatarChange} active={tab === 'me'} />
          </Suspense>
        </div>
      )}
      <nav className="tabbar" aria-label="主导航">
        {TABS.map(([key, Icon, label]) => {
          const active = tab === key;
          const badge = key === 'chat' && inboxUnread > 0 ? inboxUnread : 0;
          return (
            <button
              key={key}
              className={active ? 'active' : ''}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => selectTab(key)}
            >
              <span className="tabbar-icon">
                <Icon size={22} />
                {badge > 0 ? <i className="tabbar-badge">{badge > 99 ? '99+' : badge}</i> : null}
              </span>
              <span className="tabbar-label">{label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
