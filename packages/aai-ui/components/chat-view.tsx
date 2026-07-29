// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import type { ReactNode } from "react";
import { useSessionSelector, useTheme } from "../context.ts";
import type { AgentState } from "../types.ts";
import { ERROR_COLOR, TEXT_FAINT } from "./_colors.ts";
import { AaiLogo } from "./aai-logo.tsx";
import { Controls } from "./controls.tsx";
import { Eyebrow } from "./eyebrow.tsx";
import { MessageList } from "./message-list.tsx";
import { TextControls } from "./text-controls.tsx";

// States whose indicator dot pulses (the agent is actively in the exchange).
const PULSING_STATES: ReadonlySet<AgentState> = new Set(["listening", "speaking"]);

/** Indicator dot color per state, on the light refresh palette. */
function stateColor(state: AgentState, primary: string): string {
  switch (state) {
    case "listening":
    case "speaking":
    case "ready":
      return primary;
    case "thinking":
      return "#B98900";
    case "error":
      return ERROR_COLOR;
    default:
      return TEXT_FAINT; // disconnected / connecting
  }
}

/**
 * The main chat interface for a voice agent session — the design-system
 * "voice agent console": a 760px column on the cream page with a header
 * (logo + live-status eyebrow), the conversation on a raised white card,
 * and the session controls beneath it.
 *
 * Must be rendered inside a {@link SessionProvider}.
 *
 * @example
 * ```tsx
 * <StartScreen icon="🍕" title="Pizza Palace">
 *   <ChatView />
 * </StartScreen>
 * ```
 *
 * @param icon - Optional element rendered in place of the logo in the header.
 * @param title - Optional title string for the header.
 * @param className - Additional CSS class names applied to the root element.
 *
 * @public
 */
export function ChatView({
  icon,
  title,
  className,
}: {
  icon?: ReactNode | undefined;
  title?: string | undefined;
  className?: string | undefined;
}): ReactNode {
  // Narrow subscriptions: the shell only reads these three fields, so it must
  // not re-render at STT-partial rate the way a full useSession() would —
  // that cascades into every child below.
  const state = useSessionSelector((s) => s.state);
  const error = useSessionSelector((s) => s.error);
  const audioOut = useSessionSelector((s) => s.audioOut);
  const theme = useTheme();
  const pulsing = PULSING_STATES.has(state);

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
              background: stateColor(state, theme.primary),
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
          {error.message}
        </div>
      )}
      {/* Conversation card */}
      <div
        className="flex flex-col flex-1 min-h-0 border rounded-lg overflow-hidden"
        style={{
          background: theme.surface,
          borderColor: theme.border,
          boxShadow: "0 1px 3px 0 rgb(20 18 12 / 0.06)",
        }}
      >
        <MessageList />
      </div>
      {/* Text-only sessions (tts: none()) get record/upload controls; the
          server's config message decides, so the same default UI serves both. */}
      {audioOut ? <Controls /> : <TextControls />}
    </div>
  );
}
