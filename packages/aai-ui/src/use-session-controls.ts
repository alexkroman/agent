// Copyright 2026 the AAI authors. MIT license.
/**
 * `useSessionControls` — the two flags and four methods a control row is made
 * of, and nothing else.
 *
 * Every custom chrome's control row opened with the same three lines:
 * `useSessionActions()` for the methods, then two one-field
 * `useSessionSelector` calls for `started` and `running`. That is the right
 * shape — the whole-snapshot `useSession()` it replaced re-rendered four
 * buttons at STT-partial rate to read two booleans that flip once a call — and
 * it is also three lines every row writes identically, which is what a hook is
 * for. `<SessionControls>` is built on it; a chrome whose buttons are too
 * unusual for even that component's render slot takes the hook alone.
 */

import { useMemo } from "react";
import { useSessionActions, useSessionSelector } from "./context.ts";
import type { SessionSnapshot } from "./session-core-types.ts";

/**
 * What {@link useSessionControls} returns.
 *
 * @public
 */
export type UseSessionControlsResult = {
  /** Whether a call has been started and not yet ended — the Start/End hinge. */
  started: boolean;
  /** Whether the started call is live rather than paused — the Pause/Resume hinge. */
  running: boolean;
  /** Dial. What the button before `started` presses. */
  start: () => void;
  /** Pause a running call, or resume a paused one. */
  toggle: () => void;
  /**
   * Hang up AND dial again — a brand-new session with fresh session-scoped
   * state, a fresh greeting, and the chrome kept on the call. `end()` then
   * `start()`, never `reset()`: `reset()` clears the conversation and reconnects
   * carrying the same session id, so every `sessionSlot` on the agent survives
   * and the next tool call repopulates the board, cart or game that was just
   * abandoned. Three chromes each found this and wrote the pair by hand.
   */
  restart: () => void;
  /**
   * Hang up. Flips `started` back, so a chrome returns to its Start button and
   * the next `start()` is a new session. `reset()` would keep the call live.
   */
  end: () => void;
};

// Module-scope selectors, so the selection memo has a stable identity — see
// `use-user-transcript.ts` for the argument.
const selectStarted = (snapshot: SessionSnapshot): boolean => snapshot.started;
const selectRunning = (snapshot: SessionSnapshot): boolean => snapshot.running;

/**
 * The state and the actions a Start / Pause–Resume / New conversation / End row
 * renders from, on two one-field subscriptions.
 *
 * Must be used inside the provider `mountClient()` installs.
 *
 * @example A footer that renders its own buttons
 * ```tsx
 * import { useSessionControls } from "@alexkroman1/aai-ui";
 *
 * function Footer() {
 *   const { started, running, start, toggle, end } = useSessionControls();
 *   if (!started) return <button type="button" onClick={start}>Begin</button>;
 *   return (
 *     <>
 *       <button type="button" onClick={toggle}>{running ? "Hold" : "Resume"}</button>
 *       <button type="button" onClick={end}>Hang up</button>
 *     </>
 *   );
 * }
 * ```
 *
 * @returns See {@link UseSessionControlsResult}.
 *
 * @public
 */
export function useSessionControls(): UseSessionControlsResult {
  const { start, toggle, restart, end } = useSessionActions();
  const started = useSessionSelector(selectStarted);
  const running = useSessionSelector(selectRunning);
  return useMemo(
    () => ({ started, running, start, toggle, restart, end }),
    [started, running, start, toggle, restart, end],
  );
}
