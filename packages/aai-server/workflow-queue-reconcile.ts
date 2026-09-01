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
 * Three things, and each is a way this goes wrong:
 *
 * - **A GRACE window.** A run that went `running` a second ago is being walked
 *   right now by a guest that has not journaled anything yet. Re-enqueueing it
 *   would double-deliver constantly. `STALL_GRACE_MS` is far longer than any
 *   delivery is allowed to take.
 * - **`on conflict do nothing` on the run's own topic.** The queue name is
 *   `__wkf_workflow_<runId>`, one per run by construction, and the enqueue is
 *   idempotent on the message id — so a reconcile racing a live enqueue writes
 *   nothing rather than a duplicate.
 * - **A WIDTH.** Bounded per pass like the delivery fan-out beside it, because a
 *   platform-wide outage means every run in the fleet looks stalled at once.
 *
 * @internal
 */

import type { SqlExec } from "./secret-store.ts";
import { enqueue } from "./workflow-queue-store.ts";

/**
 * How long a run may sit untouched before it counts as stalled.
 *
 * Must exceed the longest a legitimate walk can hold a run without journaling —
 * `QUEUE_DELIVERY_TIMEOUT_MS` (60s) plus a sandbox boot — with room to spare,
 * because the cost of being wrong is asymmetric: too short double-delivers a
 * healthy run, too long delays a recovery nobody is waiting on synchronously.
 */
export const STALL_GRACE_MS = 10 * 60 * 1000;

/** How many stalled runs one pass may re-enqueue. */
export const RECONCILE_MAX_PER_TICK = 20;

/** The orchestration topic for a run — the same grammar the guest composes. */
const queueNameFor = (runId: string) => `__wkf_workflow_${runId}`;

/** What one reconcile pass did. */
export type ReconcilePass = { stalled: number; enqueued: number };

/** A run the queue has lost. */
export type StalledRun = { slug: string; runId: string };

/**
 * The PREDICATE, split from the write.
 *
 * Two reasons, and the second is why it is exported. It is the half that needs a
 * real database — a `not exists` correlated across two tables against a grace
 * window compared in SQL — so it is what a scenario test should drive. And
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
  // cannot recover on its own.
  const rows = await sql(
    `select r.slug, r.run_id
       from aai_platform.workflow_runs r
      where r.status in ('pending', 'running')
        and r.created_at < $1
        and not exists (
              select 1 from aai_platform.workflow_queue q
               where q.slug = r.slug and q.queue_name = $2 || r.run_id
            )
      order by r.created_at
      limit $3`,
    [(opts.now ?? Date.now()) - STALL_GRACE_MS, "__wkf_workflow_", limit],
  );
  return rows.map((row) => ({ slug: String(row.slug), runId: String(row.run_id) }));
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

  let enqueued = 0;
  for (const { slug, runId } of stalled) {
    // Sequential rather than fanned out: this is a background repair on the
    // admin pool, and a burst of inserts competing with the delivery sweep for
    // `ADMIN_POOL_MAX` is the shortage that pass is careful to avoid.
    const { id } = await enqueue(sql, {
      // DERIVED from the run, so two reconcile passes racing each other write
      // one row — `enqueue` is `on conflict do nothing` on the id.
      id: `reconcile_${runId}`,
      slug,
      queueName: queueNameFor(runId),
      payload: { runId },
    });
    if (id) enqueued++;
  }
  return { stalled: stalled.length, enqueued };
}
