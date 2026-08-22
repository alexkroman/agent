// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import type { ReactNode } from "react";
import { useSessionSelector } from "../context.ts";
import type { AgentState } from "../types.ts";
import { ConsoleShell } from "./console-shell.tsx";
import { Controls } from "./controls.tsx";
import { MessageList } from "./message-list.tsx";

// States whose indicator dot pulses (the agent is actively in the exchange).
const PULSING_STATES: ReadonlySet<AgentState> = new Set(["listening", "speaking"]);

/**
 * The main chat interface for a voice agent session — the design-system
 * "voice agent console": a 760px column on the cream page with a header
 * (logo + live-status eyebrow), the conversation on a raised white card,
 * and the session controls beneath it.
 *
 * Must be rendered inside a `SessionProvider`.
 *
 * @example
 * ```tsx
 * import { ChatView, StartScreen } from "@alexkroman1/aai-ui";
 *
 * function App() {
 *   return (
 *     <StartScreen icon="🍕" title="Pizza Palace">
 *       <ChatView />
 *     </StartScreen>
 *   );
 * }
 * ```
 *
 * @param props - Chat surface props.
 *
 * @public
 */
export function ChatView({
  icon,
  title,
  className,
}: {
  /** Element rendered in place of the logo in the header. */
  icon?: ReactNode | undefined;
  /** Title string for the header. Defaults to the agent's declared name. */
  title?: string | undefined;
  /** Additional CSS class names for the root element, appended to its own. */
  className?: string | undefined;
}): ReactNode {
  // Narrow subscriptions: the shell only reads these two fields, so it must
  // not re-render at STT-partial rate the way a full useSession() would —
  // that cascades into every child below.
  const state = useSessionSelector((s) => s.state);
  const error = useSessionSelector((s) => s.error);

  return (
    <ConsoleShell
      icon={icon}
      title={title}
      state={state}
      pulsing={PULSING_STATES.has(state)}
      error={error?.message}
      className={className}
      footer={<Controls />}
    >
      <MessageList />
    </ConsoleShell>
  );
}
