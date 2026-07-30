// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import type { ReactNode } from "react";
import { useSessionSelector } from "../context.ts";
import type { AgentState } from "../types.ts";
import { ConsoleShell } from "./console-shell.tsx";
import { Controls } from "./controls.tsx";
import { MessageList } from "./message-list.tsx";
import { TextControls } from "./text-controls.tsx";

// Re-exported for compatibility: this helper lived here before the shared
// console shell was extracted.
export { stateColor } from "./console-shell.tsx";

// States whose indicator dot pulses (the agent is actively in the exchange).
const PULSING_STATES: ReadonlySet<AgentState> = new Set(["listening", "speaking"]);

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

  return (
    <ConsoleShell
      icon={icon}
      title={title}
      state={state}
      pulsing={PULSING_STATES.has(state)}
      error={error?.message}
      className={className}
      // Text-only sessions (tts: none()) get record/upload controls; the
      // server's config message decides, so the same default UI serves both.
      footer={audioOut ? <Controls /> : <TextControls />}
    >
      <MessageList />
    </ConsoleShell>
  );
}
