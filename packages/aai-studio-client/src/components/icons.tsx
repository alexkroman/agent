// Copyright 2026 the AAI authors. MIT license.
// The studio's line icons: 16px, 1.5px stroke, `currentColor`, so each takes
// the color of the text it sits beside. Inline SVG rather than an icon
// package — the set is a dozen glyphs and the bundle should not pay for a
// library to draw them.

import type { ReactNode } from "react";

function Icon({ size = 16, children }: { size?: number | undefined; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="flex-none"
    >
      {children}
    </svg>
  );
}

type IconProps = { size?: number };

export const PlayIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="9" />
    <path d="m10 8.5 5 3.5-5 3.5z" />
  </Icon>
);

export const CodeIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="m8 7-5 5 5 5" />
    <path d="m16 7 5 5-5 5" />
  </Icon>
);

export const KeyIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <circle cx="8" cy="15" r="4" />
    <path d="m10.8 12.2 8.2-8.2" />
    <path d="m16 7 3 3" />
  </Icon>
);

export const GearIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Icon>
);

export const ReloadIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M20 11a8 8 0 1 0-2.3 5.7" />
    <path d="M20 4v7h-7" />
  </Icon>
);

export const ExternalIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M14 4h6v6" />
    <path d="M20 4 11 13" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Icon>
);

export const DesktopIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <rect x="3" y="4" width="18" height="12" rx="1.5" />
    <path d="M8 20h8" />
    <path d="M12 16v4" />
  </Icon>
);

export const PhoneIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <rect x="7" y="3" width="10" height="18" rx="2" />
    <path d="M11 18h2" />
  </Icon>
);

export const ChevronDownIcon = ({ size = 14 }: IconProps) => (
  <Icon size={size}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

export const ChevronRightIcon = ({ size = 14 }: IconProps) => (
  <Icon size={size}>
    <path d="m9 6 6 6-6 6" />
  </Icon>
);

export const UserIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </Icon>
);

export const PlusIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Icon>
);

export const CheckIcon = ({ size = 14 }: IconProps) => (
  <Icon size={size}>
    <path d="m5 12 5 5 9-10" />
  </Icon>
);

export const WaveIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M3 12h2" />
    <path d="M7 8v8" />
    <path d="M11 5v14" />
    <path d="M15 9v6" />
    <path d="M19 11v2" />
  </Icon>
);

/** An indeterminate ring, for a step still running. */
export const SpinnerIcon = ({ size = 14 }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden
    className="flex-none animate-spin"
  >
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
  </svg>
);
