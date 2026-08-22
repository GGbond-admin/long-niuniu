import type { ReactNode } from 'react';

type IconProps = { size?: number; className?: string };

function base(size: number, className?: string, children?: ReactNode) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function IconHome({ size = 22, className }: IconProps) {
  return base(size, className, (
    <>
      <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z" />
    </>
  ));
}

export function IconWallet({ size = 22, className }: IconProps) {
  return base(size, className, (
    <>
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a2 2 0 0 1 2 2v11a1 1 0 0 1-1 1H5.5A2.5 2.5 0 0 1 3 16.5z" />
      <path d="M3 8h16" />
      <path d="M16 13h3" />
    </>
  ));
}

export function IconMessage({ size = 22, className }: IconProps) {
  return base(size, className, (
    <>
      <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 3v-3H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
    </>
  ));
}

export function IconUser({ size = 22, className }: IconProps) {
  return base(size, className, (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5.5 19.5c1.4-3 4.1-4.5 6.5-4.5s5.1 1.5 6.5 4.5" />
    </>
  ));
}

export function IconChevronRight({ size = 18, className }: IconProps) {
  return base(size, className, <path d="m9 6 6 6-6 6" />);
}

export function IconPlus({ size = 18, className }: IconProps) {
  return base(size, className, (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ));
}

export function IconArrowUp({ size = 18, className }: IconProps) {
  return base(size, className, (
    <>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </>
  ));
}

export function IconList({ size = 18, className }: IconProps) {
  return base(size, className, (
    <>
      <path d="M8 6h12" />
      <path d="M8 12h12" />
      <path d="M8 18h12" />
      <circle cx="4" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="18" r="1" fill="currentColor" stroke="none" />
    </>
  ));
}

export function IconEye({ size = 18, className }: IconProps) {
  return base(size, className, (
    <>
      <path d="M2.5 12C4.5 7.5 8 5 12 5s7.5 2.5 9.5 7c-2 4.5-5.5 7-9.5 7s-7.5-2.5-9.5-7z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ));
}

export function IconEyeOff({ size = 18, className }: IconProps) {
  return base(size, className, (
    <>
      <path d="M3 3l18 18" />
      <path d="M10.6 10.6A2.5 2.5 0 0 0 12 15a2.5 2.5 0 0 0 1.4-.4" />
      <path d="M6.7 6.7C4.8 8 3.4 9.8 2.5 12c2 4.5 5.5 7 9.5 7 1.6 0 3.1-.4 4.4-1.1" />
      <path d="M14.1 9.9c.6.6.9 1.4.9 2.1 0 1.7-1.3 3-3 3-.7 0-1.5-.3-2.1-.9" />
    </>
  ));
}

export function IconClose({ size = 18, className }: IconProps) {
  return base(size, className, (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </>
  ));
}

export function IconLive({ size = 8, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" className={className} aria-hidden>
      <circle cx="4" cy="4" r="4" fill="currentColor" />
    </svg>
  );
}

export function IconGift({ size = 18, className }: IconProps) {
  return base(size, className, (
    <>
      <path d="M4 10h16v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
      <path d="M3 7h18v3H3z" />
      <path d="M12 7v13" />
      <path d="M12 7c-2.2 0-3.5-1.8-2.5-3S12 5 12 7c2.2 0 3.5-1.8 2.5-3S12 5 12 7z" />
    </>
  ));
}

export function IconRank({ size = 18, className }: IconProps) {
  return base(size, className, (
    <>
      <path d="M6 20V11" />
      <path d="M12 20V4" />
      <path d="M18 20v-6" />
    </>
  ));
}

export function IconTrend({ size = 18, className }: IconProps) {
  return base(size, className, (
    <>
      <path d="M3 17 9 11l4 4 8-8" />
      <path d="M14 7h6v6" />
    </>
  ));
}

export function IconShare({ size = 18, className }: IconProps) {
  return base(size, className, (
    <>
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="m8.2 10.8 7.6-4.6" />
      <path d="m8.2 13.2 7.6 4.6" />
    </>
  ));
}

export function IconShield({ size = 18, className }: IconProps) {
  return base(size, className, (
    <>
      <path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z" />
      <path d="m9.5 12 1.8 1.8 3.7-3.8" />
    </>
  ));
}

export function IconSupport({ size = 18, className }: IconProps) {
  return base(size, className, (
    <>
      <path d="M5 12a7 7 0 0 1 14 0" />
      <path d="M5 12v3a2 2 0 0 0 2 2h1v-5H5z" />
      <path d="M19 12v3a2 2 0 0 1-2 2h-1v-5h3z" />
      <path d="M12 19v2" />
      <path d="M9 21h6" />
    </>
  ));
}

export function IconHelp({ size = 18, className }: IconProps) {
  return base(size, className, (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.2 2.4c-.8.3-1.2.8-1.2 1.6V14" />
      <path d="M12 17h.01" />
    </>
  ));
}

export function IconSettings({ size = 18, className }: IconProps) {
  return base(size, className, (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21h-4v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3.1 14H3v-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.5V3h4v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ));
}

export function IconDevice({ size = 18, className }: IconProps) {
  return base(size, className, (
    <>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2" />
      <path d="M10 5h4" />
      <path d="M11.5 18.5h1" />
    </>
  ));
}

export function IconDocument({ size = 18, className }: IconProps) {
  return base(size, className, (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v5h4" />
      <path d="M9 12h6" />
      <path d="M9 16h6" />
    </>
  ));
}

export function IconInfo({ size = 18, className }: IconProps) {
  return base(size, className, (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6" />
      <path d="M12 7h.01" />
    </>
  ));
}

export function IconBank({ size = 18, className }: IconProps) {
  return base(size, className, (
    <>
      <path d="M3 10l9-6 9 6" />
      <path d="M5 10v8" />
      <path d="M9.5 10v8" />
      <path d="M14.5 10v8" />
      <path d="M19 10v8" />
      <path d="M3 18h18" />
      <path d="M2 21h20" />
    </>
  ));
}

export function IconIdCard({ size = 18, className }: IconProps) {
  return base(size, className, (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="12" r="2.2" />
      <path d="M13.5 10.5h4" />
      <path d="M13.5 13.5h3" />
    </>
  ));
}

export function IconUsers({ size = 18, className }: IconProps) {
  return base(size, className, (
    <>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M4.5 19c1.2-2.6 3.2-4 4.5-4s3.3 1.4 4.5 4" />
      <circle cx="17" cy="9.5" r="2.5" />
      <path d="M14 19c.7-1.8 2.1-3 3.5-3" />
    </>
  ));
}

export function IconPieChart({ size = 18, className }: IconProps) {
  return base(size, className, (
    <>
      <path d="M12 3v9h9" />
      <circle cx="12" cy="12" r="9" />
    </>
  ));
}

export function IconQrCode({ size = 18, className }: IconProps) {
  return base(size, className, (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.2" />
      <rect x="6.2" y="6.2" width="2.6" height="2.6" fill="currentColor" stroke="none" />
      <rect x="13" y="4" width="7" height="7" rx="1.2" />
      <rect x="15.2" y="6.2" width="2.6" height="2.6" fill="currentColor" stroke="none" />
      <rect x="4" y="13" width="7" height="7" rx="1.2" />
      <rect x="6.2" y="15.2" width="2.6" height="2.6" fill="currentColor" stroke="none" />
      <path d="M13 13h2.2v2.2" />
      <path d="M17 13v2.2" />
      <path d="M13 17h2.2" />
      <path d="M17 17h2.2" />
      <path d="M20 13v4.2" />
    </>
  ));
}
