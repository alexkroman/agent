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

  // ONE extra look, at the moment the earliest PARKED message becomes due.
  //
  // The interval is otherwise a latency FLOOR for anything parked for less than
  // a tick: a `ctx.sleep("beat", 100)` and a `ctx.sleep("beat", 900)` were
  // resumed at the same moment, on this timer's cadence rather than on their
  // own. `announce` now wakes a pass for a delay at or under
  // `QUEUE_DUE_SOON_MS`, and `msUntilNextDue` is what that pass learns from it —
  // so the notification still says only "look", and this is where "due at T"
  // gets expressed. `workflow-queue-store.ts` carries both halves.
  //
  // ONE timer, replaced by every pass that reports a time: the queue only gains
  // rows, so a later pass's answer is never later than an earlier one's for a
  // row still parked, and a row that became due in between is claimed by the
  // pass rather than waited for. A pass that reports NOTHING leaves the standing
  // timer alone — it may have returned before it could ask (draining, or the
  // delivery budget saturated), and reading that as "the queue is empty" would
  // cancel a look that is still owed.
  let soon: ReturnType<typeof setTimeout> | undefined;
  const clearSoon = (): void => {
    if (soon !== undefined) clearTimeout(soon);
    soon = undefined;
  };
  const scheduleSoon = (pass: { nextDueInMs?: number | undefined }): void => {
    const dueIn = pass.nextDueInMs;
    // Beyond one interval the ordinary tick already gets there first, so a timer
    // would be a second mechanism for work the first one covers.
    if (dueIn === undefined || dueIn >= intervalMs) return;
    clearSoon();
    // At least 1 ms so this cannot become a spin: a row the pass could not claim
    // and that reads as due-in-zero would otherwise re-arm itself immediately.
    soon = setTimeout(
      () => {
        soon = undefined;
        void runner.trigger().catch((error: unknown) => {
          log.warn("due-soon queue pass failed", { error: errorMessage(error) });
        });
      },
      Math.max(1, dueIn),
    );
    soon.unref?.();
  };

  const runner = createCoalescingRunner(async () => {
    const pass = await runQueuePass(passOpts);
    scheduleSoon(pass);
    return pass;
  });

  const timer = setInterval(() => {
    void runQueuePass(passOpts)
      .then(scheduleSoon)
      .catch((error: unknown) => {
        // A tick's pass has no other caller, so a rejection here would be
        // unhandled — same shape as the notified path below.
        log.warn("queue pass failed", { error: errorMessage(error) });
      });
  }, intervalMs);
  timer.unref?.();
  const stopInterval = (): void => clearInterval(timer);

  // The interval STAYS, and this is the part worth reading twice. A notification
  // is not durable: Postgres drops it when nothing is listening, and a listener
  // re-establishing its connection misses everything committed in between. Nor
  // does it express "due at T" — the payload is empty by design, so a parked
  // message's arrival is announced by nothing here; what `announce` does for a
  // SHORT park is wake a pass that then reads the deadline out of the table and
  // arms `scheduleSoon` above, which is a different thing from the notification
  // carrying it. So the interval is the mechanism that makes delivery eventual,
  // and everything above it — the listener, and the due-soon timer it leads to —
  // only removes LATENCY: a step that enqueues its successor no longer pays the
  // poll interval for the hop, and one that sleeps for less than a tick no
  // longer pays a whole one.
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
    clearSoon();
  };
}
