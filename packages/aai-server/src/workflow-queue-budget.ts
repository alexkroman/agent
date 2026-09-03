// Copyright 2026 the AAI authors. MIT license.
/**
 * The replica's DELIVERY budget: how many queue messages may be in flight to
 * guests at once, counted ACROSS passes rather than within one.
 *
 * ## The starvation this exists to fix
 *
 * A delivery pass (`workflow-queue-sweep.ts`) awaits every delivery it claimed,
 * and one delivery is bounded only by `QUEUE_DELIVERY_TIMEOUT_MS` — 60 seconds,
 * because a delivery runs a tenant's step (a model call, an HTTP request) inline
 * inside the guest. The interval could not start another pass while one was in
 * flight, so ONE slow delivery anywhere on the replica stopped every other
 * tenant's message from being CLAIMED for as long as it ran.
 *
 * Measured by hand against a dev server on the real platform path: a two-step
 * workflow with no waits took **21.1 s** end to end while an unrelated agent's
 * 21-second step was being delivered, against **0.5 s** with the replica
 * otherwise idle. The ceiling is a full 60 s per blocked group, and it is
 * cross-tenant — the two agents shared nothing but the replica.
 *
 * The bound that fixes it has to be on DELIVERIES rather than on passes, so a
 * pass can start while a sibling's slow delivery is still holding one slot. That
 * is what this is: `WORKFLOW_QUEUE_DELIVER_CONCURRENCY` slots, taken before the
 * claim, released one at a time as each delivery settles.
 *
 * ## Why a zero-timeout acquire, and why a lapse loses nothing
 *
 * `_pool.ts` argues that a semaphore is the wrong primitive for a background
 * fan-out, because a lapsed acquire there is work SILENTLY NOT DONE. That
 * argument does not reach here, and the difference is what makes this safe: a
 * slot refused before the claim means the message was never claimed, so it stays
 * due, `NOTIFY`-announced, and visible to every replica. Nothing is dropped —
 * delivery is deferred to whichever tick has room, which is exactly the "what is
 * not claimed stays due" contract `WORKFLOW_QUEUE_MAX_PER_TICK` already states.
 *
 * Zero rather than a wait for the same reason the bound moved out of the pass: a
 * pass that WAITED for a slot would be the head-of-line block again, one layer
 * down.
 *
 * ## Why the claim is narrowed to what is free
 *
 * A claim writes `locked_at`. A message claimed beyond the in-flight bound is
 * therefore one this replica cannot deliver yet AND has hidden from every other
 * replica, which is strictly worse than leaving it due — so the pass asks for
 * `min(maxPerTick, free slots)` rather than for `maxPerTick`.
 *
 * @module
 */

import { createSemaphore, type SemaphoreRelease } from "./_semaphore.ts";

/**
 * A budget of delivery slots. Only `take`, because a taken slot is given back
 * through the release it answers.
 *
 * @internal
 */
export type DeliveryBudget = {
  /**
   * Take up to `want` slots, waiting for none of them.
   *
   * Answers what was free, in order, which may be fewer than `want` and may be
   * empty. Each entry is idempotent, so a caller may release the same slot from
   * a per-message `finally` and from a catch-all without double-freeing.
   */
  take(want: number): Promise<SemaphoreRelease[]>;
};

/**
 * A budget of `limit` slots.
 *
 * Over `createSemaphore`, which is this repo's counting-semaphore primitive; the
 * whole of what this adds is the zero-timeout, take-what-is-free loop the module
 * doc argues for, so nothing here re-implements the counting.
 *
 * @internal
 */
export function createDeliveryBudget(limit: number): DeliveryBudget {
  const slots = createSemaphore(Math.max(1, Math.round(limit)));
  return {
    async take(want) {
      const held: SemaphoreRelease[] = [];
      for (let taken = 0; taken < want; taken++) {
        // Zero, so a full budget answers null on the next macrotask rather than
        // parking this pass behind a delivery.
        const slot = await slots.acquire(0);
        if (!slot) break;
        held.push(slot);
      }
      return held;
    },
  };
}
