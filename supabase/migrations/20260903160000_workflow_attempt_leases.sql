-- An attempt CHARGE becomes a LEASE: one row per outstanding attempt, and it
-- EXPIRES.
--
-- `aai_platform.workflow_attempts` held a scalar `n` keyed `(slug, run_id,
-- key)`, incremented before a step's body runs and decremented when the attempt
-- ended in a durable wait. The number was right and the charge a DEAD walk left
-- was indistinguishable from a live one, so it stood forever: `maxAttempts`
-- deaths on one step key refused that step permanently, and
-- `StepAbandonedError` reported a run nobody could revive. The engine's own
-- module said so — "a charge cannot tell an abandoned attempt from a LIVE one …
-- which needs a heartbeat to close".
--
-- Expiring individual charges needs a timestamp PER charge, which needs a row
-- per charge, which needs the holder in the primary key. So the key changes, and
-- that is why this is a new table rather than an `alter`: the runtime's own copy
-- of this schema is applied by a boot-time `create table if not exists`
-- (`workflow-journal-schema.ts`), which cannot change a primary key idempotently
-- and must not delete rows on every boot. The two schemas are held in step by
-- `journal-ddl-parity.test.ts`, which pairs them by NAME and asserts a
-- bijection, so both sides rename together or neither does.
--
-- Outstanding charges are LOST at the changeover. That is the safe direction and
-- the one the interface already documents: under-charging a budget the next
-- claim re-takes is recoverable, where over-charging refuses a healthy step.
create table if not exists aai_platform.workflow_attempt_leases (
  slug text not null references aai_platform.agents (slug) on delete cascade,
  run_id text not null,
  key text not null,
  -- WHO holds a charge, and since when: holder to the instant it claimed.
  --
  -- A map on ONE row rather than a row per holder, and that is the atomicity
  -- rather than a storage preference. Two concurrent claims collide on this row,
  -- so the second blocks on its lock and re-evaluates against the first's
  -- committed value — which is what the scalar `n` had. A row per holder
  -- conflicts on nothing: each claim inserts its own and counts under a snapshot
  -- the other's insert is absent from, so both answer 1 and a step's ceiling
  -- bounds nothing. Measured on a real Postgres at `[1, 1, 3]` for three
  -- concurrent claims, against a contract that no two ever agree.
  --
  -- Instants are milliseconds since the epoch as TEXT, like every other instant
  -- in this schema (`finished_at`, `wake_at`) and deliberately not a
  -- `timestamptz`: the engine compares them against its OWN clock, so a type
  -- that made the database the clock would put the two on different ones.
  --
  -- A charge's instant is set by the CLAIM and never refreshed by a live holder
  -- — see `_workflow-journal-attempts.ts`, which argues why a refresh would let
  -- a walk that keeps re-reaching one key hold its charge indefinitely.
  holders jsonb not null default '{}'::jsonb,
  primary key (slug, run_id, key)
);

-- Same posture as every other `aai_platform` table: RLS on with no policies, so
-- the anon and authenticated roles reach nothing and the service role bypasses
-- it.
alter table aai_platform.workflow_attempt_leases enable row level security;

-- The old table goes. Its rows are transient charges with no meaning once a step
-- settles, so there is nothing to migrate — and leaving it would break
-- `journal-ddl-parity.test.ts`'s bijection, which is the gate that keeps the two
-- copies of this schema one schema.
--
-- Ordered AFTER the function below in intent but BEFORE it in fact, which is
-- safe: `create or replace function` does not resolve table names at definition
-- time, so the replacement below can name a table this statement just dropped
-- and vice versa. What is NOT safe is leaving the old name inside the function,
-- which is why the whole body is re-issued.
drop table if exists aai_platform.workflow_attempts;

-- The terminal-run sweep, re-issued to clean the new table.
--
-- **The SIGNATURE and the BODY are otherwise unchanged**, deliberately — the
-- only edit is `workflow_attempts` to `workflow_attempt_leases` in
-- `gone_attempts`. `20260902120000_workflow_run_abandonment.sql` is the version
-- this replaces and carries the argument for every other line of it; a diff
-- between the two should show one table name.
--
-- It has to be re-issued rather than left alone: a function body naming a table
-- that no longer exists fails at RUN time, and this one runs from pg_cron with
-- nobody watching. Without it the new table would also leak a row per
-- outstanding charge for every run the sweep retires.
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
      delete from aai_platform.workflow_attempt_leases a
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
