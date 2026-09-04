// Copyright 2026 the AAI authors. MIT license.
/**
 * Re-enqueue a durable run the queue has lost.
 *
 * ## The safety net that went with the DevKit's world
 *
 * `QUEUE_MAX_ATTEMPTS` bounds redelivery because "a message whose guest cannot
 * be reached is not made more deliverable by trying forever, and every attempt
 * boots a sandbox". That bound was always backed by a recovery, and
 * `workflow-queue-store.ts` still says so in the same paragraph: past the budget
 * "the row is dropped and the run stalls — which the DevKit already recovers
 * from on any later boot, since its world re-enqueues active runs on `start()`".
 *
 * The replay engine replaced that world and inherited no such boot step, so
 * abandonment became PERMANENT. Observed exactly as the sweep's own warning
 * predicts:
 *
 * ```text
 * workflow.queue.sweep abandoned 1 message(s) after the retry budget — those
 * runs are stalled until something else boots their agent
 * ```
 *
 * Nothing was going to boot their agent.
 *
 * ## Why the JOURNAL is the authority here, not the queue
 *
 * A run's status lives in `aai_platform.workflow_runs`; a queue row is only a
 * request to walk it. So "this run is not finished and nothing is scheduled to
 * touch it" is answerable in one query, and it is the honest definition of
 * stalled — it covers an abandoned message, an enqueue that failed on the way
 * out (`workflow-platform-dispatch.ts` logs one and cannot do more), and a row
 * lost to any future bug in the queue itself.
 *
 * That is the change this makes to what the platform considers authoritative,
 * and it is deliberate: the queue was never the record of what is outstanding.
 *
 * ## What keeps it from being a boot storm
 *
 * Four things, and each is a way this goes wrong:
 *
 * - **A GRACE window, measured from the last time the PLATFORM touched the run.**
 *   A run that went `running` a second ago is being walked right now by a guest
 *   that has not journaled anything yet. Re-enqueueing it would double-deliver
 *   constantly. `STALL_GRACE_MS` is far longer than any delivery is allowed to
 *   take.
 *
 *   It used to be measured from `created_at` alone, which is fixed at creation —
 *   so it gated FIRST eligibility and nothing else: past ten minutes a run was
 *   eligible on EVERY pass, with no per-run throttle and no backoff. That defeats
 *   `QUEUE_MAX_ATTEMPTS`, whose whole justification is that "every attempt boots
 *   a sandbox": a run whose guest cannot be reached burns its five attempts in
 *   ~380s, is dropped, and was back inside one tick. `reconciled_at` is the other
 *   half — {@link markReconciled} stamps it in the same pass that writes the
 *   message, so the window gates the RATE too and the sweep's operator-facing
 *   warning ("once they have been idle for 10 minutes") is finally true.
 * - **A PARK is not a stall.** `await ctx.waitFor(token)` with no `timeoutMs` is
 *   the steady state of the human-approval workflow the SDK documents, and it
 *   looks exactly like abandonment from here: `workflow-replay.ts` suspends the
 *   walk with `wakeAt: undefined` and `workflow-engine.ts` dispatches only when
 *   `wakeAt !== undefined`, "a HOOK does not [schedule its own delivery] …
 *   dispatching anyway would poll a run that may be parked for a week". So the
 *   predicate reads the hook table: an OPEN window (undelivered, unclosed) whose
 *   deadline has not elapsed means the run is waiting, not lost. Without that arm
 *   every parked run was one sandbox boot every couple of ticks, forever, fleet
 *   wide — reconcile enqueues, the guest re-walks and re-suspends, `ack` deletes
 *   the row, and the next idle tick starts again.
 * - **A DERIVED message id.** `reconcile_<runId>`, and `enqueue` is
 *   `on conflict do nothing` on the id — so N replicas reconciling one run in the
 *   same tick write ONE row. That is all the id buys, and the limit is worth
 *   stating: a live enqueue from the guest carries an id of its own, so a
 *   reconcile racing one writes a SECOND row for that run. `claimDue`'s
 *   `distinct on (slug, runId)` is what stops the pair being two concurrent
 *   deliveries; the loser is claimed on a later pass and re-walks a run that has
 *   already moved, which replay makes idempotent and which costs a sandbox boot.
 * - **A WIDTH.** Bounded per pass like the delivery fan-out beside it, because a
 *   platform-wide outage means every run in the fleet looks stalled at once.
 * - **PER-RUN isolation of the enqueue**, which is the fifth because the first
 *   four are all defeated without it. `markReconciled` is what makes the grace
 *   window a THROTTLE rather than merely a first-eligibility gate, and it runs
 *   after the loop — so one throwing enqueue meant no run in the batch was
 *   stamped, and every one of them came back on the next tick. Observed on a dev
 *   server as a repeating `queue pass failed` beside a re-walk logged every
 *   second: one deleted agent switched the boot-storm guard off for the whole
 *   fleet. See {@link reconcileStalledRuns}.
 *
 * @internal
 */

import { errorMessage } from "@alexkroman1/aai";
import { abandonStalledRun, RECONCILE_MAX_ATTEMPTS } from "./_reconcile-abandon.ts";
import { createLogger } from "./logger.ts";
import { sqlState } from "./platform-db-errors.ts";
import type { SqlExec } from "./secret-store.ts";
import { enqueue } from "./workflow-queue-store.ts";

const log = createLogger("workflow.queue.reconcile");

/** Postgres `foreign_key_violation` — `workflow_queue_slug_fkey`, here. */
const FOREIGN_KEY_VIOLATION = "23503";

/**
 * Did this enqueue fail because the agent is GONE?
 *
 * Read the SQLSTATE, never the message — the same argument `secret-store.ts`
 * makes for `23505`: a driver rewording "violates foreign key constraint" would
 * silently turn this skip back into the pass-wide throw it exists to prevent.
 */
function isAgentGone(err: unknown): boolean {
  return sqlState(err) === FOREIGN_KEY_VIOLATION;
}

/**
 * How long a run may sit untouched before it counts as stalled — AND the minimum
 * time between two re-enqueues of the same run.
 *
 * Must exceed the longest a legitimate walk can hold a run without journaling —
 * `QUEUE_DELIVERY_TIMEOUT_MS` (60s) plus a sandbox boot — with room to spare,
 * because the cost of being wrong is asymmetric: too short double-delivers a
 * healthy run, too long delays a recovery nobody is waiting on synchronously.
 *
 * ONE number for both, deliberately. Two would be two things to reason about
 * where the question is the same one — "how long must this run have been idle" —
 * and the second answer would immediately drift from the sentence
 * `workflow-queue-sweep.ts` prints at an operator. Read the predicate as
 * `greatest(created_at, reconciled_at) < now - STALL_GRACE_MS`, which is what it
 * is; it is spelled as two comparisons against one cutoff only so the
 * `created_at` half stays indexable (`workflow_runs_stalled_idx`).
 */
export const STALL_GRACE_MS = 10 * 60 * 1000;

/** How many stalled runs one pass may re-enqueue. */
export const RECONCILE_MAX_PER_TICK = 20;

/** The orchestration topic for a run — the same grammar the guest composes. */
const queueNameFor = (runId: string) => `__wkf_workflow_${runId}`;

/**
 * What one reconcile pass did.
 *
 * ONE number, not two. It carried an `enqueued` beside this and the pair could
 * never disagree: `enqueue` answers `{ id }` for an insert AND for a conflict
 * when no idempotency key is supplied (`workflow-queue-store.ts`), so a
 * `if (id) enqueued++` counted every iteration and reported conflicts as fresh
 * writes. Distinguishing them would take a `xmax = 0`-style signal out of the
 * insert, which nothing needs yet — so the honest report is how many runs this
 * pass issued an idempotent re-walk for.
 */
export type ReconcilePass = {
  /** Runs this pass issued an idempotent re-walk for. */
  stalled: number;
  /**
   * Runs it could NOT enqueue, and carried on past — almost always an agent
   * deleted between the predicate and the insert. See {@link reconcileStalledRuns}.
   *
   * `workflow-queue-sweep.ts` still gates its operator-facing line on
   * {@link ReconcilePass.stalled} rather than on this, and reports this only in
   * the structured payload beside it. That is not an oversight: each skip is
   * logged HERE as it happens — `debug` when an agent delete raced, which is
   * benign and expected, `warn` when it did not — so a skip-only pass is already
   * reported, and gating on both put `runQueuePass` over its cognitive-complexity
   * ceiling.
   */
  skipped: number;
  /**
   * Runs it gave up on and moved to `failed` — see {@link RECONCILE_MAX_ATTEMPTS}.
   *
   * Reported separately from {@link ReconcilePass.stalled} because it is the
   * opposite outcome: a repair issued, against a repair abandoned. Each one is
   * also logged HERE at `warn` as it happens, since it is the one thing this
   * pass does that an author sees in their own run history.
   */
  abandoned: number;
};

/** A run the queue has lost, and how many times this pass's predecessors found it. */
export type StalledRun = { slug: string; runId: string; reconciles: number };

/**
 * The PREDICATE, split from the write.
 *
 * Two reasons, and the second is why it is exported. It is the half that needs a
 * real database — four correlated subqueries across the queue and two journal
 * tables, against a grace window compared in SQL — so it is what a scenario test
 * should drive. And
 * driving the whole pass there means WRITING to the shared queue, which
 * `workflow-queue-store.scenario.test.ts` documents as the one thing a second
 * suite over this database must not do: files run in parallel, its `claimDue` is
 * fleet-wide, and a row of ours existing for even a moment lands in its
 * `toEqual([ids])`. Measured, not theorised — three of its cases failed that way.
 *
 * @internal
 */
export async function findStalledRuns(
  sql: SqlExec,
  opts: { maxPerTick?: number; now?: number } = {},
): Promise<StalledRun[]> {
  const limit = opts.maxPerTick ?? RECONCILE_MAX_PER_TICK;
  // `not exists` rather than a left join: the queue is expected to be EMPTY for
  // almost every run, so the planner should stop at the first matching row.
  //
  // `pending` as well as `running`, because a `start` whose enqueue failed never
  // left pending — that is the case `workflow-platform-dispatch.ts` logs and
  // cannot recover on its own. The status list is written out rather than
  // negated so it keeps matching `workflow_runs_stalled_idx`'s predicate, which
  // is the index serving the filter, the ordering and the bound in one walk
  // (`20260901020000_workflow_reconcile_cost.sql`).
  //
  // The last clause is the PARK. A hook row that is neither delivered nor closed
  // is an open window, and a run holding one is waiting rather than lost — see
  // the module doc. It is QUALIFIED by the deadline, because a TIMED
  // `waitFor` journals its deadline as a `hookTimeout` sleep and suspends with a
  // `wakeAt`, so the queue row above is what normally excludes it: if that
  // message is lost, the deadline elapses with an open hook and nothing
  // scheduled, and the open-hook arm alone would hide that run forever. Any
  // unwoken sleep past the cutoff says so, with no dependence on the runtime's
  // `hook!<token>#<n>` / `hookTimeout!<token>#<n>` key grammar — a coupling this
  // side could not
  // see break — and it picks up a plain `ctx.sleep` whose wake was lost too.
  const rows = await sql(
    `select r.slug, r.run_id, r.reconciles
       from aai_platform.workflow_runs r
      where r.status in ('pending', 'running')
        and r.created_at < $1
        and (r.reconciled_at is null or r.reconciled_at < $1)
        and not exists (
              select 1 from aai_platform.workflow_queue q
               where q.slug = r.slug and q.queue_name = $2 || r.run_id
            )
        and (
              not exists (
                    select 1 from aai_platform.workflow_hooks h
                     where h.slug = r.slug and h.run_id = r.run_id
                       and h.delivered = false and h.closed = false
                  )
              or exists (
                    select 1 from aai_platform.workflow_sleeps s
                     where s.slug = r.slug and s.run_id = r.run_id
                       and s.woken = false and s.wake_at < $1
                  )
            )
      order by r.created_at
      limit $3`,
    [(opts.now ?? Date.now()) - STALL_GRACE_MS, "__wkf_workflow_", limit],
  );
  return rows.map((row) => ({
    slug: String(row.slug),
    runId: String(row.run_id),
    reconciles: Number(row.reconciles),
  }));
}

/**
 * Stamp the runs this pass re-enqueued, so the next pass leaves them alone.
 *
 * The THROTTLE half of {@link STALL_GRACE_MS}, and exported for the same reason
 * {@link findStalledRuns} is: driving `reconcileStalledRuns` from a scenario
 * suite means writing to the shared queue, which
 * `workflow-queue-store.scenario.test.ts` documents as the one thing a second
 * suite over this database must not do. This writes only to `workflow_runs`.
 *
 * AFTER the enqueues, and one statement for all of them. After, because a stamp
 * written first and an enqueue that then throws would buy the run a full window
 * of silence for a message nobody wrote. One statement, because the pass is
 * already `RECONCILE_MAX_PER_TICK` inserts deep on a RESERVED connection and a
 * second round trip per run would double that for bookkeeping.
 *
 * **It also increments `reconciles`, which is the whole cost of having a budget**
 * ({@link RECONCILE_MAX_ATTEMPTS}): the stamp is already the one write per pass
 * that names exactly the runs a repair was issued for, so counting them is a
 * column on a statement that was happening anyway. A run stamped here is a run
 * that really got a message — the same reason this takes `scheduled` rather than
 * everything the predicate found.
 *
 * @internal
 */
export async function markReconciled(
  sql: SqlExec,
  // The PAIR, not a `StalledRun`: the count is what this writes, never what it
  // reads, so asking for it would make every caller supply a value it ignores.
  runs: readonly Pick<StalledRun, "slug" | "runId">[],
  now = Date.now(),
): Promise<void> {
  if (runs.length === 0) return;
  // Paired positionally: `unnest` of two arrays rather than a `values` list, so
  // the statement text is CONSTANT whatever the pass width — a per-width text is
  // a per-width entry in every plan cache on the connection.
  await sql(
    `update aai_platform.workflow_runs r
        set reconciled_at = $1, reconciles = r.reconciles + 1
       from unnest($2::text[], $3::text[]) as t(slug, run_id)
      where r.slug = t.slug and r.run_id = t.run_id`,
    [now, runs.map((run) => run.slug), runs.map((run) => run.runId)],
  );
}

/**
 * Find runs that are unfinished with nothing scheduled, and schedule one.
 *
 * @internal
 */
export async function reconcileStalledRuns(
  sql: SqlExec,
  opts: { maxPerTick?: number } = {},
): Promise<ReconcilePass> {
  const stalled = await findStalledRuns(sql, opts);
  /** The runs whose message really landed — the only ones {@link markReconciled} may stamp. */
  const scheduled: StalledRun[] = [];
  let skipped = 0;
  let abandoned = 0;

  for (const run of stalled) {
    const { slug, runId } = run;
    // Out of budget: FAIL it rather than writing a sixth message. Nothing else on
    // the platform ever writes a terminal status, so without this arm the run is
    // repaired every `STALL_GRACE_MS` for as long as the table holds it — see
    // {@link RECONCILE_MAX_ATTEMPTS}. Not stamped either: it is terminal now, so
    // the predicate cannot select it again and there is no throttle to buy.
    if (run.reconciles >= RECONCILE_MAX_ATTEMPTS) {
      if (await abandonStalledRun(sql, run)) abandoned += 1;
      continue;
    }
    // Sequential because there is nothing to fan out ONTO: the caller hands in
    // one RESERVED connection (`runQueuePass`), so concurrency here would only
    // queue on it. What that does mean is that a full pass costs up to
    // `RECONCILE_MAX_PER_TICK` inserts plus the same number of `pg_notify`
    // round trips — `enqueue` announces on every zero-delay write — all inside
    // the reservation the claim's own doc calls brief. A batched multi-row
    // insert with one announce is the fix if a pass ever measures long; it needs
    // a bulk entry point on `workflow-queue-store.ts`, which does not exist yet.
    // PER-RUN, for the same reason the delivery fan-out beside it settles each
    // message on its own: this loop is a REPAIR across tenants, so one run that
    // cannot be repaired must cost the others nothing.
    //
    // The failure is a real one and it is not rare. `workflow_runs.slug` and
    // `workflow_queue.slug` both reference `agents` with `on delete cascade`, so
    // a run whose agent is gone cannot exist — but the predicate above and this
    // insert are two autocommit statements on a RESERVED (not transacted)
    // connection, and a delete landing between them leaves this loop holding a
    // slug the FK no longer accepts. The window is the whole loop: up to
    // `RECONCILE_MAX_PER_TICK` inserts, each with a `pg_notify` round trip.
    //
    // Thrown, it took the entire pass with it — and the damage was never the one
    // run. `markReconciled` below never ran, so NO run in the batch was stamped
    // and every one of them was re-found and re-enqueued on the very next tick,
    // which is exactly the per-run throttle `STALL_GRACE_MS` exists to be. A
    // deleted agent turned the boot-storm guard off fleet-wide.
    try {
      await enqueue(sql, {
        // DERIVED from the run, so two reconcile passes racing each other write
        // one row — `enqueue` is `on conflict do nothing` on the id.
        id: `reconcile_${runId}`,
        slug,
        queueName: queueNameFor(runId),
        payload: { runId },
      });
      scheduled.push(run);
    } catch (err) {
      skipped += 1;
      if (isAgentGone(err)) {
        // DEBUG: the run is already gone with its agent (the cascade), so there
        // is nothing left to repair, nothing to tombstone, and no operator
        // action. Losing the race is the ordinary outcome of deleting an agent
        // that had work in flight.
        log.debug("stalled run's agent was deleted mid-pass; nothing left to schedule", {
          slug,
          runId,
        });
      } else {
        // Anything else is unexplained, so it is worth a line — but still not
        // worth the other tenants' repairs.
        log.warn("could not re-enqueue a stalled run; the rest of the pass continues", {
          slug,
          runId,
          error: errorMessage(err),
        });
      }
    }
  }
  // Only what really landed. A run whose enqueue failed must NOT be stamped:
  // the stamp buys a full `STALL_GRACE_MS` of silence, and for the transient
  // half of the branch above that is a window of silence for a message nobody
  // wrote — the same argument this function's stamp-after-enqueue ordering
  // already makes, one case finer.
  await markReconciled(sql, scheduled);
  return { stalled: scheduled.length, skipped, abandoned };
}
