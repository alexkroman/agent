// Copyright 2026 the AAI authors. MIT license.
/**
 * Restartable one-shot timer — the clear/arm bookkeeping that the endpoint
 * settler, the silence nudger, the speaking-edge watchdog, the
 * false-interruption recovery and Rime's quiescence timers each hand-rolled.
 *
 * The `timer !== null` sentinel doubles as "is a window currently open?" at
 * several of those call sites, so {@link RestartableTimer.pending} is part of
 * the contract rather than an incidental detail.
 */

export type RestartableTimer = {
  /**
   * (Re)start the timer, replacing any pending run. A non-positive `ms` is a
   * no-op — callers use `0` to mean "this window is disabled".
   */
  arm(ms: number): void;
  /** Cancel a pending run. Idempotent. */
  clear(): void;
  /** Is a run currently pending? */
  pending(): boolean;
};

/**
 * Create a {@link RestartableTimer} that calls `onElapsed` when a window
 * completes. The timer clears itself before invoking the callback, so
 * `pending()` is already false inside it and the callback may re-arm freely.
 */
export function createRestartableTimer(onElapsed: () => void): RestartableTimer {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clear(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    arm(ms: number): void {
      if (!(ms > 0)) return;
      clear();
      timer = setTimeout(() => {
        timer = null;
        onElapsed();
      }, ms);
    },
    clear,
    pending: () => timer !== null,
  };
}

/**
 * A {@link RestartableTimer} for call sites that re-arm on a *per-event* hot
 * path — e.g. the silence nudger, armed on every STT partial (~5-10/s while
 * the user speaks), or session-core's idle watchdog on every audio frame.
 *
 * Instead of a `clearTimeout` + `setTimeout` pair per `arm()`, it records the
 * deadline and keeps ONE pending timer that sleeps out any remainder when it
 * wakes early. `onElapsed` still fires no sooner than `ms` after the last
 * `arm()`, so the observable contract matches {@link createRestartableTimer}.
 *
 * The tradeoff: re-arming with a *shorter* window than the pending one does not
 * pull the deadline in — the timer fires at the longer, already-scheduled one.
 * That makes this the wrong choice for varying windows (the endpoint settler
 * arms both a short complete-utterance window and a longer fragment one) and
 * the right one for a fixed window re-armed repeatedly.
 */
export function createCoalescingTimer(onElapsed: () => void): RestartableTimer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadlineMs = 0;

  function clear(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    deadlineMs = 0;
  }

  function onWake(): void {
    const remaining = deadlineMs - Date.now();
    if (remaining > 0) {
      // Re-armed since this timer was scheduled — sleep out the remainder.
      timer = setTimeout(onWake, remaining);
      return;
    }
    timer = null;
    deadlineMs = 0;
    onElapsed();
  }

  return {
    arm(ms: number): void {
      if (!(ms > 0)) return;
      deadlineMs = Date.now() + ms;
      if (timer === null) timer = setTimeout(onWake, ms);
    },
    clear,
    pending: () => timer !== null,
  };
}
