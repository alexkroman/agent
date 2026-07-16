// Copyright 2026 the AAI authors. MIT license.
// Silence nudge — countdown that lets the pipeline transport proactively take
// a turn after a stretch of user silence. Pure timer/budget bookkeeping; the
// transport supplies the actual turn via `onNudge`.

import { MAX_CONSECUTIVE_SILENCE_NUDGES } from "../../sdk/constants.ts";

export type SilenceNudger = {
  /**
   * (Re)start the countdown. No-op when disabled, torn down, or the
   * consecutive-nudge budget is spent.
   */
  arm(): void;
  /** Cancel any pending countdown. */
  clear(): void;
  /** User speech detected (STT partial): reset the budget and re-arm. */
  onUserSpeech(): void;
  /**
   * Real user turn starting (STT final): reset the budget and stop the
   * countdown — the turn re-arms when it completes.
   */
  onUserTurn(): void;
};

/** Create a {@link SilenceNudger}. Disabled when `timeoutMs` is unset or non-positive. */
export function createSilenceNudger(opts: {
  timeoutMs: number | undefined;
  /** `false` once the transport is terminated or stopping — arm() no-ops. */
  isActive(): boolean;
  /**
   * A turn in flight (or client audio still playing) defers the nudge — the
   * countdown re-arms itself and checks again after another `timeoutMs`.
   */
  isTurnInFlight(): boolean;
  /** Fire the nudge turn. `consecutive` counts nudges since the user last spoke. */
  onNudge(consecutive: number): void;
}): SilenceNudger {
  const raw = opts.timeoutMs ?? 0;
  const timeoutMs = Number.isFinite(raw) && raw > 0 ? raw : 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let consecutive = 0;
  // When the countdown last (re)started. arm() is called per STT partial
  // (~5-10/s while the user speaks), so it must stay cheap: record the
  // timestamp and keep ONE long-lived timer that, on expiry, sleeps out any
  // remainder instead of clearTimeout+setTimeout on every call (mirrors
  // session-core's resetIdle).
  let armedAtMs = 0;

  function clear(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function arm(): void {
    if (timeoutMs <= 0 || !opts.isActive()) return;
    if (consecutive >= MAX_CONSECUTIVE_SILENCE_NUDGES) return;
    armedAtMs = Date.now();
    if (timer === null) timer = setTimeout(onDeadline, timeoutMs);
  }

  function onDeadline(): void {
    timer = null;
    if (!opts.isActive()) return;
    const remaining = armedAtMs + timeoutMs - Date.now();
    if (remaining > 0) {
      // Re-armed since the timer was set — sleep out the remainder.
      timer = setTimeout(onDeadline, remaining);
      return;
    }
    // A turn is in flight (or buffered audio is still playing client-side):
    // defer without spending budget and check again after another window.
    if (opts.isTurnInFlight()) {
      arm();
      return;
    }
    consecutive++;
    opts.onNudge(consecutive);
  }

  return {
    arm,
    clear,
    onUserSpeech(): void {
      consecutive = 0;
      // If the utterance never reaches a final, the re-armed countdown
      // still fires eventually.
      arm();
    },
    onUserTurn(): void {
      consecutive = 0;
      clear();
    },
  };
}
