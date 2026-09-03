// Copyright 2026 the AAI authors. MIT license.
/**
 * WHEN a queue pass runs — the NOTIFY listener, the interval, and the coalescing
 * runner between them.
 *
 * Split from `workflow-queue-sweep.ts` at the seam `pg-cron.ts` already draws
 * against `pg-cron-bodies.ts`: that module is one PASS — claim, reconcile,
 * deliver, account — and this one is the schedule that drives it. They change for
 * different reasons (a delivery-semantics fix touches the pass; a latency or
 * backpressure fix touches the trigger) and the pass had grown to the 500-line
 * cap with both in it.
 *
 * `runQueuePass` is still exported from there and is what a test drives directly;
 * nothing about the schedule is reachable except through {@link
 * startWorkflowQueueSweep}.
 *
 * @internal
 */

import { errorMessage } from "@alexkroman1/aai";
import { createCoalescingRunner } from "@alexkroman1/aai/internal";
import { createLogger } from "./logger.ts";
import { createDeliveryBudget } from "./workflow-queue-budget.ts";
import { WORKFLOW_QUEUE_CHANNEL } from "./workflow-queue-store.ts";
import type { QueueSweepOptions } from "./workflow-queue-sweep.ts";
import {
  runQueuePass,
  WORKFLOW_QUEUE_DELIVER_CONCURRENCY,
  WORKFLOW_QUEUE_INTERVAL_MS,
} from "./workflow-queue-sweep.ts";

// The pass's own namespace: a reader grepping the queue sweep wants the trigger's
// lines beside the passes they caused.
const log = createLogger("workflow.queue.sweep");

/**
 * Start delivering. Returns its stop.
 *
 * Sync and fire-and-forget per tick, like every other sweep here: the process
 * must not wait on it. Unlike every other sweep here a tick is NOT dropped while
 * its predecessor runs — see the comment on the interval below, and
 * `workflow-queue-budget.ts` for what bounds the work instead.
 */
export function startWorkflowQueueSweep(
  opts: QueueSweepOptions & { intervalMs?: number | undefined },
): () => void {
  const intervalMs = opts.intervalMs ?? WORKFLOW_QUEUE_INTERVAL_MS;
  const adminDb = opts.adminDb;
  if (!adminDb) {
    // Not a warning: a composition with no platform database has no queue to
    // deliver, which is the ordinary shape of a unit test.
    log.debug("queue sweep not started: no platform database");
    return () => undefined;
  }
  if (intervalMs <= 0) {
    // `info`, and loud about the consequence: this is the documented kill switch
    // and nothing else advances a durable run.
    log.info("queue sweep NOT started: interval is 0, so no durable run will advance");
    return () => undefined;
  }

  // The replica's DELIVERY budget, shared by every pass this sweep starts —
  // `workflow-queue-budget.ts` carries the whole argument and the measurement.
  // It lives here rather than inside `runQueuePass` because it has to outlive one
  // pass: that is the entire point.
  const inFlight = createDeliveryBudget(opts.concurrency ?? WORKFLOW_QUEUE_DELIVER_CONCURRENCY);
  const passOpts: QueueSweepOptions = { ...opts, inFlight };

  // A NOTIFY burst COALESCES, and the interval deliberately does NOT go through
  // the same runner.
  //
  // A notification is an EVENT, and ten enqueues landing together must not start
  // ten passes — `createCoalescingRunner` collapses them into at most one in
  // flight plus one trailing, and the trailing run re-reads the queue when it
  // runs rather than carrying anything from the trigger. The notification carries
  // no payload for the same reason.
  //
  // A TICK is not an event, and gating it on "a pass is already in flight" was
  // the starvation bug: a pass runs as long as its slowest DELIVERY, up to
  // `QUEUE_DELIVERY_TIMEOUT_MS`, so one slow step anywhere on the replica stopped
  // every other tenant's message from being claimed for up to a minute. Ticks
  // therefore overlap now, and what bounds the work is `inFlight` above — a tick
  // with no free slot returns before it reserves a connection, so an overlapping
  // tick during a slow delivery costs nothing. `claimDue` re-checks its predicate
  // under the row lock, so concurrent passes take DISJOINT sets; that was always
  // true (see this module's doc) and is what makes the overlap safe rather than
  // merely cheap.
  const runner = createCoalescingRunner(() => runQueuePass(passOpts));

  const timer = setInterval(() => {
    void runQueuePass(passOpts).catch((error: unknown) => {
      // `createIntervalSweep` used to own this catch. A tick's pass has no other
      // caller, so a rejection here would be unhandled — same shape as the
      // notified path below.
      log.warn("queue pass failed", { error: errorMessage(error) });
    });
  }, intervalMs);
  timer.unref?.();
  const stopInterval = (): void => clearInterval(timer);

  // The interval STAYS, and this is the part worth reading twice. A notification
  // is not durable: Postgres drops it when nothing is listening, and a listener
  // re-establishing its connection misses everything committed in between. It also
  // cannot express "due at T" — a parked message (which is how `sleep()` works) has
  // a future `available_at` and nothing announces its arrival. So the interval is
  // the mechanism that makes delivery eventual, and the listener only removes the
  // LATENCY of waiting for it on the common path: a step that enqueues its
  // successor no longer pays the poll interval for the hop.
  let stopListening: (() => void) | undefined;
  let stopped = false;
  void adminDb
    .listen(WORKFLOW_QUEUE_CHANNEL, () => {
      void runner.trigger().catch((error: unknown) => {
        // The interval's own pass reports through `runQueuePass`; a trigger from
        // this path has no other caller, so a rejection here would be unhandled.
        log.warn("notified queue pass failed", { error: errorMessage(error) });
      });
    })
    .then((unlisten) => {
      // `stop()` may have run while the subscription was still being established —
      // tear it down immediately rather than leaving a listener behind a stopped
      // sweep.
      if (stopped) {
        unlisten();
        return;
      }
      stopListening = unlisten;
      log.info(`listening on ${WORKFLOW_QUEUE_CHANNEL} for due work`);
    })
    .catch((error: unknown) => {
      // Degraded, not failed, and it says which: the interval alone still delivers
      // every message, just at up to `intervalMs` of extra latency per hop.
      log.warn(
        `queue NOTIFY subscription failed — delivery falls back to the ${intervalMs}ms ` +
          "poll alone, which is slower per step but loses nothing",
        { error: errorMessage(error) },
      );
    });

  log.info(`delivering queued workflow messages on notify, and every ${intervalMs}ms`);
  return () => {
    stopped = true;
    stopListening?.();
    stopInterval();
  };
}
