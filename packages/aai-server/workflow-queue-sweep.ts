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
import { mapConcurrent } from "./_pool.ts";
import { envCount, envMs } from "./constants.ts";
import { createLogger } from "./logger.ts";
import type { AdminDb } from "./platform-lock.ts";
import type { SqlExec } from "./secret-store.ts";
import { createDeliveryBudget, type DeliveryBudget } from "./workflow-queue-budget.ts";
import { claimDue } from "./workflow-queue-claim.ts";
import { reconcileStalledRuns, STALL_GRACE_MS } from "./workflow-queue-reconcile.ts";
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
 *
 * **A started sweep claims the SMALLER of this and its free delivery slots**, and
 * that is not a narrowing of it: a claim writes `locked_at`, so a message claimed
 * beyond the in-flight bound is one this replica cannot deliver yet AND has
 * hidden from every other replica. See `workflow-queue-budget.ts`.
 */
export const WORKFLOW_QUEUE_MAX_PER_TICK = envCount(process.env.WORKFLOW_QUEUE_MAX_PER_TICK, 32);

/**
 * Deliveries in flight at once, per replica.
 *
 * Each is an HTTP request into a guest, so this bounds sockets rather than
 * database connections — the claim has already committed by the time any
 * delivery starts. Distinct from `claimDue`'s one-per-run rule, which is about
 * one RUN's ordering; this is about one replica's fan-out across many runs.
 *
 * **It is a bound ACROSS passes, not only within one**, and that is the whole
 * fix for the starvation `workflow-queue-budget.ts` describes.
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
  /**
   * The replica's delivery budget, shared by every pass — see
   * `workflow-queue-budget.ts`, which carries the starvation it fixes.
   *
   * Absent means unbounded across passes, which is what a direct
   * `runQueuePass` call gets: a caller driving one pass has no other pass to be
   * starved by. {@link startWorkflowQueueSweep} always supplies one.
   */
  inFlight?: DeliveryBudget | undefined;
};

/**
 * The CLAIM half of a pass: take up to `limit` due messages, and reconcile when
 * there were none.
 *
 * Its own function only so {@link runQueuePass} stays under the complexity
 * ceiling once the slot bookkeeping around it arrived. The seam is real enough —
 * this is the whole of what runs on a reserved connection, which is the property
 * both comments below are about.
 */
async function claimAndReconcile(
  adminDb: AdminDb,
  limit: number,
): Promise<{ claimed: QueuedMessage[]; repaired: { stalled: number } }> {
  // A RESERVED connection for the claim, released before any delivery starts: a
  // delivery is an HTTP request into a guest and may take seconds, and holding a
  // pooled connection across it is how a slow guest becomes a connection
  // shortage. The claim is one statement, so the reservation is brief.
  const reserved = await adminDb.reserve();
  try {
    const claimed = await claimDue((q, p) => reserved.query(q, p), limit);
    // NOTHING DUE is exactly when a stalled run should be looked for: the queue
    // is idle, the admin pool is free, and a run that is unfinished with no
    // message is invisible to every other pass. It rides the connection the
    // claim already holds rather than taking a second — an idle tick must stay
    // free of the pool, which is 4 for the whole replica — and both statements
    // are brief, so the reservation stays as short as the claim's own doc
    // promises.
    //
    // There is NO leader election here; see this module's doc. Every replica
    // whose tick finds nothing reconciles, so two of them can pick the same run
    // in one pass — the DERIVED message id (`reconcile_<runId>`) is the only
    // thing that collapses that into one delivery.
    //
    // Which is also why its COST is this module's problem and not only the
    // reconcile module's: no leader means this runs at >= 1 Hz PER REPLICA, on
    // this reserved connection, on the branch measured at 0.201 ms and
    // advertised above as close to free. `20260901020000_workflow_reconcile_cost.sql`
    // is what keeps it so — the two indexes the predicate needs (nothing served
    // either the status scan or the `(slug, queue_name)` anti-join), plus the
    // retention sweep that stops terminal runs, which the predicate can never
    // select, growing that scan forever.
    const repaired =
      claimed.length === 0
        ? await reconcileStalledRuns((q, p) => reserved.query(q, p))
        : { stalled: 0 };
    return { claimed, repaired };
  } finally {
    reserved.release();
  }
}

/**
 * Run one pass: claim, deliver, settle.
 *
 * Exported for the tests, which drive a pass directly rather than waiting out an
 * interval — the interval is {@link startWorkflowQueueSweep}'s business.
 *
 * A pass driven directly gets NO {@link QueueSweepOptions.inFlight}, so it
 * behaves as it always did: claim up to `maxPerTick`, fan out at `concurrency`,
 * await the batch. The cross-pass budget is a property of a started sweep, where
 * there is another pass for a slow delivery to starve.
 *
 * @internal
 */
export async function runQueuePass(opts: QueueSweepOptions): Promise<SweepPass> {
  const empty: SweepPass = { claimed: 0, delivered: 0, rescheduled: 0, retried: 0, dropped: 0 };
  const adminDb = opts.adminDb;
  if (!adminDb || opts.isDraining?.()) return empty;

  const maxPerTick = opts.maxPerTick ?? WORKFLOW_QUEUE_MAX_PER_TICK;
  // BEFORE the claim, and a refusal returns before touching the pool: a tick
  // that finds the replica's deliveries saturated must cost nothing, since it is
  // now the ordinary shape of a tick while a slow delivery runs.
  const slots = await opts.inFlight?.take(maxPerTick);
  if (slots && slots.length === 0) return empty;
  // Releases are idempotent, so the per-message release below and this
  // catch-all cannot double-free — see `_semaphore.ts`.
  const releaseAllSlots = (): void => {
    for (const release of slots ?? []) release();
  };

  let claimed: QueuedMessage[];
  let repaired: { stalled: number };
  try {
    ({ claimed, repaired } = await claimAndReconcile(
      adminDb,
      slots ? Math.min(maxPerTick, slots.length) : maxPerTick,
    ));
  } catch (err) {
    // A claim that threw took no delivery, so every slot it reserved has to go
    // back — otherwise a replica whose database is briefly unreachable leaks its
    // whole budget and stops claiming for good.
    releaseAllSlots();
    throw err;
  }
  // The surplus, before any delivery starts: the claim asked for as many as we
  // hold and may answer fewer, and a slot held for a message that does not exist
  // is one the next tick cannot use.
  for (const release of (slots ?? []).slice(claimed.length)) release();
  if (claimed.length === 0) {
    releaseAllSlots();
    if (repaired.stalled > 0) {
      log.warn(
        `scheduled a re-walk for ${repaired.stalled} stalled run(s) — unfinished with nothing ` +
          "scheduled, which is what an abandoned message or a failed enqueue leaves behind",
        repaired,
      );
    }
    return empty;
  }

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
  const settle = <T>(run: (sql: SqlExec) => Promise<T>): Promise<T> => settleOn(adminDb, run);
  // Bounded fan-out over a fixed list, in ITEM order — `_pool.ts`'s own doc
  // argues why a worker pool rather than a semaphore: a lapsed acquire in a
  // background pass is work silently not done.
  // The trailing catch-all is BELT AND BRACES: `_pool.ts` cancels nothing, so
  // each message's own `finally` below runs even when a sibling rejects.
  // Releases are idempotent, so saying it twice costs nothing.
  const outcomes = await mapConcurrent(
    claimed,
    opts.concurrency ?? WORKFLOW_QUEUE_DELIVER_CONCURRENCY,
    async (message, at) => {
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
      } finally {
        // ONE slot, as soon as THIS message settles — not the whole batch when
        // the pass returns. Freeing them together would leave the head-of-line
        // block in place, narrowed from "any delivery on the replica" to "the
        // slowest delivery in this batch".
        slots?.[at]?.();
      }
    },
  ).finally(releaseAllSlots);

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
      `abandoned ${pass.dropped} message(s) after the retry budget — the reconcile pass ` +
        `re-enqueues a run once it has been idle for ${STALL_GRACE_MS / 60_000} minutes, and ` +
        `at most once per ${STALL_GRACE_MS / 60_000} minutes after that, so a guest that stays ` +
        "unreachable costs one boot per window rather than one per tick. A run PARKED on an " +
        "open hook is left alone entirely — it is waiting, not lost.",
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

/**
 * Run one statement on its own reserved connection.
 *
 * Per STATEMENT, never one reservation around a fan-out — see the argument at
 * the settle call site: a delivery can hold a connection for minutes out of an
 * `ADMIN_POOL_MAX` of 4.
 */
async function settleOn<T>(adminDb: AdminDb, run: (sql: SqlExec) => Promise<T>): Promise<T> {
  const conn = await adminDb.reserve();
  try {
    return await run((q, p) => conn.query(q, p));
  } finally {
    conn.release();
  }
}
