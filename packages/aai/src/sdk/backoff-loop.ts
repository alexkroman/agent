// Copyright 2026 the AAI authors. MIT license.
/**
 * A reconnect loop on an exponential backoff — the scaffold, with a name.
 *
 * Two browser loops had written it: `aai-ui`'s inbox socket (`inbox.ts`) and
 * the studio's SSE subscriptions (`aai-studio-client`'s `use-event-stream.ts`).
 * Each kept the same four pieces of state by hand — a stopped flag, a failure
 * count, the pending timer and the attempt to run — and each decided on its own
 * where the count resets. The decision is the caller's; the bookkeeping is
 * this:
 *
 * - **`retry()` counts a failure and schedules the next attempt** after the
 *   window for that count (1-BASED, as `jitteredBackoff` counts). After
 *   `stop()` it does nothing, so a late drop cannot revive a torn-down loop.
 * - **`reset()` only zeroes the count.** WHEN an attempt has worked is the
 *   caller's call — the inbox resets on `open`; the event stream resets only
 *   once a stream has stayed up long enough to have served, because a server
 *   that accepts and immediately drops would otherwise reset it every time.
 * - **`stop()` cancels the pending attempt.** The caller still owns its own
 *   transport and closes it; a settled async step checks `stopped()`.
 *
 * **`jitter` is required, not defaulted**, because the two callers answer it
 * differently on purpose: the inbox spreads over the lower half of the window
 * (`jitteredBackoff`, an agent restart brings every tab back at once), while
 * the event stream's spec pins its gaps EXACTLY. See `jittered-backoff.ts`.
 *
 * One delay is in flight at a time by construction of both callers, and the
 * loop does not police it: a second `retry()` before the first fires schedules
 * a second attempt, exactly as the hand-rolled loops did.
 *
 * @module
 */

import { jitteredBackoff } from "./jittered-backoff.ts";

/**
 * How the window grows. See {@link createBackoffLoop}.
 *
 * @internal
 */
export type BackoffLoopOptions = {
  /** The window after the FIRST failure, doubling from there. */
  baseMs: number;
  /** The largest window the doubling may reach. */
  maxMs: number;
  /**
   * `true` waits uniformly over `[window / 2, window)` (`jitteredBackoff`);
   * `false` waits exactly `window`.
   */
  jitter: boolean;
};

/**
 * Handle returned by {@link createBackoffLoop}.
 *
 * @internal
 */
export interface BackoffLoop {
  /** Run the first attempt now (unless stopped). */
  start(): void;
  /** Count a failure and schedule the next attempt. A no-op once stopped. */
  retry(): void;
  /** Forget the failures: the next `retry()` waits the base window again. */
  reset(): void;
  /** Cancel the pending attempt and refuse every later `retry()`. */
  stop(): void;
  /** Whether `stop()` has been called. */
  stopped(): boolean;
}

/**
 * Create a {@link BackoffLoop} that runs `attempt` on `start()` and again after
 * each `retry()`'s backoff.
 *
 * @example
 * ```ts
 * import { createBackoffLoop } from "@alexkroman1/aai/internal";
 *
 * declare function connect(onOpen: () => void, onDrop: () => void): void;
 *
 * const loop = createBackoffLoop(
 *   () => connect(() => loop.reset(), () => loop.retry()),
 *   { baseMs: 1000, maxMs: 30_000, jitter: true },
 * );
 * loop.start();
 * // later
 * loop.stop();
 * ```
 *
 * @internal
 */
export function createBackoffLoop(attempt: () => void, options: BackoffLoopOptions): BackoffLoop {
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = (): void => {
    timer = undefined;
    if (!stopped) attempt();
  };

  const delay = (): number =>
    options.jitter
      ? jitteredBackoff(failures, options)
      : Math.min(options.baseMs * 2 ** (failures - 1), options.maxMs);

  return {
    start: run,
    retry() {
      if (stopped) return;
      failures++;
      timer = setTimeout(run, delay());
    },
    reset() {
      failures = 0;
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    stopped: () => stopped,
  };
}
