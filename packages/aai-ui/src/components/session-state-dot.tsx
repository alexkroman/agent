// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import type { ReactNode } from "react";
import { AGENT_STATE_LABELS } from "../agent-state-labels.ts";
import { useSessionStatus } from "../context.ts";
import type { AgentState } from "../types.ts";

/**
 * One `aai-pulse` cycle per pulsing state, in milliseconds. The two states
 * that pulse are the two in which the agent is DOING something the reader
 * cannot otherwise see — the microphone is open, or a reply is being worked
 * out — and `thinking` beats faster because it is the shorter wait. `speaking`
 * has the audio itself for a signal and stays still.
 */
const PULSE_MS: Partial<Readonly<Record<AgentState, number>>> = {
  listening: 1500,
  thinking: 800,
};

/**
 * The dot itself: a coloured circle, pulsing or still.
 *
 * Shared by {@link SessionStateDot} and `ConsoleShell`, which computes its
 * colour from the theme rather than from a palette prop and decides for itself
 * when to pulse. Not on the package barrel — the public component is the one
 * that reads the session.
 *
 * The colour is written to `background` AND `color`, so a caller can extend
 * the dot with a `currentColor` utility (`shadow-[0_0_6px_currentColor]` for a
 * glow) without restating the palette.
 *
 * @internal
 */
export function StateDot({
  color,
  pulseMs,
  className,
  title,
}: {
  /** The dot's colour. */
  color: string;
  /** Length of one pulse cycle, or `null` for a still dot. */
  pulseMs: number | null;
  /** Size and any extras; the shape classes are the dot's own. */
  className?: string | undefined;
  /** Tooltip text, typically the raw state. */
  title?: string | undefined;
}): ReactNode {
  return (
    <span
      className={clsx("rounded-full inline-block shrink-0", className)}
      style={{
        background: color,
        color,
        animation: pulseMs === null ? "none" : `aai-pulse ${pulseMs}ms ease-in-out infinite`,
      }}
      title={title}
    />
  );
}

/**
 * Props of {@link SessionStateDot}.
 *
 * @public
 */
export type SessionStateDotProps = {
  /**
   * The dot's colour per {@link AgentState} — the chrome's own palette. A
   * complete record, so a state added upstream is a compile error here rather
   * than a silently unpainted dot; `satisfies Record<AgentState, string>` on the
   * caller's literal is the shape to write it in.
   */
  colors: Readonly<Record<AgentState, string>>;
  /**
   * The words this chrome has a better term for. Anything not named falls back
   * to {@link AGENT_STATE_LABELS}, so a page overrides one member (`speaking:
   * "Narrating"`) without restating the union.
   */
  labels?: Partial<Readonly<Record<AgentState, string>>> | undefined;
  /**
   * Whether the dot pulses while `listening` (slowly) and `thinking` (faster).
   * Defaults to `true`; a chrome whose dot glows rather than beats passes
   * `false`.
   */
  pulse?: boolean | undefined;
  /** Additional CSS class names for the wrapping `<span>`, appended to its own. */
  className?: string | undefined;
  /**
   * REPLACES the dot's default size (`w-2 h-2`) rather than adding to it —
   * there is no `tailwind-merge` in this package, so two conflicting width
   * utilities would not have a reliable winner. The dot's shape classes stay.
   */
  dotClassName?: string | undefined;
  /** Additional CSS class names for the label `<span>`. */
  labelClassName?: string | undefined;
};

/**
 * The live session state as a coloured dot and a word, on its own narrow
 * subscription.
 *
 * Three custom chromes had each written this: a `satisfies Record<AgentState,
 * string>` palette (kept — it is the prop), a `STATE_LABELS` spread over
 * {@link AGENT_STATE_LABELS} (kept — it is `labels`), and then the same
 * fourteen lines of markup around them, including the same two-arm ternary
 * deciding which states pulse and how fast. `agent-state-labels.ts` argued
 * against a dot component on the grounds that it would take the shared part
 * (the words) hostage to the part that is not (the palette); this takes the
 * palette as a prop precisely so it does not. What is shared is the structure
 * — the exhaustive colour lookup, the label fallback, the pulse rule, the
 * `useSessionStatus()` subscription that keeps the rest of the header from
 * re-rendering at STT-partial rate.
 *
 * Must be rendered inside the providers `mountClient()` installs.
 *
 * @example A dispatch board's readout: its own colours, three of its own words
 * ```tsx
 * import type { AgentState } from "@alexkroman1/aai-ui";
 * import { SessionStateDot } from "@alexkroman1/aai-ui";
 *
 * const STATE_COLORS = {
 *   disconnected: "#6b7280",
 *   connecting: "#6b7280",
 *   ready: "#22c55e",
 *   listening: "#22c55e",
 *   thinking: "#eab308",
 *   speaking: "#3b82f6",
 *   error: "#6b7280",
 * } satisfies Record<AgentState, string>;
 *
 * function StatusReadout() {
 *   return (
 *     <SessionStateDot
 *       colors={STATE_COLORS}
 *       labels={{ listening: "LISTENING", thinking: "PROCESSING", speaking: "TRANSMITTING" }}
 *       labelClassName="text-[11px] uppercase"
 *     />
 *   );
 * }
 * ```
 *
 * @param props - See {@link SessionStateDotProps}.
 *
 * @public
 */
export function SessionStateDot({
  colors,
  labels,
  pulse = true,
  className,
  dotClassName,
  labelClassName,
}: SessionStateDotProps): ReactNode {
  const state = useSessionStatus();
  const pulseMs = pulse ? (PULSE_MS[state] ?? null) : null;
  return (
    <span className={clsx("inline-flex items-center gap-2", className)} data-state={state}>
      <StateDot
        color={colors[state]}
        pulseMs={pulseMs}
        className={dotClassName ?? "w-2 h-2"}
        title={state}
      />
      <span className={labelClassName}>{labels?.[state] ?? AGENT_STATE_LABELS[state]}</span>
    </span>
  );
}
