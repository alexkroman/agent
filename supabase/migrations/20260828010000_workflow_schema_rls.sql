-- Deny-all RLS over the DevKit's OWN schema.
--
-- `20260827000000_workflow_world.sql` moved the durable-run journal onto this
-- database and said so plainly: "the journal stays the DevKit's, in its own
-- `workflow` schema created by its own migration". That sentence is the gap this
-- migration closes. Every table the PLATFORM declares carries deny-all RLS by
-- rule, and the tables now holding the most sensitive cross-tenant data on the
-- instance carry none — because they are created out-of-band by
-- `@workflow/world-postgres`'s drizzle migrations, which issue no
-- `enable row level security` anywhere in the set.
--
-- Six tables, and every one of them is cross-tenant: `workflow_runs` (`input`,
-- `output`, `execution_context`, `error`), `workflow_steps` (per-step input and
-- output), `workflow_events` (the journal), `workflow_hooks` (a `token` column
-- with a global btree index on it — and a webhook token is an unauthenticated
-- execution credential for a parked run), `workflow_stream_chunks` (raw `bytea`),
-- and `workflow_waits`.
--
-- ── WHY THIS WAS INVISIBLE ──────────────────────────────────────────────────
--
-- Not one of the three mechanisms that enforce the rule could see it:
--
--   1. `platform-schema.test.ts` derived its table list from
--      `create table if not exists aai_platform.<name>` — so a `workflow.*` table
--      could never fail it. (Widened in the same change as this migration.)
--   2. `realtime-rls.scenario.test.ts` matches
--      `/^alter table aai_platform\.(\w+) enable row level security;/`.
--   3. Supabase's own splinter rule 0013 and its RLS-disabled alerts key on
--      `public`, which `supabase/README.md` already names as the reason this repo
--      enables RLS by hand.
--
-- So the rule was upheld everywhere it was checked and unenforced exactly where a
-- third-party schema landed. That asymmetry is the finding, more than the missing
-- lines themselves.
--
-- ── WHAT IT IS AND IS NOT ───────────────────────────────────────────────────
--
-- This is DEFENCE IN DEPTH, not a live leak, and it is worth being precise about
-- that: `workflow` is not in the project's exposed-schema list, no role holds a
-- grant on it, and Postgres grants no schema USAGE to `PUBLIC` by default — so
-- nothing reads these tables today except the platform's own owner connection.
-- The tenant boundary at the reachable surface is `workflow_run_owner`, checked on
-- the way in by `workflow-storage-handler.ts`, and it stays the boundary.
--
-- What this buys is the same thing `20260807000000_platform_rls.sql` bought for
-- `aai_platform`, in its own words: "the only thing between a browser and every
-- tenant's workspace is the ABSENCE of a grant". One `grant usage on schema
-- workflow to authenticated` while wiring a runs pane into the studio, or one
-- entry added to the exposed-schema list, and every row becomes readable through
-- the anon key that ships in the browser bundle. With RLS on and no policies, that
-- same mistake returns zero rows.
--
-- ── WHY A DO BLOCK ──────────────────────────────────────────────────────────
--
-- The tables are created by somebody else's migration, on their schedule. A fixed
-- list would go stale the first time `world-postgres` adds a table — which is the
-- failure this whole migration is about, reintroduced one version later. So it
-- enumerates `pg_tables` at apply time and is idempotent, and it is a no-op when
-- the schema is not present yet (the DevKit's migration may not have run).
--
-- ENABLE, never FORCE: the platform connects as the owner, and FORCE would apply
-- the (nonexistent) policies to it and lock the platform out of its own journal.
--
-- ORDERING NOTE for the operator runbook: this is applied by `supabase db push`,
-- which may run BEFORE `@workflow/world-postgres` has created the schema on a
-- fresh project. That is why it degrades to a no-op rather than failing — and why
-- `platform-schema.test.ts` additionally asserts the block is self-extending, so
-- re-applying it after the DevKit's migration covers whatever it created.

do $$
declare
  t record;
begin
  if to_regnamespace('workflow') is null then
    raise notice 'workflow schema not present — skipping RLS (re-apply after the DevKit migration)';
    return;
  end if;

  for t in
    select tablename from pg_tables where schemaname = 'workflow'
  loop
    execute format('alter table workflow.%I enable row level security', t.tablename);
  end loop;

  -- Belt and braces, and cheap: the schema should hold no grant for the browser
  -- roles in the first place. Revoking is idempotent and says the intent out loud
  -- where a future `grant` would have to argue with it.
  execute 'revoke all on schema workflow from public, anon, authenticated';
  execute 'revoke all on all tables in schema workflow from public, anon, authenticated';
end
$$;
