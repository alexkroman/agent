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
 * while a listener reconnects is never announced. The interval therefore remains
 * the mechanism that makes delivery eventual, and everything faster is a latency
 * optimization on the common path. Anything that treats the notification as the
 * record of work is wrong.
 *
 * A notification also cannot express "due at T", which used to mean a PARKED
 * message — how `sleep()` is implemented — had no arrival to announce, and so
 * that the interval was the latency FLOOR of every sub-interval sleep whatever
 * its duration. That is closed WITHOUT giving the notification a payload: a
 * short park announces, the pass it wakes claims nothing and instead reads
 * {@link msUntilNextDue}, and `startWorkflowQueueSweep` arms one extra look at
 * the answer. `workflow-queue-store.ts`'s `announce` and `QUEUE_DUE_SOON_MS`
 * carry the argument.
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
import { omitUndefined } from "@alexkroman1/aai/utils";
import { mapConcurrent } from "./_pool.ts";
import { RECONCILE_MAX_ATTEMPTS } from "./_reconcile-abandon.ts";
import { envCount, envMs } from "./constants.ts";
import { createLogger } from "./logger.ts";
import type { AdminDb } from "./platform-lock.ts";
import type { SqlExec } from "./secret-store.ts";
import type { DeliveryBudget } from "./workflow-queue-budget.ts";
import { claimDue } from "./workflow-queue-claim.ts";
import { fail, failUnreachable, isGuestUnreachable } from "./workflow-queue-failure.ts";
import type { ReconcilePass } from "./workflow-queue-reconcile.ts";
import { reconcileStalledRuns, STALL_GRACE_MS } from "./workflow-queue-reconcile.ts";
import { ack, msUntilNextDue, type QueuedMessage, reschedule } from "./workflow-queue-store.ts";

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
 * `workflow_queue_due_idx` and `workflow_queue_claimed_idx`, measured at
 * 0.930-1.024 ms against a 200,000-row queue with 4,000 claims outstanding — so
 * an idle fleet pays close to nothing for the frequency. This comment used to
 * claim the same index "covers exactly this predicate" full stop: it does not,
 * because the claim's `(locked_at is null OR locked_at < <stale>)` has an arm
 * that partial index excludes by construction, which is what makes it a BitmapOr
 * of the two rather than a scan of one.
 *
 * The same pair now serves a BUSY tick as well — 19.56-21.43 ms with 4,000
 * messages due across 500 agents, against 516-527 ms before the claim stopped
 * re-deriving the run and the kind of every candidate row.
 * `20260903010000_workflow_queue_run_kind_columns.sql` carries that measurement,
 * the two columns it rests on, and why the expression index this paragraph used
 * to name (`workflow_queue_run_idx`, from `20260828040000`) is gone with nothing
 * in its place.
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
  /**
   * How long until the earliest PARKED message is due, when this pass got as far
   * as asking — see `msUntilNextDue`.
   *
   * The interval is a latency FLOOR without it: a message parked for less than a
   * tick has no arrival to announce, so every sub-interval `ctx.sleep` cost one
   * full interval whatever its duration. {@link startWorkflowQueueSweep} turns
   * this into ONE extra look; a pass driven directly by a test simply reads it.
   *
   * Absent when the pass returned before reserving a connection (draining, or
   * the replica's deliveries saturated), which is why the reader must treat
   * absence as "no new information" rather than as "nothing is parked".
   */
  nextDueInMs?: number | undefined;
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
): Promise<{ claimed: QueuedMessage[]; repaired: ReconcilePass; nextDueInMs?: number }> {
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
    // claim already holds rather than taking a second — `ADMIN_POOL_MAX` is 16
    // for the whole replica and every platform read shares it, so a tick that
    // finds nothing must not cost the pool twice a second — and both statements
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
    // this reserved connection, on the branch measured at ~1 ms and
    // advertised above as close to free. `20260901020000_workflow_reconcile_cost.sql`
    // is what keeps it so — the two indexes the predicate needs (nothing served
    // either the status scan or the `(slug, queue_name)` anti-join), plus the
    // retention sweep that stops terminal runs, which the predicate can never
    // select, growing that scan forever.
    const repaired: ReconcilePass =
      claimed.length === 0
        ? await reconcileStalledRuns((q, p) => reserved.query(q, p))
        : { stalled: 0, skipped: 0, abandoned: 0 };
    // On the SAME reservation as the claim, for the reason the reconcile above
    // rides it: `ADMIN_POOL_MAX` is 16 for the whole replica, so a tick that
    // finds nothing must not cost the pool twice a second. One ordered index
    // scan stopping at the first row — see `msUntilNextDue`, which carries why
    // this is affordable per pass and what the sweep does with the answer.
    const nextDueInMs = await msUntilNextDue((q, p) => reserved.query(q, p));
    return { claimed, repaired, ...omitUndefined({ nextDueInMs }) };
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
  let repaired: ReconcilePass;
  let nextDueInMs: number | undefined;
  try {
    ({ claimed, repaired, nextDueInMs } = await claimAndReconcile(
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
    // NOT `empty`: this pass did reserve a connection and did ask, and an idle
    // tick is exactly when the answer matters — a run that just parked for 100 ms
    // claims nothing here and is the whole reason the extra look exists.
    const idle: SweepPass = { ...empty, ...omitUndefined({ nextDueInMs }) };
    if (repaired.stalled > 0) {
      log.warn(
        `scheduled a re-walk for ${repaired.stalled} stalled run(s) — unfinished with nothing ` +
          "scheduled, which is what an abandoned message or a failed enqueue leaves behind",
        repaired,
      );
    }
    return idle;
  }

  // The settle statements take a connection PER STATEMENT, not one for the pass.
  // This used to reserve once around the whole fan-out below, which is the exact
  // shortage the claim above is careful to avoid, one paragraph later and far
  // worse: a settle is interleaved with DELIVERIES, and a delivery is
  // `brokerSessionUrl` (up to `BROKER_READY_TIMEOUT_MS`) plus a POST bounded at
  // `QUEUE_DELIVERY_TIMEOUT_MS`. At the defaults — 32 messages a tick, 8 in
  // flight — one pass against unreachable guests pinned a connection for minutes
  // out of `ADMIN_POOL_MAX`, which is 16 for the whole replica. Passes never
  // overlap (`_interval-sweep.ts`), so this is one connection rather than one a
  // second — and one is the point: the pool is SHARED with every platform read
  // the replica makes (Vault, the agents row the broker needs, journal appends,
  // session state), and `platform-db-budget.test.ts` ties `ADMIN_POOL_MAX x
  // MAX_CONTAINERS` to the instance's `max_connections`. So a settle held across
  // a fan-out spends a sixteenth of the replica's whole platform-database
  // capacity for as long as one tenant's guest is unreachable.
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
        // Which BUDGET this spends is decided here and nowhere else, off the
        // one thing the deliverer can say for certain: was a request sent at
        // all. `workflow-queue-failure.ts` carries the argument; the short
        // version is that a sandbox still booting is not a fact about the
        // message, and charging it the message's five attempts dropped runs
        // over infrastructure.
        const unreachable = isGuestUnreachable(err);
        log.debug("delivery failed", {
          id: message.id,
          slug: message.slug,
          attempt: message.attempt,
          unreachable,
          error: errorMessage(err),
        });
        return await settle((sql) =>
          unreachable ? failUnreachable(sql, message.id) : fail(sql, message.id, message.attempt),
        );
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
    // Read BEFORE these deliveries ran, so it cannot see a `sleep()` one of them
    // just parked. That is the safe direction and needs no second query: the
    // reschedule is an enqueue, so the next tick's own read sees it, and this
    // answer only ever costs a look nobody needed.
    ...omitUndefined({ nextDueInMs }),
  };
  // A pass that delivered everything is DEBUG; anything abandoned is a stalled
  // run and worth a line an operator sees.
  if (pass.dropped > 0) {
    const window = STALL_GRACE_MS / 60_000;
    log.warn(
      `abandoned ${pass.dropped} message(s) after the retry budget — the reconcile pass ` +
        `re-enqueues a run once it has been idle for ${window} minutes and at most once per ` +
        `${window} minutes after that, so a guest that stays unreachable costs one boot per ` +
        `window rather than one per tick, and after ${RECONCILE_MAX_ATTEMPTS} such re-walks ` +
        "the platform stops and marks the run failed. A run PARKED on an open hook is left " +
        "alone entirely — it is waiting, not lost.",
      pass,
    );
  } else {
    log.debug("pass", pass);
  }
  return pass;
}

/**
 * Run one statement on its own reserved connection.
 *
 * Per STATEMENT, never one reservation around a fan-out — see the argument at
 * the settle call site: a delivery can hold a connection for minutes out of an
 * `ADMIN_POOL_MAX` of 16, which every platform read on the replica shares.
 */
async function settleOn<T>(adminDb: AdminDb, run: (sql: SqlExec) => Promise<T>): Promise<T> {
  const conn = await adminDb.reserve();
  try {
    return await run((q, p) => conn.query(q, p));
  } finally {
    conn.release();
  }
}
