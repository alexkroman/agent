// Copyright 2026 the AAI authors. MIT license.
/**
 * Which runs a BOOT SWEEP still owes a delivery, on a Postgres this deployment
 * owns.
 *
 * Its own module for the reason `_journal-claim.ts` is one:
 * `workflow-journal-postgres.ts` is at the 500-line cap, and this statement's
 * argument — a planner measurement — is longer than the statement. It is also a
 * genuine leaf: `resumableRuns` is optional on {@link JournalStore}, nothing
 * else in that store reads it, and its one caller is
 * `createInProcessWorkflowEngine`'s boot sweep.
 *
 * @module
 */

import type { Db } from "@alexkroman1/aai/internal";
import { millis } from "./_workflow-journal-postgres-rows.ts";
import {
  WORKFLOW_HOOK_TABLE,
  WORKFLOW_RUN_TABLE,
  WORKFLOW_SLEEP_TABLE,
} from "./workflow-journal-schema.ts";
import type { ResumableRun } from "./workflow-journal-types.ts";

/**
 * The runs this journal still owes a delivery, soonest deadline first.
 *
 * @internal
 */
export async function resumableRuns(db: Db, limit: number): Promise<ResumableRun[]> {
  // The status list is written OUT rather than negated and the anti-join is
  // the platform reconcile's park rule (see the interface). `coalesce(wake_at,
  // 0)` orders so that a run waiting on nothing, and the most overdue sleeps,
  // are what survive `limit`. Unindexed deliberately: this runs ONCE, at boot,
  // and an index on `status` would be maintained by every `setStatus` for it.
  //
  // ## The earliest wake is a GROUPED JOIN, not a correlated subquery
  //
  // It was `(select min(s.wake_at) … where s.run_id = r.run_id)` plus an
  // `exists`, inside a CTE. Postgres inlines a single-reference CTE, and the
  // `wake_at` expression is then read THREE times — once for the `is not
  // null` filter, once for the sort key, once for the output — so the
  // correlated subquery was re-planned as a fresh index scan at each site.
  // Checked with the planner against a fixture of 50,000 runs (16,000 of
  // them non-terminal) and 34,000 waits:
  //
  // | | correlated | grouped join |
  // | --- | --- | --- |
  // | execution | 349-375 ms | 24-28 ms |
  // | shared buffers | 123,102 | 1,194 |
  // | loops on the wait scan | 36,000 (2 per candidate) | 0 |
  //
  // A `left join` over one `group by` reads the wait table once, and the
  // hook arm becomes a hashed anti-join read once rather than per row.
  // Verified result-IDENTICAL over the whole 15,999-row answer, not just the
  // first page: `except` in both directions is empty.
  //
  // `as materialized` on the CTE was measured too and is the weaker fix
  // (115 ms): it stops the expression being evaluated three times but keeps
  // one correlated scan per candidate. This keeps none.
  //
  // Why it matters for a query that "runs ONCE, at boot": `aai dev` rebuilds
  // its runtime on every file SAVE, and each rebuild is a boot sweep — see
  // `workflow-in-process.ts`.
  const rows = await db.query<{ run_id: string; wake_at: string | number | null }>(
    `select r.run_id, w.wake_at
       from ${WORKFLOW_RUN_TABLE} r
       left join (select run_id, min(wake_at) as wake_at
                    from ${WORKFLOW_SLEEP_TABLE}
                   where woken = false
                   group by run_id) w on w.run_id = r.run_id
      where r.status in ('pending', 'running')
        and (w.wake_at is not null
             or not exists (select 1 from ${WORKFLOW_HOOK_TABLE} h
                             where h.run_id = r.run_id
                               and h.delivered = false and h.closed = false))
      order by coalesce(w.wake_at, 0), r.run_id
      limit $1`,
    [limit],
  );
  return rows.map((row) => ({
    runId: row.run_id,
    // `undefined` and not `null`, which is what the memory backend answers —
    // one of the five absence drifts the conformance table exists to hammer.
    ...(row.wake_at === null ? {} : { wakeAt: millis(row.wake_at) }),
  }));
}
