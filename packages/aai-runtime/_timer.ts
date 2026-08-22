// Copyright 2026 the AAI authors. MIT license.
/**
 * Restartable one-shot timer — the clear/arm bookkeeping that the endpoint
 * settler, the silence nudger, the speaking-edge watchdog and Rime's
 * quiescence timers each hand-rolled.
 *
 * The `timer !== null` sentinel doubles as "is a window currently open?" at
 * several of those call sites, so {@link RestartableTimer.pending} is part of
 * the contract rather than an incidental detail.
 */

/**
 * Invoke a timer callback, containing any throw. Timer callbacks run from
 * the event loop — a throw has no call site to land in and would surface as
 * an uncaughtException that takes down the process.
 */
function invokeElapsed(onElapsed: () => void): void {
  try {
    onElapsed();
  } catch (err) {
    console.error("[timer] onElapsed callback threw", err);
  }
}

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
        invokeElapsed(onElapsed);
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
export function createCoalescingTimer(
  onElapsed: () => void,
  opts: {
    /**
     * Do not let a pending run hold the process open.
     *
     * OPT-IN, because it is a claim rather than a tidy-up: a timer that must
     * FIRE before the process may exit has to keep a reference. It is right for
     * a watchdog whose whole job is retiring something that is already alive —
     * the idle-session one, which cannot be the last thing holding a process up
     * when there is no session left to retire — which is the same call the four
     * sibling `timer.unref?.()` sites in this package make by hand.
     */
    unref?: boolean;
  } = {},
): RestartableTimer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadlineMs = 0;

  /** Arm the underlying timer, honouring `unref`. */
  function schedule(ms: number): ReturnType<typeof setTimeout> {
    const handle = setTimeout(onWake, ms);
    if (opts.unref) handle.unref?.();
    return handle;
  }

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
      timer = schedule(remaining);
      return;
    }
    timer = null;
    deadlineMs = 0;
    invokeElapsed(onElapsed);
  }

  return {
    arm(ms: number): void {
      if (!(ms > 0)) return;
      deadlineMs = Date.now() + ms;
      if (timer === null) timer = schedule(ms);
    },
    clear,
    pending: () => timer !== null,
  };
}
