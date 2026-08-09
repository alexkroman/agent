// Copyright 2026 the AAI authors. MIT license.
/**
 * Counting semaphore with a bounded wait.
 *
 * The companion to `_keyed-lock.ts`: that one serializes work per key, this
 * one caps how many of something may be in flight AT ONCE, regardless of key.
 * It exists because a size cap and a concurrency cap bound different things
 * and only the second one bounds a SERVER. `MAX_INFLATED_BODY_BYTES` limits
 * what one deploy request can allocate; nothing limited how many such
 * requests allocated it simultaneously, so peak memory was a function of
 * arrival rate — a number the caller picks.
 *
 * The wait is bounded on purpose. An unbounded queue converts a memory
 * problem into a latency problem and keeps every waiter's socket open while
 * it does; a lapsed acquire returns null so the caller can answer 503 with a
 * `Retry-After` and let the client come back, which is the same posture
 * `brokerSessionUrl` takes for a sandbox that is still booting.
 */

/** An acquired slot. Idempotent — releasing twice does not free two slots. */
export type SemaphoreRelease = () => void;

export type Semaphore = {
  /**
   * Take a slot, waiting at most `timeoutMs` for one. Resolves null when the
   * deadline lapsed first — the caller took NOTHING and must not release.
   */
  acquire(timeoutMs: number): Promise<SemaphoreRelease | null>;
  /** Slots currently held. Exposed for tests and metrics. */
  readonly active: number;
  /** Callers currently queued for a slot. Exposed for tests and metrics. */
  readonly waiting: number;
};

type Waiter = { settled: boolean; grant: () => void };

export function createSemaphore(limit: number): Semaphore {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Semaphore limit must be a positive integer, got ${limit}`);
  }
  let active = 0;
  const queue: Waiter[] = [];

  /**
   * Hand this slot to the longest-waiting caller that is still waiting, or
   * give it back to the pool.
   *
   * Skipping settled waiters is what keeps a lapsed acquire from DEADLOCKING
   * the pool: a waiter whose deadline fired already returned null to its
   * caller, so handing it the slot would transfer ownership to code that will
   * never release. `active` is deliberately not decremented on the transfer
   * path — the slot moves from one holder to the next without ever being free.
   */
  const handOff = (): void => {
    for (;;) {
      const next = queue.shift();
      if (!next) {
        active--;
        return;
      }
      if (next.settled) continue;
      next.settled = true;
      next.grant();
      return;
    }
  };

  const makeRelease = (): SemaphoreRelease => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      handOff();
    };
  };

  return {
    async acquire(timeoutMs) {
      if (active < limit) {
        active++;
        return makeRelease();
      }
      const { promise, resolve } = Promise.withResolvers<boolean>();
      const waiter: Waiter = { settled: false, grant: () => resolve(true) };
      queue.push(waiter);
      const timer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        // Drop it here rather than leaving it for handOff to skip: under
        // sustained refusal the queue would otherwise accumulate one dead
        // entry per timed-out caller and never shrink.
        const at = queue.indexOf(waiter);
        if (at !== -1) queue.splice(at, 1);
        resolve(false);
      }, timeoutMs);
      try {
        return (await promise) ? makeRelease() : null;
      } finally {
        clearTimeout(timer);
      }
    },
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
  };
}
