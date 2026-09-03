// Copyright 2026 the AAI authors. MIT license.
/**
 * The platform's DELIVERY CLAIM: which due messages this pass may take.
 *
 * Split from `workflow-queue-store.ts` at the 500-line cap, and the seam is a real
 * one rather than a convenient cut. Everything left there is one MESSAGE's own
 * lifecycle — enqueue it, read its envelope, ack it, reschedule it, fail it — and
 * each of those is addressed by id. This is the only part of the queue that asks a
 * question of the whole TABLE, and the only part with an opinion about how one
 * run's messages may overlap, which is why it owns the two numbers that bound that
 * and nothing else does.
 *
 * The sweep (`workflow-queue-sweep.ts`) is the caller.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import type { SqlExec } from "./secret-store.ts";
import type { QueuedMessage } from "./workflow-queue-store.ts";

/**
 * How long a claim may go unfinished before the sweep may take it again.
 *
 * A replica that dies mid-delivery leaves `locked_at` set, and nothing else would
 * ever release it — the partial index the sweep reads excludes claimed rows by
 * design. Two minutes is well past a delivery (a POST into a guest, with the
 * broker's own 20s readiness cap in front of it) and well under the interval a
 * human would notice a stalled run over.
 *
 * The alternative — a heartbeat on the claim — buys precision this does not need:
 * a redelivery is safe, because the DevKit's journal is what makes a step
 * idempotent, and it is exactly what a crashed replica's messages need.
 */
export const QUEUE_CLAIM_STALE_MS = 120_000;

/**
 * How many of one run's STEP messages may be in flight at once.
 *
 * Beside {@link QUEUE_CLAIM_STALE_MS} rather than with the sweep's own knobs
 * because {@link claimDue} is what enforces it and the sweep imports this module,
 * not the other way round.
 *
 * **Not configurable, and deliberately not a parameter of {@link claimDue}.** It
 * was both — an env override and a defaulted argument — and either one set to `1`
 * silently restores the strictly-serial behaviour this split exists to remove, on
 * a fleet where that regression already shipped once and took a stopwatch to find
 * (#1284 + #1297). A knob whose wrong setting is invisible is worse than no knob;
 * the number is the delivery width, and changing it is a code change.
 *
 * Set to the delivery width, because that is the real ceiling: the sweep delivers
 * at most `WORKFLOW_QUEUE_DELIVER_CONCURRENCY` at a time, so a larger number here
 * only lets one run claim rows it then waits to deliver. **It does not need to be
 * smaller than the width for fairness** — `candidates` orders the whole due set by
 * `available_at` before the limit, so an older message from a quiet run outranks a
 * busy run's newest step. That ordering is the anti-starvation mechanism (see the
 * last bullet on {@link claimDue}); this cap is only the ceiling on how wide ONE
 * run's fan-out gets.
 *
 * A step's own duration is bounded elsewhere and much lower than the DevKit's
 * `maxDuration: max` suggests: `QUEUE_DELIVERY_TIMEOUT_MS` aborts any delivery at
 * 60s, well inside {@link QUEUE_CLAIM_STALE_MS}, so a wide fan-out cannot leave
 * claims stranded past the stale window.
 */
export const WORKFLOW_QUEUE_STEPS_PER_RUN = 8;

/**
 * Claim up to `limit` due messages, at most ONE PER RUN.
 *
 * Four properties, and each is a way this goes wrong:
 *
 * - **One per run for ORCHESTRATION, counting what is already IN FLIGHT — and a
 *   bounded fan-out for STEPS.** The DevKit has two topics and they are not the
 *   same kind of work: `__wkf_workflow_*` is orchestration, which REPLAYS the
 *   run's journal on every delivery, and `__wkf_step_*` is step execution, which
 *   runs one step and reports its result. Two orchestration messages in flight
 *   together interleave two replays of the same log — measured as a bounded
 *   fan-out returning `failed` instead of `completed`, and that is the hazard
 *   this rule exists for. Two STEP messages are `mapConcurrent` working as
 *   designed: the DevKit's own reference integration puts them on a queue
 *   consumer with no per-run serialization at all, and the DevKit's docs mark
 *   them `maxDuration: max` against orchestration's 60.
 *
 *   This used to serialize BOTH, on one `(slug, runId)` key, and the cost was
 *   invisible because nothing failed: a template asking for 32 segments in
 *   flight transcribed them strictly end to end, one queue hop apart, on a
 *   deployed agent. It was a REGRESSION rather than a design — #1284 added this
 *   claim, and #1297 then made the platform world win over a `DATABASE_URL`,
 *   which took every deployed agent's in-run step concurrency from the graphile
 *   path's three (`APP_DB_WORLD_WORKER_CONCURRENCY`) down to one.
 *
 *   So the serialization domain is `(slug, run_id, kind)`. Orchestration keeps
 *   `distinct on` plus the `not exists` — the half that is easy to miss: without
 *   it a run whose earlier message is still being delivered hands out a second
 *   one. Steps get {@link WORKFLOW_QUEUE_STEPS_PER_RUN}, counting in-flight ones,
 *   so one busy run cannot spend the whole tick.
 *
 * - **The kind is a COLUMN, and there is no third case.** `kind` is written at
 *   enqueue from `queueNameKind` (`workflow-queue-store.ts`), so the DevKit's
 *   queue-name grammar is applied exactly once, in TypeScript, at the boundary
 *   that already refuses what it cannot classify — `workflow-enqueue-handler.ts`
 *   answers 400 before the row exists, and the guest's dispatch refuses it again
 *   on delivery. Here it is `kind = 'workflow'` and `kind = 'step'`, neither the
 *   other's complement, so a row with any other value (or none) is claimed by
 *   NOBODY.
 *
 *   It used to be two REGEXES passed in as SQL parameters, and the column is not
 *   merely faster: writing the kind at the door means a DevKit that renames a
 *   topic cannot reclassify a row already in the table. Writing orchestration as
 *   `!~ <step>` instead — the catch-all this replaced — converted such a rename
 *   into the whole fleet silently returning to one-step-at-a-time, which is the
 *   regression the bullet above exists to undo, which nothing failed on and a
 *   stopwatch found. `20260903010000_workflow_queue_run_kind_columns.sql` carries
 *   the measurement and why `kind` is not a generated column.
 *
 * - **`run_id` is a column too, and is required POSITIVELY.** It is
 *   `generated always as (payload ->> 'runId') stored`, so the envelope stays the
 *   single source of truth and the two in-flight guards compare with `=` rather
 *   than the `is not distinct from` a nullable jsonb extraction forced. A row
 *   whose payload carries no `runId` is therefore excluded rather than grouped
 *   with every other such row: `parseEnvelope` would refuse it on delivery
 *   anyway, so the alternative was five sandbox boots and then abandonment.
 * - **Disjoint under concurrency, WITHOUT `for update`.** Postgres refuses
 *   `FOR UPDATE … DISTINCT` outright (`FOR UPDATE is not allowed with DISTINCT
 *   clause`), so the claim is the UPDATE itself: the trailing unclaimed
 *   predicate is re-evaluated under the row lock the UPDATE takes, so a second
 *   sweep blocked on the first re-checks after it commits, fails the predicate,
 *   and simply does not appear in its own `returning`. Two sweeps therefore take
 *   disjoint sets with no explicit locking at all.
 * - **A stale claim is reclaimable** ({@link QUEUE_CLAIM_STALE_MS}), or a replica
 *   that died mid-delivery holds its messages forever — the due index excludes
 *   claimed rows, so nothing else would ever look at them.
 * - **Scoped by tenant AND run.** Run ids are ULIDs and collision is not the
 *   worry; sharing the key across tenants would be, because one tenant's traffic
 *   would then gate another's.
 * - **OLDEST-DUE wins, which is why this is two CTEs rather than one.**
 *   `distinct on` obliges an `order by` that STARTS with its own expressions, so
 *   the single-CTE version truncated to `limit` in `(slug, runId)` order — i.e.
 *   lexicographically by tenant. A tenant whose slug sorts early with more due
 *   runs than one tick's width filled the candidate set every tick, and since
 *   claimed rows are excluded by the `not exists` the next tick simply took its
 *   NEXT batch: an `aaa-*` agent under steady load kept a `zzz-*` agent's
 *   messages unclaimed on that replica indefinitely. `due` therefore keeps the
 *   ordering `distinct on` requires and `candidates` re-orders the whole due set
 *   by `available_at` before the limit, so the width is spent on the work that
 *   has waited longest whoever owns it. `id` is the tiebreaker, so two rows due
 *   in the same microsecond claim in a stable order rather than an arbitrary one.
 */
/**
 * What one claim COSTS as the due set deepens, measured — and the rewrite that
 * fixes it, which is NOT applied because its price is a decision rather than a
 * measurement.
 *
 * The shape of the problem: {@link claimDue} re-orders the WHOLE due set before
 * its limit (deliberately — that ordering is the anti-starvation mechanism), so
 * cost grows with the backlog while throughput stays fixed at
 * `min(WORKFLOW_QUEUE_MAX_PER_TICK, free delivery slots)`. Database work per
 * message DELIVERED therefore grows linearly with how far behind the queue is.
 * Checked with `explain (analyze, buffers)` on PostgreSQL 16.13, one busy tenant
 * and 40 claims in flight, committed and vacuumed between runs:
 *
 * | due | claim | shared buffers | temp spilled |
 * | --- | --- | --- | --- |
 * | 1,000 | 2.7 ms | 171 | 0 |
 * | 5,000 | 12.6 ms | 370 | 0 |
 * | 20,000 | 49.4 ms | 1,087 | 0 |
 * | 60,000 | 167.7 ms | 2,989 | 3.2 MB |
 * | 180,000 | 475.5 ms | 8,721 | 13.3 MB |
 *
 * At the bottom row it sorts 179,960 rows to return 8 — 0.34 ms of database work
 * per message at 1,000 due against 59 ms at 180,000. Ticks OVERLAP by design
 * (`workflow-queue-scheduler.ts`), so on a busy replica that is near-continuous
 * rather than once a second, bounded only by how fast delivery slots free.
 *
 * ## The rewrite works, and it is three changes rather than one
 *
 * - **`distinct on (slug, run_id)` becomes a group-minimum ANTI-JOIN** — `not
 *   exists (… where (e.available_at, e.id) < (q.available_at, q.id))` selects the
 *   same row and can early-terminate where a sort cannot.
 * - **The `locked_at` OR is SPLIT into a `union all`** of its two disjoint
 *   branches, which is what lets the unclaimed branch be an ordered index scan on
 *   `workflow_queue_due_idx` — 33 index entries instead of 135,000 rows.
 * - **The outer limit is PUSHED INTO each arm.** Provably free: a row among the
 *   union's 8 oldest is among its own arm's 8 oldest. On its own it buys nothing
 *   (measured, inside the noise) — both arms still sort — so it pays off only
 *   beside the anti-join.
 *
 * It needs one new index, `(slug, run_id, kind, available_at, id)`, for the
 * probes to be seeks rather than scans of the busy tenant's backlog. It is
 * result-identical, verified two ways: the candidate set at limits
 * 1/2/3/8/16/32/64/200, and a 40-fixture randomised differential over colliding
 * groups, `available_at` ties, stale locks and in-flight claims.
 *
 * **One behaviour difference, and it is a refinement.** The current `order by
 * slug, run_id, available_at` carries no `id` tiebreak, so which of two same-run
 * messages due in the same instant gets claimed is PLAN-dependent; the anti-join
 * always takes the lower id. 22 of those 40 fixtures differed on exactly that,
 * and none differed once `available_at` was made unique. Same class of fix as
 * wrapping the UPDATE in a `claimed` CTE because `UPDATE … RETURNING` has no
 * defined row order.
 *
 * ## Why it is not applied: the price is paid in the HEALTHY state
 *
 * | due | current | rewritten |
 * | --- | --- | --- |
 * | 100 | 0.89 ms | 1.05 ms |
 * | 1,000 | 2.76 ms | 1.71 ms |
 * | 5,000 | 11.3 ms | 4.4 ms |
 * | 20,000 | 50.8 ms | 5.9 ms |
 * | 60,000 | 165.2 ms | 15.4 ms |
 * | 180,000 | 495.8 ms | 133.8 ms |
 *
 * The crossover is around 500 due messages, and the index costs **+22% on
 * enqueue, +35% on claim, +20% on ack** (20,000 of each) plus **30 MB on 180,000
 * rows** against a 34 MB table and 41 MB of existing indexes — it nearly doubles
 * this table's index footprint, permanently.
 *
 * So it is insurance against a backlog, bought with a standing tax on a queue
 * that is keeping up, which is where a healthy fleet lives.
 * `20260903010000_workflow_queue_run_kind_columns.sql` declined a new index here
 * from the other direction ("write-path cost for nothing"); this is the same
 * trade with a number attached to the "something". The numbers are recorded so
 * the decision is CHEAP, not so it is made.
 *
 * The step arm is the residual either way: its `row_number()` needs a full
 * partition sort, its budget predicate cannot become a join, and replacing it
 * with a bounded count probe measured SLOWER (1,500 ms) unless the due set is
 * also capped — and capping it is the one change that really would weaken the
 * anti-starvation ordering, so it is not on the table.
 */
export async function claimDue(
  sql: SqlExec,
  limit: number,
  staleMs = QUEUE_CLAIM_STALE_MS,
): Promise<QueuedMessage[]> {
  const rows = await sql(
    // The STALE CUTOFF is defined once, in a one-row `stale` CTE, and read back
    // as a scalar subquery at each of its four sites. It used to be
    // `($2 || ' milliseconds')::interval` spelled five times, which is four
    // chances for the arms to disagree about what "stale" means — and a string
    // concatenated into a cast, where a bad value is a runtime SQL error rather
    // than a bound parameter of a declared type.
    //
    // A scalar subquery rather than CROSS JOINING the CTE, and that is not a
    // style choice: an uncorrelated subquery is an InitPlan, evaluated once and
    // usable as an index condition, where a joined CTE column is opaque to the
    // planner and would cost the `available_at`/`locked_at` bounds their
    // indexes. `now()` is left inline because it is one stable function call
    // with nothing to drift.
    //
    // TWO due sets rather than one: folding the kind into a single window's
    // `partition by` would make it part of the sort key and cost each arm the
    // partial index that actually serves it. The union's alias is `due` and not
    // `both`: `BOTH` is a RESERVED word in Postgres (the `trim(both …)`
    // modifier), so a bare subquery alias of that name is a syntax error rather
    // than a style question. Nothing in the unit tier would have caught it — the
    // only tests that EXECUTE this SQL are `describeWithPg` ones, which skip
    // without a real database.
    //
    // The step arm's in-flight count is ONE aggregate over the claimed set,
    // joined in, rather than a correlated `select count(*)` per candidate row.
    // The correlated form was the single most expensive thing in this statement
    // — 72,160 executions and 700,320 buffer hits of a 758,467-buffer pass — and
    // the aggregate is bounded by what is actually in flight fleet-wide
    // (replicas x `WORKFLOW_QUEUE_DELIVER_CONCURRENCY`, tens of rows).
    //
    // Orchestration keeps `not exists` rather than joining the same aggregate,
    // and the split is by QUESTION rather than by cost: one arm asks whether any
    // of a run's messages is in flight, the other how many. A shared `in_flight`
    // CTE was written and MEASURED against this, in case an eagerly materialized
    // CTE cost the idle tick — it does not, and that expectation was wrong:
    // Postgres executes a CTE on the first CTE SCAN, so on an idle tick its body
    // reports `never executed` exactly as this hash join's inner side does
    // (0.63-0.95 ms and 624 buffers against 0.88-0.91 ms and 624, on the same
    // database with the index dropped; busy and backlog were inside the noise
    // both ways). So this is a readability choice with no performance claim
    // attached — do not "optimize" it into one shape or the other.
    //
    // The UPDATE is wrapped in a `claimed` CTE so the outer select can ORDER what
    // comes back, and that is a fix rather than a flourish: `UPDATE … RETURNING`
    // has no defined row order, so oldest-first was previously a property of the
    // PLAN. Splitting the due set in two changed the plan and with it the order,
    // which failed `a busy early-sorting tenant cannot starve a later one` on both
    // CI Postgres arms while passing locally — the shape of luck, not of a
    // guarantee. Stating it costs one column in the `returning` list and makes the
    // claim's fairness claim true of the RESULT and not just of the selection.
    `with stale as (
       select now() - $2::bigint * interval '1 millisecond' as before
     ),
     orchestration_due as (
       select distinct on (q.slug, q.run_id) q.id, q.available_at
       from aai_platform.workflow_queue q
       where q.available_at <= now()
         and q.kind = 'workflow'
         and q.run_id is not null
         and (q.locked_at is null or q.locked_at < (select before from stale))
         and not exists (
           select 1 from aai_platform.workflow_queue o
           where o.slug = q.slug
             and o.kind = 'workflow'
             and o.run_id = q.run_id
             and o.locked_at >= (select before from stale)
         )
       order by q.slug, q.run_id, q.available_at
     ),
     step_due as (
       select ranked.id, ranked.available_at
       from (
         select q.id, q.available_at, q.slug, q.run_id,
                row_number() over (
                  partition by q.slug, q.run_id
                  order by q.available_at, q.id
                ) as rn
         from aai_platform.workflow_queue q
         where q.available_at <= now()
           and q.kind = 'step'
           and q.run_id is not null
           and (q.locked_at is null or q.locked_at < (select before from stale))
       ) ranked
       left join (
         select o.slug, o.run_id, count(*) as n
         from aai_platform.workflow_queue o
         where o.kind = 'step'
           and o.locked_at >= (select before from stale)
         group by o.slug, o.run_id
       ) in_flight on in_flight.slug = ranked.slug and in_flight.run_id = ranked.run_id
       where ranked.rn <= greatest($3 - coalesce(in_flight.n, 0), 0)
     ),
     candidates as (
       select id from (
         select id, available_at from orchestration_due
         union all
         select id, available_at from step_due
       ) due order by available_at, id limit $1
     ),
     claimed as (
       update aai_platform.workflow_queue q
          set locked_at = now()
        where q.id in (select id from candidates)
          and (q.locked_at is null or q.locked_at < (select before from stale))
       returning q.id, q.slug, q.queue_name, q.payload, q.headers, q.deployment_id,
                 q.attempt, q.available_at
     )
     select id, slug, queue_name, payload, headers, deployment_id, attempt
     from claimed
     order by available_at, id`,
    // `staleMs` crosses as TEXT with an explicit `::bigint` in the statement,
    // rather than as a number the driver types for us: the cast is what makes
    // `$2 * interval '1 millisecond'` resolve to one operator instead of
    // depending on how postgres.js chose to declare the parameter.
    [limit, String(staleMs), WORKFLOW_QUEUE_STEPS_PER_RUN],
  );
  return rows.map((r) => ({
    id: String(r.id),
    slug: String(r.slug),
    queueName: String(r.queue_name),
    payload: r.payload,
    attempt: Number(r.attempt),
    ...omitUndefined({
      headers: (r.headers ?? undefined) as Record<string, string> | undefined,
      deploymentId: (r.deployment_id ?? undefined) as string | undefined,
    }),
  }));
}
