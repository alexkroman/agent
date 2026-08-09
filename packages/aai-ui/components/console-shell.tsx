// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import type { ReactNode } from "react";
import { useTheme } from "../context.ts";
import type { AgentState } from "../types.ts";
import { ERROR_COLOR, INK_FAINT_PCT, inkTint, THINKING_COLOR } from "./_colors.ts";
import { AaiLogo } from "./aai-logo.tsx";
import { Eyebrow } from "./eyebrow.tsx";

/**
 * Indicator dot color per state.
 *
 * `idle` is the theme's own faint ink step rather than a fixed warm grey, so
 * the dot stays visible on a dark ground; the thinking amber and error red
 * are semantic and stay fixed.
 *
 * @internal
 */
function stateColor(state: AgentState, primary: string, idle: string): string {
  switch (state) {
    case "listening":
    case "speaking":
    case "ready":
      return primary;
    case "thinking":
      return THINKING_COLOR;
    case "error":
      return ERROR_COLOR;
    default:
      return idle; // disconnected / connecting
  }
}

/**
 * The design-system "console" chrome for the chat shell:
 * a 760px column on the cream page with a header
 * (logo + live-status eyebrow), an optional error banner, the main content
 * on a raised white card, and a footer row beneath it.
 *
 *
 * @internal
 */
export function ConsoleShell({
  icon,
  title,
  state,
  pulsing,
  error,
  children,
  footer,
  className,
}: {
  /** Element rendered in place of the logo in the header. */
  icon?: ReactNode | undefined;
  /** Title string for the header. */
  title?: string | undefined;
  /** Live status shown in the header eyebrow. */
  state: AgentState;
  /** Whether the status dot pulses. */
  pulsing: boolean;
  /** Error banner text; `null`/`undefined` hides the banner. */
  error?: string | null | undefined;
  /** Card content. */
  children: ReactNode;
  /** Row rendered beneath the card (controls). */
  footer: ReactNode;
  className?: string | undefined;
}): ReactNode {
  const theme = useTheme();
  return (
    <div
      className={clsx(
        "flex flex-col h-screen w-full max-w-190 mx-auto box-border px-6 py-8 gap-5 font-aai text-sm",
        className,
      )}
      style={{ background: theme.bg, color: theme.text }}
    >
      {/* Header: brand left, live status right */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          {icon ?? <AaiLogo size={22} />}
          {title && (
            <span
              className="font-aai-serif text-[22px] leading-[1.2] font-normal truncate"
              style={{ color: theme.text }}
            >
              {title}
            </span>
          )}
        </div>
        <Eyebrow className="shrink-0" data-state={state}>
          <span
            className="w-[7px] h-[7px] rounded-full"
            style={{
              background: stateColor(
                state,
                theme.primary,
                inkTint(theme.text, theme.bg, INK_FAINT_PCT),
              ),
              animation: pulsing ? "aai-pulse 1.6s ease-in-out infinite" : "none",
            }}
          />
          {state}
        </Eyebrow>
      </div>
      {/* Error banner */}
      {error && (
        <div
          className="px-3.5 py-2.5 rounded-aai border text-[13px] leading-[130%] shrink-0"
          style={{
            borderColor: "rgba(179,38,30,0.35)",
            background: "rgba(179,38,30,0.06)",
            color: ERROR_COLOR,
          }}
        >
          {error}
        </div>
      )}
      {/* Main card */}
      <div
        className="flex flex-col flex-1 min-h-0 border rounded-lg overflow-hidden"
        style={{
          background: theme.surface,
          borderColor: theme.border,
          boxShadow: "0 1px 3px 0 rgb(20 18 12 / 0.06)",
        }}
      >
        {children}
      </div>
      {footer}
    </div>
  );
}
