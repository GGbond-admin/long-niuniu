import type { ReactNode } from 'react';

type PageIcon =
  | 'dashboard' | 'gameOps' | 'virtualPlayers' | 'users' | 'kyc' | 'payments' | 'rooms' | 'rounds'
  | 'tng' | 'finance' | 'profitPool' | 'rewards' | 'rebates' | 'leaderboards' | 'messaging'
  | 'support' | 'config' | 'bots' | 'admins' | 'audit' | 'logout';

function Mark({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const paths: Record<PageIcon, ReactNode> = {
  dashboard: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  users: (
    <>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5.2 19.2c.7-3.2 3.4-5 6.8-5s6.1 1.8 6.8 5" />
    </>
  ),
  kyc: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <circle cx="10" cy="12" r="2.1" />
      <path d="M14.2 10.4h4.3M14.2 13.6h4.3M6.4 17.2c.5-1.4 1.8-2.2 3.6-2.2s3.1.8 3.6 2.2" />
    </>
  ),
  tng: (
    <>
      <path d="M5 9.2h14v9.3a1.8 1.8 0 0 1-1.8 1.8H6.8A1.8 1.8 0 0 1 5 18.5z" />
      <path d="M5 9.2 7.4 5h9.2L19 9.2" />
      <path d="M12 9.2v11.1" />
    </>
  ),
  profitPool: (
    <>
      <circle cx="7" cy="8" r="2.3" />
      <circle cx="17" cy="8" r="2.3" />
      <circle cx="12" cy="16.4" r="2.3" />
      <path d="M8.8 9.4 10.6 14M15.2 9.4 13.4 14" />
    </>
  ),
  rebates: (
    <>
      <circle cx="8.2" cy="8.2" r="1.6" />
      <circle cx="15.8" cy="15.8" r="1.6" />
      <path d="M17.2 6.8 6.8 17.2" />
    </>
  ),
  finance: (
    <>
      <path d="M4.5 8.2h15v10.3a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5z" />
      <path d="M4.5 8.2 6.6 4.8h10.8l2.1 3.4" />
      <circle cx="12" cy="13.6" r="2" />
    </>
  ),
  payments: (
    <>
      <rect x="3.5" y="6.2" width="17" height="11.6" rx="2" />
      <path d="M3.5 10.2h17" />
      <path d="M7.2 14.6h4.2" />
    </>
  ),
  gameOps: (
    <>
      <rect x="4" y="5.5" width="16" height="13" rx="2.5" />
      <circle cx="9.2" cy="12" r="1.3" />
      <path d="M15.2 10.2v3.6M13.4 12h3.6" />
    </>
  ),
  messaging: (
    <>
      <path d="M5 7.2h14v8.2a1.8 1.8 0 0 1-1.8 1.8H10l-3.6 2.6V17.2H6.8A1.8 1.8 0 0 1 5 15.4z" />
    </>
  ),
  support: (
    <>
      <path d="M6.2 17.6V8.6A2.2 2.2 0 0 1 8.4 6.4h7.2A2.2 2.2 0 0 1 17.8 8.6v6.2a2.2 2.2 0 0 1-2.2 2.2H9.4z" />
      <path d="M9.2 10.4h5.6M9.2 13.2h3.6" />
    </>
  ),
  bots: (
    <>
      <rect x="6" y="8.2" width="12" height="10" rx="2.4" />
      <path d="M12 8.2V5.6" />
      <circle cx="12" cy="5.2" r="1" />
      <circle cx="9.4" cy="12.6" r="1" />
      <circle cx="14.6" cy="12.6" r="1" />
    </>
  ),
  admins: (
    <>
      <circle cx="12" cy="8.2" r="3" />
      <path d="M6 18.6c.8-3.1 3.1-4.7 6-4.7s5.2 1.6 6 4.7" />
      <path d="M17.4 7.2 19 8.8l-1.6 1.6" />
    </>
  ),
  audit: (
    <>
      <path d="M8 4.8h8.2A2.2 2.2 0 0 1 18.4 7v12.2a1 1 0 0 1-1 1H7.6a1.6 1.6 0 0 1-1.6-1.6V6.4A1.6 1.6 0 0 1 7.6 4.8H8z" />
      <path d="M8 4.8v2.6h4.4" />
      <path d="M8.8 12.2h6.4M8.8 15.2h4.6" />
    </>
  ),
  virtualPlayers: (
    <>
      <circle cx="9" cy="8.2" r="2.6" />
      <circle cx="16.2" cy="9" r="2.2" />
      <path d="M4.4 18.4c.6-2.8 2.8-4.2 5.6-4.2s5 1.4 5.6 4.2M14.4 13.4c1.8 0 3.4.8 4.2 2.6" />
    </>
  ),
  rooms: (
    <>
      <path d="M4.6 20V6.8L12 3.8 19.4 6.8V20" />
      <path d="M9.2 20v-6.2h5.6V20" />
    </>
  ),
  rounds: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.2" />
    </>
  ),
  rewards: (
    <>
      <path d="M12 4.4 13.8 9h4.8l-3.9 3 1.5 4.8L12 14.4 7.8 16.8 9.3 12 5.4 9h4.8z" />
    </>
  ),
  leaderboards: (
    <>
      <path d="M7 18.6V11.2M12 18.6V6.4M17 18.6v-4.6" />
    </>
  ),
  config: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 4.4v2.2M12 17.4v2.2M4.4 12h2.2M17.4 12h2.2M6.6 6.6l1.6 1.6M15.8 15.8l1.6 1.6M17.4 6.6l-1.6 1.6M8.2 15.8 6.6 17.4" />
    </>
  ),
  logout: (
    <>
      <path d="M10 5.2H7.2A2.2 2.2 0 0 0 5 7.4v9.2a2.2 2.2 0 0 0 2.2 2.2H10" />
      <path d="M10.8 12H20M16.6 8.6 20 12l-3.4 3.4" />
    </>
  ),
};

export default function NavIcon({ name }: { name: PageIcon }) {
  return <Mark>{paths[name]}</Mark>;
}
