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
