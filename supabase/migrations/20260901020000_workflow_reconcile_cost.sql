-- Make the reconcile pass cheap, and give it a per-run throttle to be cheap ABOUT.
--
-- `findStalledRuns` (`aai-server/workflow-queue-reconcile.ts`) is the query the
-- queue sweep runs on the branch whose entire point is to be free: the tick that
-- claimed nothing. `20260828040000_workflow_queue_run_index.sql` measured that
-- idle tick at **0.201 ms** — the figure is that migration's, for the single-CTE
-- claim of the day; the split claim measured 1.674-1.983 ms and
-- `20260903010000_workflow_queue_run_kind_columns.sql` took it to 0.930-1.024 ms —
-- and `workflow-queue-sweep.ts` promises an idle fleet "pays close to nothing for
-- the frequency". This migration is what keeps that true now that a second
-- statement rides the same reservation.
--
-- Three things compound, and none of them is bounded by anything the server sets:
--
--   (a) There is NO leader election on this path — `workflow-queue-sweep.ts`'s
--       module doc says so outright ("NO LEADER LOCK"), because `claimDue` is
--       lock-free by design. So EVERY replica reconciles on EVERY idle tick, at
--       `WORKFLOW_QUEUE_INTERVAL_MS` — one second by default, i.e. >= 1 Hz per
--       replica, on the RESERVED admin connection out of an `ADMIN_POOL_MAX` of
--       16, which every platform read the replica makes shares.
--   (b) Nothing indexed it. `workflow_runs` carried one index,
--       `workflow_runs_listing_idx (slug, workflow, created_at desc, run_id desc)`,
--       which is for `listRuns` and is useless to a fleet-wide scan with no slug —
--       so the outer query was a sequential scan plus a sort. The `not exists`
--       anti-join is on `(slug, queue_name)`, which none of `workflow_queue`'s
--       indexes lead with either (`due`, `claimed`, and — until
--       `20260903010000_workflow_queue_run_kind_columns.sql` dropped it —
--       `run_idx (slug, (payload->>'runId'), available_at)`).
--   (c) Nothing ever DELETED a terminal run. No pg_cron job touched
--       `workflow_runs`, and `platform-workflow-journal.ts`'s `setStatus` says as
--       much in its own comment — "nothing here sweeps them the way
--       `forgetOldTerminalRuns` does in memory". So (b)'s scan grew forever, and
--       the rows it grew by are exactly the ones the predicate can never select.
--
-- ── The `reconciled_at` column, and why a WINDOW was not already a throttle ──
--
-- `STALL_GRACE_MS` is justified in prose as a LAST-ACTIVITY window — "a run that
-- went `running` a second ago is being walked right now" — and the sweep's
-- operator-facing warning tells the reader a dropped message is re-enqueued "once
-- they have been idle for 10 minutes". Neither was true: the predicate compared
-- `created_at`, which is fixed at creation, so ten minutes after a run STARTED it
-- was eligible on every pass forever, with no per-run throttle and no backoff.
--
-- That defeats `QUEUE_MAX_ATTEMPTS`, whose whole justification is that "every
-- attempt boots a sandbox": a run whose guest cannot be reached burns its five
-- attempts in ~380 s, gets dropped, and is re-enqueued on the very next tick.
--
-- `reconciled_at` is the missing half — epoch milliseconds of the last time the
-- platform re-enqueued this run AS STALLED, written by `markReconciled` in the
-- same pass that wrote the message. The predicate then reads ONE window off
-- `greatest(created_at, reconciled_at)` in effect, which is what makes the code
-- and the operator message say the same thing: idle for ten minutes, and at most
-- one re-walk per ten minutes after that.
--
-- It is `bigint` for the reason every other timestamp on these tables is (see
-- `20260901000000_platform_workflow_journal.sql`): the engine's clock decides,
-- not the database's. NULL means "never reconciled", which is every existing row
-- and is the right default — a backfill would either hide a genuinely stalled run
-- for a window or claim an activity that never happened.
--
-- `set local lock_timeout` because the `alter table` takes an ACCESS EXCLUSIVE
-- lock and the index builds take a SHARE lock: on a busy platform database this
-- deploy step should FAIL and be retried rather than queue behind a long
-- transaction while every write to the journal queues behind it.
set local lock_timeout = '5s';

alter table aai_platform.workflow_runs add column if not exists reconciled_at bigint;

-- ── The outer scan ───────────────────────────────────────────────────────────
--
-- PARTIAL on the two live statuses, which is the whole win: the rows this index
-- must contain are the unfinished ones, and on a healthy fleet that is a tiny
-- fraction of the table — a terminal run costs nothing here even before the
-- retention sweep below reaches it. `created_at` leads (and is the only key)
-- because the query has no slug to lead with and ends `order by r.created_at
-- limit $3`, so this serves the filter, the ordering and the bound in one walk.
--
-- The status list is written out rather than `not in ('completed', …)` so the
-- predicate in `findStalledRuns` matches it literally — a partial index is
-- matched by predicate implication, and nothing warns when a rewritten query
-- stops implying one. Same trap the run index's expression has.
--
-- `reconciled_at` is deliberately NOT in the key. It is a second range on the
-- same rows, which a btree cannot use past the first inequality anyway, and
-- including it would only widen every entry.
create index if not exists workflow_runs_stalled_idx
  on aai_platform.workflow_runs (created_at)
  where status in ('pending', 'running');

-- ── The anti-join ────────────────────────────────────────────────────────────
--
-- `not exists (select 1 from workflow_queue q where q.slug = r.slug and
-- q.queue_name = '__wkf_workflow_' || r.run_id)`, once per candidate row. The
-- queue is expected to be EMPTY for almost every run, which is what makes the
-- anti-join the right shape — and also what made the missing index invisible in
-- review: an empty result is fast to RETURN and, unindexed, expensive to reach.
--
-- Not partial: a queue row's whole lifetime is relevant here. A PARKED message
-- (`available_at` in the future, which is how `sleep()` is dispatched) and a
-- CLAIMED one both mean "something is scheduled to touch this run", so a
-- predicate on either column would re-open the double-delivery this check exists
-- to prevent.
create index if not exists workflow_queue_run_topic_idx
  on aai_platform.workflow_queue (slug, queue_name);

-- ── The PARK check ───────────────────────────────────────────────────────────
--
-- `not exists (select 1 from workflow_hooks h where h.slug = r.slug and
-- h.run_id = r.run_id and not h.delivered and not h.closed)` — the arm that
-- stops the human-approval workflow being mistaken for an abandoned one.
--
-- Partial on the OPEN windows, which is what makes it a rounding error: a hook
-- row is kept after it is answered or closed (deliberately — a late delivery
-- must answer "closed" rather than "never existed"), so the table accumulates
-- every window an agent has ever opened while this index holds only the handful
-- outstanding right now.
--
-- It is not redundant with the primary key. `(slug, run_id, key)` does lead with
-- the right columns, but so does `workflow_hooks_token_idx (slug, token)`, and on
-- a cold table the planner picks that one and scans every hook the SLUG has ever
-- held — verified with `explain` on this predicate. An index whose rows are only
-- the open windows cannot degenerate that way.
create index if not exists workflow_hooks_open_idx
  on aai_platform.workflow_hooks (slug, run_id)
  where delivered = false and closed = false;

-- The elapsed-deadline check that qualifies it needs nothing new:
-- `workflow_sleeps_due_idx (wake_at) where woken = false` already exists for the
-- wake scan and is exactly this predicate.

-- ── Retention: a terminal run is not kept forever ───────────────────────────
--
-- Deletes the journal of runs that finished long ago, oldest first, in bounded
-- batches. Children go in the SAME statement as the run: `workflow_steps`,
-- `workflow_attempts`, `workflow_sleeps` and `workflow_hooks` reference
-- `agents`, not `workflow_runs`, so there is no cascade to lean on, and a
-- two-statement version interrupted between them would strand rows no
-- `(slug, run_id)` query ever names again.
--
-- **Retention is measured from the run's START**, because `created_at` is the
-- only timestamp the row carries. A run that ran for longer than the window is
-- therefore collected sooner after finishing than a short one. Giving a run a
-- `finished_at` is the change that fixes that properly, and it belongs with the
-- journal store rather than with an index migration; at a 30-day window a
-- workflow run that spans a month is already the exception.
--
-- `for update skip locked` so two runs of the job, or a run overlapping a
-- delete-cascade from an agent deletion, cannot block on each other — the sweep
-- has nothing to say about a row somebody else already holds.
create or replace function aai_platform.sweep_terminal_workflow_runs(
  retain_ms bigint default 30::bigint * 24 * 60 * 60 * 1000,
  batch integer default 5000
) returns integer
language plpgsql
set search_path = ''
as $fn$
declare
  cutoff bigint := (extract(epoch from now()) * 1000)::bigint - retain_ms;
  removed integer;
begin
  with doomed as (
    select r.slug, r.run_id
      from aai_platform.workflow_runs r
     where r.status in ('completed', 'failed', 'cancelled')
       and r.created_at < cutoff
     order by r.created_at
     limit batch
     for update skip locked
  ),
  gone_steps as (
    delete from aai_platform.workflow_steps s
     using doomed d where s.slug = d.slug and s.run_id = d.run_id
  ),
  gone_attempts as (
    delete from aai_platform.workflow_attempts a
     using doomed d where a.slug = d.slug and a.run_id = d.run_id
  ),
  gone_sleeps as (
    delete from aai_platform.workflow_sleeps sl
     using doomed d where sl.slug = d.slug and sl.run_id = d.run_id
  ),
  gone_hooks as (
    delete from aai_platform.workflow_hooks h
     using doomed d where h.slug = d.slug and h.run_id = d.run_id
  ),
  gone_runs as (
    delete from aai_platform.workflow_runs r
     using doomed d where r.slug = d.slug and r.run_id = d.run_id
     returning 1
  )
  select count(*)::integer into removed from gone_runs;
  raise notice 'aai-sweep-workflow-runs: removed % terminal run(s)', removed;
  return removed;
end
$fn$;

-- **The SCHEDULING is not here** — it is a job in `platformCronJobs()`
-- (`aai-server/pg-cron.ts`), like every other sweep in this repo. Two reasons, and
-- the first is a hard constraint rather than a preference:
--
--   * pg_cron is SINGLE-DATABASE, pinned to `cron.database_name`, so it cannot
--     exist in the throwaway database `platform-schema.scenario.test.ts` and
--     `pg-cron.scenario.test.ts` build by applying this migration set — which is
--     why `platformMigrationSql()` strips `create extension if not exists pg_cron`
--     outright. A `select cron.schedule(...)` at the top level of a migration
--     therefore fails both of those suites in `beforeAll` with
--     `schema "cron" does not exist`, on a path a local Supabase stack never
--     exercises because it HAS pg_cron. Verified both ways.
--   * Boot DIFFS: `schedulePlatformSweeps` unschedules every `aai-sweep-*` job in
--     `cron.job` that `platformCronJobs()` does not declare, which is what makes
--     that list "the whole truth about what the platform runs" and what retires a
--     job with no migration to write. A job scheduled from here would either be
--     inside that prefix and deleted by the next container to boot, or outside it
--     and permanently exempt from the diff. Declaring it there is the only
--     spelling with neither problem.
--
-- A plain SQL function needs no extension, so THIS half belongs in a migration:
-- the schema owns the body, `pg-cron.ts` owns when it runs.
