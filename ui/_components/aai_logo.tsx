// Copyright 2025 the AAI authors. MIT license.

/** SVG logo for AAI — block-letter A A I in the current text color. */
export function AaiLogo({ size = 40 }: { size?: number }) {
  const height = size / 2;
  return (
    <svg width={size} height={height} viewBox="0 0 40 20" fill="none" class="text-aai-primary">
      <path d="M0 20V4h2V0h8v4h2v16h-4V12H4v8H0zm4-12h4V4H4v4z" fill="currentColor" />
      <path d="M16 20V4h2V0h8v4h2v16h-4V12h-4v8h-4zm4-12h4V4h-4v4z" fill="currentColor" />
      <rect x="32" y="0" width="8" height="20" fill="currentColor" />
    </svg>
  );
}
