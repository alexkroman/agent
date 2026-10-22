// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import type { ReactNode } from "react";
import { useTheme } from "../context.ts";
import type { AgentState } from "../types.ts";
import { INK_FAINT_PCT, inkTint } from "./_colors.ts";
import { Eyebrow } from "./eyebrow.tsx";
import { SessionErrorBanner } from "./session-error-banner.tsx";
import { StateDot, stateColor } from "./session-state-dot.tsx";

/**
 * Props of {@link ConsoleShell}.
 *
 * @input
 * @public
 */
export type ConsoleShellProps = {
  /** Element rendered before the title in the header. None by default. */
  icon?: ReactNode | undefined;
  /** Title string for the header. */
  title?: string | undefined;
  /** Live status shown in the header eyebrow. */
  state: AgentState;
  /** Whether the status dot pulses. */
  pulsing: boolean;
  /** Card content — normally a {@link MessageList}. */
  children: ReactNode;
  /** Row rendered beneath the card (controls). */
  footer: ReactNode;
  /** Additional CSS class names for the root element, appended to its own. */
  className?: string | undefined;
};

/**
 * The design-system "console" chrome: a 760px column on the themed page with a
 * header (icon + live-status eyebrow), an announced error banner, the main
 * content on a raised card, and a footer row beneath it.
 *
 * {@link ChatView} is this shell with `<MessageList>` inside it and
 * `<Controls>` under it, and until now that was the only way to get it — the
 * shell itself was internal, so a client wanting its own conversation markup
 * had to rebuild the chrome as well. Each one that did re-derived the error
 * banner WITHOUT `role="alert"`.
 *
 * **The banner is {@link SessionErrorBanner} now, composed here rather than
 * spelled out.** It was four lines of this file, and this file is a whole
 * FRAME — a centred `max-w-190` column — so the full-bleed chromes that needed
 * the announced banner could not take it without taking a layout that would
 * replace the design they exist to demonstrate. Composing means there is one
 * banner, and it means this component no longer takes an `error` prop: the
 * banner reads the session itself, which is one fewer thing a caller can wire
 * up wrong.
 *
 * Reach for it when the conversation is yours and the frame is not. Reach for
 * `<ChatView>` when both are ours. Reach for `<SessionErrorBanner>` alone when
 * neither is.
 *
 * Must be rendered inside the providers `mountClient()` installs.
 *
 * @example A custom conversation in the stock chrome
 * ```tsx
 * import {
 *   ConsoleShell,
 *   Controls,
 *   useConversation,
 *   useSessionStatus,
 * } from "@alexkroman1/aai-ui";
 *
 * function Console() {
 *   const state = useSessionStatus();
 *   const { items } = useConversation();
 *   return (
 *     <ConsoleShell
 *       title="Dispatch"
 *       state={state}
 *       pulsing={state === "listening"}
 *       footer={<Controls />}
 *     >
 *       <ul>
 *         {items.map((item) =>
 *           item.kind === "message" ? (
 *             <li key={item.message.id}>{item.message.content}</li>
 *           ) : item.kind === "tool" ? (
 *             <li key={item.toolCall.callId}>{item.toolCall.name}</li>
 *           ) : null,
 *         )}
 *       </ul>
 *     </ConsoleShell>
 *   );
 * }
 * ```
 *
 * @param props - See {@link ConsoleShellProps}.
 *
 * @public
 */
export function ConsoleShell({
  icon,
  title,
  state,
  pulsing,
  children,
  footer,
  className,
}: ConsoleShellProps): ReactNode {
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
          {icon}
          {title && (
            <span
              className="text-[22px] leading-[1.2] font-semibold tracking-[-0.2px] truncate"
              style={{ color: theme.text }}
            >
              {title}
            </span>
          )}
        </div>
        <Eyebrow className="shrink-0" data-state={state}>
          {/* The dot is `SessionStateDot`'s, coloured from the theme here rather
              than from a palette prop: this shell has one look, and `pulsing` is
              the caller's call. */}
          <StateDot
            color={stateColor(state, theme.primary, inkTint(theme.text, theme.bg, INK_FAINT_PCT))}
            pulseMs={pulsing ? 1600 : null}
            className="w-[7px] h-[7px]"
          />
          {state}
        </Eyebrow>
      </div>
      {/* Error banner — the component, not a copy of it. It renders nothing
          when the session is fine, and reads the session itself. */}
      <SessionErrorBanner />
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
