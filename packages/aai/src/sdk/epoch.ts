// Copyright 2026 the AAI authors. MIT license.
/**
 * Staleness guard for async continuations.
 *
 * Promise continuations and event callbacks can't be cancelled the way
 * timers can: work created against one connection/turn/session can settle
 * after that context has been replaced, and applying its result would stomp
 * the replacement's state. The recurring fix is a generation counter —
 * captured when the work is created, re-checked when it settles, bumped by
 * whatever invalidates it. This module is that pattern with a name, so call
 * sites read as intent (`epoch.isCurrent(gen)`) instead of arithmetic
 * (`counter !== gen`) re-derived at each site.
 */

/** @internal */
export interface Epoch {
  /** The current epoch — capture this when creating deferred work. */
  current(): number;
  /** Invalidate all epochs captured so far. */
  bump(): void;
  /** May work captured at `epoch` still apply its result? */
  isCurrent(epoch: number): boolean;
}

/**
 * Create an {@link Epoch}.
 *
 * @internal
 */
export function createEpoch(): Epoch {
  let epoch = 0;
  return {
    current: () => epoch,
    bump(): void {
      epoch += 1;
    },
    isCurrent: (captured) => captured === epoch,
  };
}
