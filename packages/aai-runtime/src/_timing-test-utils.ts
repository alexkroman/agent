// Copyright 2025 the AAI authors. MIT license.

/**
 * Waiting in a spec: yields, the shared `sleep`, and a deadline that names
 * what never happened.
 */

import pTimeout from "p-timeout";

/** Yield to the microtask queue so pending promises settle. */
export function flush(): Promise<void> {
  return new Promise<void>((r) => queueMicrotask(r));
}

/**
 * Yield a full MACROTASK — drains microtasks and also lets already-scheduled
 * zero-delay timers and I/O callbacks run. Deliberately not called `flush`:
 * pick by what you need to drain.
 */
export function tick(): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, 0));
}

/**
 * Sleep real wall-clock ms; the SDK's one `sleep`, which `vi.useFakeTimers()`
 * drives. Prefer fake timers or `vi.waitFor` where possible.
 */
export { sleep } from "@alexkroman1/aai/internal";

/**
 * Settle `promise`, or fail with a sentence naming what never happened, so a
 * dropped frame fails as that rather than as a bare tier timeout. `what` may be
 * a thunk, to report what HAD arrived by the deadline.
 */
export function withDeadline<T>(
  promise: Promise<T>,
  what: string | (() => string),
  ms = 2000,
): Promise<T> {
  return pTimeout(promise, {
    milliseconds: ms,
    fallback: () => {
      throw new Error(`${typeof what === "function" ? what() : what} within ${ms}ms`);
    },
  });
}
