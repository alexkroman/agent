// Copyright 2026 the AAI authors. MIT license.
/**
 * What DELIVERS the durable-workflow queue: claim due messages, hand each to the
 * tenant's guest, ack or back off.
 *
 * Split from `workflow-queue-store.ts` along the seam the retired wake sweep drew
 * first: the store decides which messages are due and moves them between states,
 * this decides what to DO about one. Read the
 * store first — its module doc carries why delivery is out of band at all, and
 * the three queue designs that had to fail before this shape was clear.
 *
 * ## Delivery is INJECTED, and that is not only for tests
 *
 * `deliver` is a parameter because the thing it eventually does — resolve the
 * tenant's guest through the broker, then POST — belongs to the routing layer,
 * not to a queue. Keeping it out means this module can be driven exhaustively
 * without a guest, a sandbox or a broker, and it means the eventual HTTP half has
 * one seam rather than being threaded through the policy.
 *
 * ## A NOTIFY removes the latency; the INTERVAL is what makes delivery eventual
 *
 * `enqueue` announces on `WORKFLOW_QUEUE_CHANNEL` when a message is due now, and a
 * replica listens. That is the same thing graphile-worker does with `jobs:insert`,
 * and it exists because the interval below is the latency floor of every
 * step-to-step hop — a workflow enqueuing its next step waited out a whole tick
 * before the step ran.
 *
 * The interval is NOT removed, and the reason is not caution. A notification is
 * dropped rather than queued when nothing is listening, so anything committed
 * while a listener reconnects is never announced; and it cannot express "due at
 * T", so a PARKED message — which is how `sleep()` is implemented — has no
 * arrival to announce. The interval therefore remains the mechanism that makes
 * delivery eventual, and the listener is a latency optimization on the common
 * path. Anything that treats the notification as the record of work is wrong.
 *
 * ## NO LEADER LOCK, unlike the wake sweep this replaced
 *
 * That sweep elected one replica per tick because its work was idempotent but
 * duplicated — every replica would read every app's hint. Here the claim itself is
 * the coordination: `claimDue`'s UPDATE re-checks the unclaimed
 * predicate under the row lock, so N replicas sweeping at once take DISJOINT sets
 * (asserted in `workflow-queue-store.scenario.test.ts`, where removing that
 * re-check hands one message to eight sweeps at once). So more replicas is more
 * throughput here rather than more duplication, and a lock would only serialize
 * what is already safe.
 *
 * @module
 */

import { errorMessage } from "@alexkroman1/aai";
import { createCoalescingRunner } from "@alexkroman1/aai/internal";
import { createIntervalSweep } from "./_interval-sweep.ts";
import { mapConcurrent } from "./_pool.ts";
import { envCount, envMs } from "./constants.ts";
import { createLogger } from "./logger.ts";
import type { AdminDb } from "./platform-lock.ts";
import type { SqlExec } from "./secret-store.ts";
import { claimDue } from "./workflow-queue-claim.ts";
import {
  ack,
  fail,
  type QueuedMessage,
  reschedule,
  WORKFLOW_QUEUE_CHANNEL,
} from "./workflow-queue-store.ts";

const log = createLogger("workflow.queue.sweep");

// ── This concern's own numbers ───────────────────────────────────────────────
//
// Here rather than in `constants.ts`, which is at its line cap — the placement
// rule `WORKFLOW_WAKE_READ_CONCURRENCY` follows.

/**
 * How often a replica looks for due work.
 *
 * One second, and it is the latency floor of every step-to-step hop: a workflow
 * that enqueues its next step waits out this interval before the step runs. The
 * wake sweep can afford 60s because it only notices a run nobody is delivering
 * to; this IS the delivery, so the number a user feels is the sum of it and the
 * guest's own work.
 *
 * The cost of a tick that finds nothing is one indexed query — a BitmapOr of
 * `workflow_queue_due_idx` and `workflow_queue_claimed_idx`, measured at 0.201 ms
 * against a 200,000-row queue — so an idle fleet pays close to nothing for the
 * frequency. That is the IDLE tick, and this comment used to claim the same index
 * "covers exactly this predicate" full stop: it does not, because the claim's
 * `(locked_at is null OR locked_at < <stale>)` has an arm that partial index
 * excludes by construction. A BUSY tick is served by `workflow_queue_run_idx`
 * instead, which is a whole `explain (analyze)` of its own —
 * `20260828040000_workflow_queue_run_index.sql` carries it.
 *
 * Override with `WORKFLOW_QUEUE_INTERVAL_MS`; **0 disables delivery entirely**,
 * which is announced, because a durable run then never advances.
 */
export const WORKFLOW_QUEUE_INTERVAL_MS = envMs(process.env.WORKFLOW_QUEUE_INTERVAL_MS, 1000);

/**
 * Messages one tick may claim.
 *
 * A ceiling on how much a single replica takes on, not on throughput: what is not
 * claimed stays due and the next tick (or another replica) takes it. Sized above
 * a plausible burst — a fan-out enqueues one message per branch — so a fan-out
 * does not spread across ticks and pay the interval per branch.
 */
export const WORKFLOW_QUEUE_MAX_PER_TICK = envCount(process.env.WORKFLOW_QUEUE_MAX_PER_TICK, 32);

/**
 * Deliveries in flight at once, per replica.
 *
 * Each is an HTTP request into a guest, so this bounds sockets rather than
 * database connections — the claim has already committed by the time any
 * delivery starts. Distinct from `claimDue`'s one-per-run rule, which is about
 * one RUN's ordering; this is about one replica's fan-out across many runs.
 */
export const WORKFLOW_QUEUE_DELIVER_CONCURRENCY = envCount(
  process.env.WORKFLOW_QUEUE_DELIVER_CONCURRENCY,
  8,
);

/**
 * What a guest did with one delivery.
 *
 * THREE outcomes, not two, and the third is why this is a union rather than
 * `Promise<void>`: the DevKit's queue callback answers `200` with a
 * `{"timeoutSeconds": n}` body when the run PARKED ITSELF, which is how `sleep()`
 * works. A void-or-throw seam has nowhere to put that, so a sleeping run reads
 * as completed and never wakes — a wedge with no error anywhere. See
 * {@link reschedule}.
 *
 * A rejection is still the failure signal, because a failure is anything that
 * went wrong on the way (an unreachable guest, a 500, a timeout) and there is no
 * information in it beyond the error itself.
 */
export type Delivered =
  | { type: "completed" }
  | {
      type: "reschedule";
      /** How long the run asked to sleep. Clamped at zero by the store. */
      delaySeconds: number;
    };

/** Hands one claimed message to its tenant's guest. Rejects to signal failure. */
export type DeliverMessage = (message: QueuedMessage) => Promise<Delivered>;

/** What one pass did, for the caller's own reporting and for tests. */
export type SweepPass = {
  claimed: number;
  delivered: number;
  /** Delivered, and the run asked to be brought back later — a `sleep()`. */
  rescheduled: number;
  retried: number;
  dropped: number;
};

export type QueueSweepOptions = {
  /** The platform's admin connection. Absent means no queue and no sweep. */
  adminDb?: AdminDb | undefined;
  /** How a message reaches its guest — see the module doc. */
  deliver: DeliverMessage;
  /** Serving predicate: a draining replica claims nothing new. */
  isDraining?: (() => boolean) | undefined;
  maxPerTick?: number | undefined;
  concurrency?: number | undefined;
};

/**
 * Run one pass: claim, deliver, settle.
 *
 * Exported for the tests, which drive a pass directly rather than waiting out an
 * interval — the interval is `createIntervalSweep`'s business and has its own
 * spec.
 *
 * @internal
 */
export async function runQueuePass(opts: QueueSweepOptions): Promise<SweepPass> {
  const empty: SweepPass = { claimed: 0, delivered: 0, rescheduled: 0, retried: 0, dropped: 0 };
  const adminDb = opts.adminDb;
  if (!adminDb || opts.isDraining?.()) return empty;

  // A RESERVED connection for the claim, released before any delivery starts: a
  // delivery is an HTTP request into a guest and may take seconds, and holding a
  // pooled connection across it is how a slow guest becomes a connection
  // shortage. The claim is one statement, so the reservation is brief.
  const reserved = await adminDb.reserve();
  let claimed: QueuedMessage[];
  try {
    claimed = await claimDue(
      (q, p) => reserved.query(q, p),
      opts.maxPerTick ?? WORKFLOW_QUEUE_MAX_PER_TICK,
    );
  } finally {
    reserved.release();
  }
  if (claimed.length === 0) return empty;

  // The settle statements take a connection PER STATEMENT, not one for the pass.
  // This used to reserve once around the whole fan-out below, which is the exact
  // shortage the claim above is careful to avoid, one paragraph later and far
  // worse: a settle is interleaved with DELIVERIES, and a delivery is
  // `brokerSessionUrl` (up to `BROKER_READY_TIMEOUT_MS`) plus a POST bounded at
  // `QUEUE_DELIVERY_TIMEOUT_MS`. At the defaults — 32 messages a tick, 8 in
  // flight — one pass against unreachable guests pinned a connection for minutes
  // out of `ADMIN_POOL_MAX`, which is 4 for the whole replica.
  //
  // Each of `ack`/`fail`/`reschedule` is a single statement and no transaction
  // spans them, so per-statement is not merely cheaper — it is all they need. A
  // burst of concurrent settles simply queues on the pool, holding it for one
  // round trip each rather than for a delivery each.
  const settle = async <T>(run: (sql: SqlExec) => Promise<T>): Promise<T> => {
    const conn = await adminDb.reserve();
    try {
      return await run((q, p) => conn.query(q, p));
    } finally {
      conn.release();
    }
  };
  // Bounded fan-out over a fixed list, in ITEM order — `_pool.ts`'s own doc
  // argues why a worker pool rather than a semaphore: a lapsed acquire in a
  // background pass is work silently not done.
  const outcomes = await mapConcurrent(
    claimed,
    opts.concurrency ?? WORKFLOW_QUEUE_DELIVER_CONCURRENCY,
    async (message) => {
      try {
        const outcome = await opts.deliver(message);
        if (outcome.type === "reschedule") {
          await settle((sql) => reschedule(sql, message.id, outcome.delaySeconds));
          return "rescheduled" as const;
        }
        await settle((sql) => ack(sql, message.id));
        return "delivered" as const;
      } catch (err) {
        // PER-MESSAGE isolation. One unreachable guest must not cost every
        // other tenant its tick — which is the same argument the wake sweep's
        // per-app connection makes, one layer up.
        log.debug("delivery failed", {
          id: message.id,
          slug: message.slug,
          attempt: message.attempt,
          error: errorMessage(err),
        });
        return await settle((sql) => fail(sql, message.id, message.attempt));
      }
    },
  );

  const pass: SweepPass = {
    claimed: claimed.length,
    delivered: outcomes.filter((o) => o === "delivered").length,
    rescheduled: outcomes.filter((o) => o === "rescheduled").length,
    retried: outcomes.filter((o) => o === "retry").length,
    dropped: outcomes.filter((o) => o === "dropped").length,
  };
  // A pass that delivered everything is DEBUG; anything abandoned is a stalled
  // run and worth a line an operator sees.
  if (pass.dropped > 0) {
    log.warn(
      `abandoned ${pass.dropped} message(s) after the retry budget — those runs are stalled ` +
        "until something else boots their agent",
      pass,
    );
  } else {
    log.debug("pass", pass);
  }
  return pass;
}

/**
 * Start delivering. Returns its stop.
 *
 * Sync and fire-and-forget per tick, like every other sweep here: the process
 * must not wait on it, and `createIntervalSweep` drops a tick whose predecessor
 * is still running rather than queueing them.
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

  // ONE runner behind both triggers, and it must be one: a notification arriving
  // mid-pass would otherwise start a second concurrent pass on the same replica.
  // That is safe for correctness — `claimDue` re-checks its predicate under the row
  // lock, so two passes take disjoint sets — but it is pointless work, and a burst
  // of N enqueues would start N passes. `createCoalescingRunner` collapses them
  // into at most one in flight plus one trailing, and the trailing run re-reads the
  // queue when it runs rather than carrying anything from the trigger. The
  // notification carries no payload for the same reason.
  const runner = createCoalescingRunner(() => runQueuePass(opts));

  const sweep = createIntervalSweep(() => runner.trigger());
  const stopInterval = sweep.start(intervalMs);

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
