// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import type { ReactNode } from "react";
import { useTheme } from "../context.ts";

/**
 * Eyebrow label — the design system's small outlined pill with ALL-CAPS,
 * tracked text ("VOICE AGENT", "LISTENING", …). Used as a section label on
 * the start screen and as the live status chip in the chat header.
 *
 * @internal
 */
export function Eyebrow({
  children,
  className,
  style,
  ...rest
}: {
  children: ReactNode;
  className?: string | undefined;
} & Omit<React.HTMLAttributes<HTMLSpanElement>, "className">): ReactNode {
  const theme = useTheme();
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 px-2 py-1 rounded-aai border leading-none",
        "font-aai text-[10px] font-medium tracking-[1.2px] uppercase",
        className,
      )}
      style={{ borderColor: theme.border, color: theme.text, ...style }}
      {...rest}
    >
      {children}
    </span>
  );
}
