import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const base: IconProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  xmlns: 'http://www.w3.org/2000/svg',
  focusable: 'false',
  'aria-hidden': true,
};

/** 简洁红包线框 */
export function RedPacketIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="5" y="3.5" width="14" height="17" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M5 8.5h14" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="12" cy="13" r="2.4" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** 转账：圆币 + 单向箭头（入口用） */
export function TransferIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="8.25" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M9 12h6M13.2 9.8 15.4 12l-2.2 2.2"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 微信转账气泡：圆框双向箭头 */
export function TransferSwapIcon(props: IconProps) {
  return (
    <svg {...base} viewBox="0 0 48 48" {...props}>
      <circle cx="24" cy="24" r="18.5" stroke="currentColor" strokeWidth="2.4" />
      <path
        d="M15 20.5h14.5M25.5 16.5 29.5 20.5 25.5 24.5"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M33 27.5H18.5M22.5 23.5 18.5 27.5 22.5 31.5"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** @deprecated 使用 TransferIcon */
export function SupportHeartIcon(props: IconProps) {
  return <TransferIcon {...props} />;
}

export function BackIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path
        d="M15 5 8 12l7 7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ShuffleIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path
        d="M4 7h3.2c1.4 0 2.5.8 3.4 2M4 17h3.2c1.4 0 2.5-.8 3.4-2M16.5 7H20M16.5 17H20"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="m17.5 4.5 2.5 2.5-2.5 2.5M17.5 14.5l2.5 2.5-2.5 2.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CountIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3.5" y="5" width="10" height="13" rx="1.8" stroke="currentColor" strokeWidth="1.6" />
      <rect x="10.5" y="6" width="10" height="13" rx="1.8" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

export function AmountIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="8.25" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M12 7.5v9M9.2 9.6c.7-.9 1.7-1.4 3-1.4 1.8 0 3.1.9 3.1 2.3s-1.1 2.1-2.9 2.5c-1.9.4-3.1 1.1-3.1 2.5 0 1.4 1.3 2.4 3.3 2.4 1.4 0 2.5-.5 3.2-1.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ShieldNoteIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="8.25" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 8v5M12 15.5v.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
