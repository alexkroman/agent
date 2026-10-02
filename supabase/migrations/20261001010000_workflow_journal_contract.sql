-- The CONTRACT half of two expands: `workflow_steps.started_at` becomes NOT
-- NULL, and the retired `workflow_attempts` table goes.
--
-- ── `started_at` ──
--
-- `20260902130000_workflow_step_started_at.sql` added the column nullable,
-- because steps already journaled had no start. Every write has set it since,
-- and `StepEntry.startedAt` is now required, so a reader no longer has an
-- "unknown" to render. The rows that predate the column are backfilled with
-- their own `finished_at`: a zero-duration step, which is the one value that
-- invents no cost. The runtime's own DDL (`aai-runtime`'s
-- `workflow/journal/schema.ts`) declares `started_at bigint not null` to match,
-- and `journal-ddl-parity.test.ts` holds the two to one definition.
--
-- ── `workflow_attempts` ──
--
-- `20260903160000_workflow_attempt_leases.sql` replaced it with
-- `workflow_attempt_leases` and kept the old table, and a `gone_attempts` arm in
-- the sweep, for the length of the rollout: "The `gone_attempts` arm goes with
-- the retired table in the contract release." This is that release. The sweep
-- is redefined FIRST, since a plpgsql body naming a dropped table fails at its
-- next call rather than at the drop.

update aai_platform.workflow_steps
   set started_at = finished_at
 where started_at is null;

alter table aai_platform.workflow_steps
  alter column started_at set not null;

-- `20260903160000_workflow_attempt_leases.sql` is the version this replaces and
-- carries the argument for every line of it; a diff between the two should show
-- one removed block.
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
    gone_leases as (
      delete from aai_platform.workflow_attempt_leases l
       using doomed d where l.slug = d.slug and l.run_id = d.run_id
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

drop table if exists aai_platform.workflow_attempts;
