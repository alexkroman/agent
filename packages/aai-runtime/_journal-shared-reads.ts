// Copyright 2026 the AAI authors. MIT license.
/**
 * Collapse CONCURRENT identical journal reads onto one round trip.
 *
 * A deployed guest's every `JournalStore` call is one
 * `POST /:slug/workflow-journal` (`workflow-journal-platform.ts`), and two
 * shapes in the replay engine issue the SAME read many times at once:
 *
 * - **A fan-out's stale-snapshot check.** `chargeAttempt` re-reads the whole
 *   journal whenever `claimAttempt` says another walk touched the key
 *   (`settledSince`, in `workflow-replay-attempt.ts`). A `Promise.all` over N
 *   segments reaches N steps at the same instant, so a run being delivered
 *   more than once pays N identical `readSteps` — each a full read of every
 *   step, all answering the same thing.
 * - **Overlapping WALKS.** The platform's `QUEUE_DELIVERY_TIMEOUT_MS` closes a
 *   delivery's response at 60 s without stopping its walk, so a long run
 *   accumulates concurrent walks in one guest, each opening with its own
 *   `getRun` and `readSteps`. That is what multiplies the above: K walks x N
 *   steps identical reads.
 *
 * Observed on `use-transcript-workflow`: a sustained ~2 journal POSTs a second
 * at ~840 ms of server time each, against a route that reserves one of
 * `ADMIN_POOL_MAX` (4) connections per replica for the duration. The reads are
 * not merely wasted latency — they are the pool the run's own WRITES queue
 * behind.
 *
 * ## A COALESCER, not a cache — the same argument as `workflow-run-reads.ts`
 *
 * Nothing here retains an answer. `createCoalescingRunner`'s contract is that a
 * caller arriving while a read is in flight gets a TRAILING read started after
 * that one settles, never the in-flight result — so no caller is ever answered
 * from a read that began before it asked, which is the property the journal's
 * correctness rests on (`settledSince` exists precisely to see a write an
 * earlier snapshot missed). N simultaneous callers therefore cost TWO round
 * trips rather than N, and a caller asking after the burst reads fresh.
 *
 * That is also why only the BULK READS are wrapped. A write, a claim and a
 * compare-and-set each carry their own arguments and must each reach the
 * platform; `getRun(runId)`, `readSteps(runId)` and `readSleeps(runId)` are the
 * three that are pure functions of a key. `readStep(runId, key)` is not — it is
 * keyed by two things, and its one caller reaches it once per contended step
 * rather than in the concurrent burst this exists for.
 *
 * @internal
 */

import { createCoalescingRunner, createOwnedMap } from "@alexkroman1/aai/host-internal";

/** One key's shared read, and the callers still holding it. */
type Entry<T> = {
  trigger: () => Promise<T>;
  /** Callers inside `shareByKey`'s `await`. The last one out releases. */
  holders: number;
  /** This entry's claim on the map — see `createOwnedMap`. */
  release: () => boolean;
};

/**
 * Wrap a keyed read so concurrent callers for one key share a round trip.
 *
 * The entry is released by the LAST holder rather than on a timer, so an idle
 * client retains nothing: a run that finished leaves no entry behind, which
 * matters because a journal client outlives every run it serves.
 *
 * @internal
 */
export function shareByKey<T>(read: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const entries = createOwnedMap<string, Entry<T>>();
  return async (key: string): Promise<T> => {
    let entry = entries.get(key);
    if (!entry) {
      const created: Entry<T> = {
        // No arguments, by the runner's own contract — which is what makes the
        // collapse safe: every trigger for this key wants the same read.
        trigger: createCoalescingRunner(() => read(key)).trigger,
        holders: 0,
        release: () => false,
      };
      created.release = entries.claim(key, created);
      entry = created;
    }
    const held = entry;
    held.holders += 1;
    try {
      return await held.trigger();
    } finally {
      held.holders -= 1;
      // Only the last holder out, and only while this entry still owns the key
      // — a successor claimed in between keeps its own.
      if (held.holders === 0) held.release();
    }
  };
}
