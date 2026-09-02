-- Give the platform a way to STOP repairing a run, and give retention a way to
-- keep up.
--
-- `20260901020000_workflow_reconcile_cost.sql` made the reconcile pass cheap and
-- gave it a per-run throttle. What neither it nor anything else gave it was an
-- END: `reconcileStalledRuns` re-enqueues a stalled run every `STALL_GRACE_MS`
-- for as long as the run is non-terminal, and three facts compose into a run that
-- is immortal.
--
--   (a) NOTHING on the platform side ever writes a terminal status. Only the
--       guest's engine calls `setStatus`. The queue sweep abandons a MESSAGE past
--       `QUEUE_MAX_ATTEMPTS` and its own warning defers to "the reconcile pass";
--       the reconcile pass writes another message.
--   (b) `reconcileStalledRuns` bounds WIDTH (`RECONCILE_MAX_PER_TICK`) and RATE
--       (`STALL_GRACE_MS`), and nothing bounds the COUNT. `reconciled_at` is
--       overwritten by each pass, so the row cannot say how many there have been.
--   (c) Retention collects TERMINAL runs only, so a run that never reaches one is
--       never collected — and it stays a resident of `workflow_runs_stalled_idx`,
--       the partial index whose whole value is holding only the live rows.
--
-- So a run whose guest can never complete it — a boot-time throw in the agent, a
-- workflow key deleted from the deployed bundle, a poison input — costs a sandbox
-- boot every ten minutes, forever, and the row that causes it is permanent.
--
-- ## `reconciles`, and why a COUNT rather than a second timestamp
--
-- The alternative was a `stalled_since` the pass sets once and clears when the
-- run recovers, and the clearing is the problem: recovery is observed by nobody.
-- A guest that resumes a run journals steps and enqueues its next message, and
-- neither touches this row. A count needs no such observation — the pass
-- increments it in the stamp it already writes (`markReconciled`, one `unnest`
-- statement however wide the pass), and `RECONCILE_MAX_ATTEMPTS` re-walks is the
-- budget. What the count deliberately does NOT do is decay: see
-- `workflow-queue-reconcile.ts`, which carries the argument for the number and
-- for what abandonment costs in a platform-wide outage.
--
-- `integer` and `not null default 0`, so every existing row starts with a full
-- budget — which is the right default for the same reason `reconciled_at`'s NULL
-- was: a backfill would either abandon a run on the strength of history nobody
-- recorded, or claim a repair that never happened.
--
-- `set local lock_timeout` for the reason the previous migration gives: the
-- `alter table` takes an ACCESS EXCLUSIVE lock, and on a busy platform database
-- this deploy step should FAIL and be retried rather than queue behind a long
-- transaction while every write to the journal queues behind IT.
set local lock_timeout = '5s';

alter table aai_platform.workflow_runs add column if not exists reconciles integer not null default 0;

-- ── The retention scan's own index ───────────────────────────────────────────
--
-- `sweep_terminal_workflow_runs` reads `where status in ('completed', 'failed',
-- 'cancelled') and created_at < cutoff order by created_at limit batch`, and
-- until now no index served it: `workflow_runs_listing_idx` leads with `slug`,
-- and `workflow_runs_stalled_idx` is partial on the two LIVE statuses, i.e. the
-- exact complement of this predicate. So the daily sweep was a sequential scan
-- plus a sort of the whole table — affordable at one run a day and not at the
-- frequency the loop below needs.
--
-- Partial on the three terminal statuses, which on a healthy fleet is MOST of the
-- table, so this is close to a plain index on `created_at`. It is written as the
-- partial anyway because that is what makes a no-op run an index probe rather
-- than a scan of live rows it can never select — and because the predicate is
-- then matched literally, the same implication rule the stalled index depends on.
create index if not exists workflow_runs_terminal_idx
  on aai_platform.workflow_runs (created_at)
  where status in ('completed', 'failed', 'cancelled');

-- ── Retention: keep up, in bounded batches ──────────────────────────────────
--
-- One batch of `batch` rows per CALL, daily, was a hard ceiling of 5,000 run
-- deletions a day. Measured platform workflow throughput is ~24 runs/second, so
-- anything above ~0.06 runs/second sustained meant the table grew net-positive
-- forever — and the growth landed on the index the reconcile pass reads at >= 1 Hz
-- per replica, which is the cost `20260901020000` exists to have removed.
--
-- It LOOPS now, until a batch comes back short (caught up) or `max_total` rows
-- have gone. The cap is what keeps ONE call bounded: the whole function is one
-- transaction, so an unbounded loop would hold a transaction open across a table's
-- worth of deletes, blocking vacuum on five tables and taking every one of those
-- row locks with it. Ten batches is a few seconds of work; `pg-cron.ts` moves the
-- schedule to HOURLY, which is what turns the cap into 1.2M runs a day of
-- capacity rather than 50,000.
--
-- **The SIGNATURE is unchanged, deliberately.** `create or replace function`
-- cannot alter a function's identity, so adding a `max_total` parameter WITH a
-- default would create a second overload and `sweep_terminal_workflow_runs()` —
-- what the cron command calls — would then be ambiguous (`function ... is not
-- unique`), which no test in this repo would catch because nothing calls it with
-- zero arguments until pg_cron does, in production, hourly, into a log. So the cap
-- is a local. A future parameter needs a `drop function` first.
create or replace function aai_platform.sweep_terminal_workflow_runs(
  retain_ms bigint default 30::bigint * 24 * 60 * 60 * 1000,
  batch integer default 5000
) returns integer
language plpgsql
set search_path = ''
as $fn$
declare
  cutoff bigint := (extract(epoch from now()) * 1000)::bigint - retain_ms;
  -- Ten batches at the default. A call that hits this leaves the rest for the
  -- next one rather than growing its own transaction.
  max_total integer := 10 * batch;
  removed integer := 0;
  removed_batch integer;
begin
  loop
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
    select count(*)::integer into removed_batch from gone_runs;

    removed := removed + removed_batch;
    -- A short batch means the predicate is exhausted. `skip locked` can also
    -- shorten one, and stopping there is right: the rows somebody else holds are
    -- the next call's, not this transaction's to wait for.
    exit when removed_batch < batch;
    exit when removed >= max_total;
  end loop;
  raise notice 'aai-sweep-workflow-runs: removed % terminal run(s)', removed;
  return removed;
end
$fn$;
