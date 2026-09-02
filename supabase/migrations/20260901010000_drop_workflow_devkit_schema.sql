-- Retire the Workflow DevKit's two schemas by RENAMING them. Nothing is dropped
-- here: this file is the EXPAND half, and the `drop` it is named for is owed to
-- a LATER release.
--
-- The replay engine's journal is `aai_platform.workflow_*`
-- (`20260901000000_platform_workflow_journal.sql`), and no code in this
-- repository reads or writes `workflow.*` any more — the package that created
-- it, `@workflow/world-postgres`, is declared by nothing. So these schemas are
-- dead weight. They are not, however, empty.
--
-- ## Why a RENAME, when the first draft of this file dropped them
--
-- That draft argued the standing expand/contract rule did not apply here. The
-- rule is that a contract migration cannot ride the same release as the code
-- that stops using it: `supabase db push` runs BEFORE the deploy and old
-- containers keep serving through the rollout, so a drop beside its own expand
-- fails every request that reaches one. The draft's answer was that an old
-- container's durable runs are ALREADY broken by the release this rides with —
-- its guests hold a DevKit world the platform no longer serves
-- `/:slug/workflow-storage` for, so every one of their runs fails at its first
-- journal write whether or not this schema exists.
--
-- That is a true statement about AVAILABILITY and it says nothing about the
-- DATA. `drop schema workflow cascade` destroys every in-flight run's journal
-- at the START of the push→deploy window, before one new container is up, and
-- it is not recoverable: if the release is rolled back — for this reason or any
-- other — there is nothing left to roll back TO. A rename costs nothing, keeps
-- every row, and makes the recovery two statements:
--
--     alter schema workflow_retired rename to workflow;
--     alter schema workflow_drizzle_retired rename to workflow_drizzle;
--
-- A rename is still VISIBLE to an old container — `workflow.workflow_runs`
-- stops resolving the moment it lands — and that is the point rather than a
-- caveat: it fails exactly the runs the release was going to fail anyway, and
-- it fails them REVERSIBLY.
--
-- ## `aai_platform.workflow_run_owner` is deliberately left ALONE
--
-- The run→slug mapping. The DevKit's schema had no tenant column, so every
-- storage call was scoped through this table; the engine's journal carries the
-- slug in every primary key, so tenancy is in the key and there is nothing left
-- to map. It is a table this repo DECLARES
-- (`20260827010000_workflow_run_owner.sql`), under deny-all RLS, written by
-- nothing — the textbook expand half — and dropping it here would strand the
-- rollback above: the schema would come back with no way left to say whose runs
-- those are. It goes in the same contract migration as the two schemas.
--
-- All three — `workflow_retired`, `workflow_drizzle_retired`, and the ownership
-- table — are carried by the retired-object ledger in
-- `packages/aai-server/platform-schema.test.ts`, which fails until each entry's
-- `drop` lands and the entry is deleted, because an owed thing recorded only in
-- prose is an owed thing forgotten; that is how `agents.config` reached the
-- retired-COLUMN ledger beside it in the first place.
--
-- ## Re-applying the whole set resurrects an EMPTY pair, and skipping is right
--
-- `20260828033426_workflow_devkit_schema.sql` gates its vendored DDL on
-- `select max(created_at) from workflow_drizzle.workflow_migrations`, and entry
-- 0000 opens with a bare `CREATE SCHEMA "workflow"`. Once the bookkeeping moves
-- to `workflow_drizzle_retired`, a SECOND apply of that file reads null, re-runs
-- everything, and leaves an empty `workflow` + `workflow_drizzle` beside the
-- retired pair. The rename below therefore skips when its target name is taken,
-- and says so, rather than erroring `42P06`.
--
-- Leaving the resurrected pair is deliberate. Removing it means a
-- `drop schema … cascade` on a schema this migration cannot PROVE is the empty
-- one — which is the statement the whole file exists not to run — and it costs
-- nothing: `supabase db push` applies a version once, so only a harness that
-- concatenates every file and replays it reaches this state, and
-- `platform-schema.scenario.test.ts` is that harness. Both of these were found
-- by reproducing what it does against a real Postgres — the earlier
-- `drop … cascade` was accidentally immune only because it took the bookkeeping
-- down with it, so the guard read null and the whole set was rebuilt from
-- scratch on each pass.
--
-- ## What `workflow_retired` holds, and in what state
--
-- Six cross-tenant tables: `workflow_runs` (`input`, `output`,
-- `execution_context`, `error`), `workflow_steps`, `workflow_events`,
-- `workflow_hooks`, `workflow_stream_chunks`, `workflow_waits`. Created
-- out-of-band by drizzle migrations that issue no RLS of their own, which is why
-- `20260828010000_workflow_schema_rls.sql` had to add deny-all over them. That
-- RLS and those revoked grants are per-TABLE and survive a schema rename —
-- verified on the local stack: after the rename the tables still report
-- `relrowsecurity` with zero policies and `anon` still holds no USAGE — so the
-- posture is unchanged. That migration's own `do` block simply becomes a no-op,
-- which is what its `to_regnamespace('workflow') is null` guard is for.
--
-- The create migration's note about a leak — "the DevKit's own rows in
-- `workflow.*` outlive [an agent], which is a known leak rather than an
-- oversight: reaping them needs a delete that walks their five tables in
-- dependency order" — is closed by the contract release, not by this one.
--
-- ## `lock_timeout`, and why it is INSIDE the `do` block
--
-- `alter schema … rename` takes ACCESS EXCLUSIVE on the namespace. It does not
-- lock the contained tables the way `drop schema … cascade` would — that one
-- takes ACCESS EXCLUSIVE on every one of them, so queued behind a single
-- idle-in-transaction session it blocks everything that arrives after it. Even
-- for the rename, though, a migration that WAITS is a migration holding a deploy
-- behind it, and against a live database the honest failure is a fast one: a
-- `db push` that fails on `55P03 lock_not_available` is re-runnable, this block
-- being idempotent, where a statement parked behind a stuck lock is not.
--
-- `set local`, and inside the block rather than above it, because whether a
-- migration file is wrapped in a transaction belongs to the runner rather than
-- to us and this has to hold either way. Measured on the local stack (PG 17):
-- a top-level `SET LOCAL` under autocommit raises `WARNING: SET LOCAL can only
-- be used in transaction blocks` and does NOTHING — protection that is silently
-- absent on half the ways this file can be applied. The same statement inside a
-- `do` block takes effect in both cases (the block gets an implicit transaction
-- when there is no explicit one) and reverts with it, so there is no `reset` to
-- forget and nothing left on the connection for the next migration.
do $$
begin
  set local lock_timeout = '3s';

  if to_regnamespace('workflow') is null then
    raise notice 'workflow schema not present — nothing to retire';
  elsif to_regnamespace('workflow_retired') is not null then
    raise notice 'workflow_retired already exists — leaving workflow in place';
  else
    alter schema workflow rename to workflow_retired;
  end if;

  if to_regnamespace('workflow_drizzle') is null then
    raise notice 'workflow_drizzle not present — nothing to retire';
  elsif to_regnamespace('workflow_drizzle_retired') is not null then
    raise notice 'workflow_drizzle_retired already exists — leaving workflow_drizzle in place';
  else
    alter schema workflow_drizzle rename to workflow_drizzle_retired;
  end if;
end
$$;
