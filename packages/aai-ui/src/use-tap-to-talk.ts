// Copyright 2026 the AAI authors. MIT license.
/**
 * `useTapToTalk` — one tap goes live, the next hangs up: the TOGGLE counterpart
 * of `usePushToTalk`, for an agent with automatic turn detection (the default).
 * It is how a smart speaker's button works, and a page that is the speaker's
 * twin wants the same thing.
 *
 * Tapping is the easy half. What each hand-written copy had to work out:
 *
 * - **Hanging up is `disconnect()`, never `end()`**, so the next tap RESUMES
 *   the session — the agent still knows what was said a minute ago.
 * - **The mic is muted unless live.** A typed turn opens the session too, and
 *   must not open the microphone with it; the mute is set before the connect,
 *   so the call opens already in the right state.
 * - **A typed turn while idle opens the session and waits for it**
 *   (`session.sendText(text, { connect: true })`) instead of being dropped.
 * - **A call that is not live hangs itself up** after `idleHangupMs` of quiet
 *   (the device's follow-up window) or `thinkingHangupMs` of thinking — every
 *   session activity restarts the clock, and a speaking agent is never cut
 *   off. A LIVE call ends only when the caller taps.
 * - **A connection that never comes is a failure**, after `connectTimeoutMs`.
 * - **The session going down on its own** (an error, the server closing it)
 *   leaves live mode — otherwise the next tap would read as "hang up".
 * - The talk key's auto-repeat is not a tap, it is ignored in a text field, and
 *   the button's own Space activation is suppressed so it does not count twice.
 *
 * The decisions are a statechart (`_tap-to-talk-state.ts`); this hook feeds it
 * the session and runs its effects.
 *
 * @module
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  createTapToTalk,
  type TapToTalkPhase,
  type TapToTalkStore,
  type TapToTalkTiming,
  type TapToTalkView,
} from "./_tap-to-talk-state.ts";
import { isTypingTarget } from "./_utils.ts";
import { useSessionCore, useSessionSelector } from "./context.ts";
import type { SessionSnapshot } from "./session-core-types.ts";
import type { AgentState, SessionError } from "./types.ts";

/**
 * Options for {@link useTapToTalk}.
 *
 * @public
 */
export type UseTapToTalkOptions = {
  /**
   * The keyboard key that taps, as a `KeyboardEvent.code` — `"Space"` by
   * default. `false` turns the page-wide key off; the button itself still
   * answers a click, Space and Enter.
   */
  key?: string | false | undefined;
  /**
   * Hang up a call that is NOT live after this long with nothing happening —
   * the device's follow-up window. Default 3000 ms.
   */
  idleHangupMs?: number | undefined;
  /**
   * Hang up a call that is not live when the agent has been thinking this
   * long. Default 60,000 ms — long enough for a slow tool.
   */
  thinkingHangupMs?: number | undefined;
  /** Give up on a connection attempt after this long, and report `failed`. Default 8000 ms. */
  connectTimeoutMs?: number | undefined;
};

/**
 * What {@link useTapToTalk} returns.
 *
 * @public
 */
export type UseTapToTalkResult = {
  /**
   * The call: `"idle"` (not meant to be running), `"connecting"`, or
   * `"active"` — up, whatever the agent is doing.
   */
  phase: "idle" | "connecting" | "active";
  /** Whether the caller is live — mic open, in a realtime conversation. The button is ON. */
  live: boolean;
  /**
   * Whether the last attempt failed: the connection timed out or the session
   * reported an error. Cleared by the next tap or typed turn.
   */
  failed: boolean;
  /** Tap: go live (connecting first if idle), or hang up if live. */
  toggle: () => void;
  /**
   * A typed turn. Sent at once while the call is up; while idle it opens the
   * session WITHOUT the mic and is sent once connected. Blank text is ignored.
   */
  send: (text: string) => void;
  /** Hang up now — resumably (`disconnect()`), live or not. */
  hangUp: () => void;
  /**
   * Spread onto a `<button>`: the click, the keyboard guard against a double
   * tap, and `aria-pressed`. Style it however you like.
   */
  buttonProps: {
    onClick: () => void;
    onKeyDown: (event: { code: string; preventDefault(): void }) => void;
    onKeyUp: (event: { code: string; preventDefault(): void }) => void;
    "aria-pressed": boolean;
  };
};

const DEFAULT_TIMING: TapToTalkTiming = {
  idleHangupMs: 3000,
  thinkingHangupMs: 60_000,
  connectTimeoutMs: 8000,
};

const IDLE_VIEW: TapToTalkView = { live: false, failed: false };
const NO_SUBSCRIPTION = (): (() => void) => () => undefined;

// Module scope for stable selection identities — see `use-user-transcript.ts`.
const selectRunning = (s: SessionSnapshot): boolean => s.running;
const selectState = (s: SessionSnapshot): AgentState => s.state;
const selectContent = (s: SessionSnapshot): number => s.contentVersion;
const selectError = (s: SessionSnapshot): SessionError | null => s.error;

/** The published phase: not meant to run, connecting, or up. */
function phaseOf(running: boolean, agent: AgentState): TapToTalkPhase {
  if (!running) return "idle";
  return agent === "connecting" ? "connecting" : "active";
}

/**
 * Tap to go live, tap to hang up, over the session — see this module's doc
 * for what it handles beyond the tap.
 *
 * Must be used inside the provider `mountClient()` installs. Call it ONCE per
 * page: it owns the session's mute and hang-up clock.
 *
 * @example A talk button and a composer
 * ```tsx
 * import { useTapToTalk } from "@alexkroman1/aai-ui";
 *
 * function Speaker() {
 *   const { live, phase, send, buttonProps } = useTapToTalk();
 *   return (
 *     <>
 *       <button type="button" {...buttonProps}>
 *         {phase === "connecting" ? "Connecting…" : live ? "Tap to hang up" : "Tap to talk"}
 *       </button>
 *       <form
 *         onSubmit={(e) => {
 *           e.preventDefault();
 *           const input = e.currentTarget.elements.namedItem("say") as HTMLInputElement;
 *           send(input.value);
 *           input.value = "";
 *         }}
 *       >
 *         <input name="say" placeholder="…or type" />
 *       </form>
 *     </>
 *   );
 * }
 * ```
 *
 * @param options - The talk key and the three clocks; see {@link UseTapToTalkOptions}.
 * @returns The phase, the live flag and the controls; see {@link UseTapToTalkResult}.
 *
 * @public
 */
export function useTapToTalk(options: UseTapToTalkOptions = {}): UseTapToTalkResult {
  const session = useSessionCore();
  const running = useSessionSelector(selectRunning);
  const agent = useSessionSelector(selectState);
  const content = useSessionSelector(selectContent);
  const error = useSessionSelector(selectError);
  const phase = phaseOf(running, agent);

  // Read per use by the machine's clocks, so new options need no restart.
  const timing = useRef(DEFAULT_TIMING);
  timing.current = {
    idleHangupMs: options.idleHangupMs ?? DEFAULT_TIMING.idleHangupMs,
    thinkingHangupMs: options.thinkingHangupMs ?? DEFAULT_TIMING.thinkingHangupMs,
    connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_TIMING.connectTimeoutMs,
  };

  // Created in an effect (and stopped in its cleanup) so a StrictMode double
  // mount gets a fresh machine rather than a stopped one.
  const [store, setStore] = useState<TapToTalkStore | null>(null);
  useEffect(() => {
    const next = createTapToTalk(
      {
        connect: () => {
          const { running: up, started } = session.getSnapshot();
          if (!up) (started ? session.toggle : session.start)();
        },
        hangUp: () => session.disconnect(),
        cancel: () => session.cancel(),
        setMuted: (muted) => session.setMicMuted(muted),
      },
      () => timing.current,
    );
    setStore(next);
    return () => {
      next.stop();
      setStore(null);
    };
  }, [session]);

  const view = useSyncExternalStore(
    store?.subscribe ?? NO_SUBSCRIPTION,
    store ? store.getView : () => IDLE_VIEW,
  );

  // Every activity, not only a phase change: it is what restarts the clocks.
  useEffect(() => {
    store?.send({ type: "SESSION", phase, agent, activity: content });
  }, [store, phase, agent, content]);

  useEffect(() => {
    if (error) store?.send({ type: "ERROR" });
  }, [store, error]);

  const toggle = useCallback(() => store?.send({ type: "TAP" }), [store]);
  const hangUp = useCallback(() => store?.send({ type: "HANG_UP" }), [store]);
  const send = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      store?.send({ type: "TEXT" });
      session.sendText(text, { connect: true });
    },
    [store, session],
  );

  const key = options.key ?? "Space";
  useEffect(() => {
    if (key === false || typeof window === "undefined") return;
    const down = (event: KeyboardEvent): void => {
      if (event.code !== key || isTypingTarget(event.target)) return;
      event.preventDefault();
      if (!event.repeat) toggle();
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [key, toggle]);

  const buttonProps = useMemo<UseTapToTalkResult["buttonProps"]>(() => {
    // The page-wide key already tapped; the button's own activation of the
    // same key (a click on keyup, for Space) would tap a second time.
    const guard = (event: { code: string; preventDefault(): void }): void => {
      if (key !== false && event.code === key) event.preventDefault();
    };
    return { onClick: toggle, onKeyDown: guard, onKeyUp: guard, "aria-pressed": view.live };
  }, [key, toggle, view.live]);

  return useMemo(
    () => ({ phase, live: view.live, failed: view.failed, toggle, send, hangUp, buttonProps }),
    [phase, view, toggle, send, hangUp, buttonProps],
  );
}
