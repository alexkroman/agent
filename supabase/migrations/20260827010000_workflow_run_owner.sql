-- Which agent owns a durable run.
--
-- The DevKit's own schema (`workflow.*`, created by `@workflow/world-postgres`'s
-- migration) has NO tenant column: it is written for one application per
-- database, and its SQL is schema-qualified, so neither a per-agent schema nor a
-- `search_path` trick can separate tenants inside it.
--
-- Running that world on the PLATFORM's database rather than in each guest is what
-- gives back the per-guest connection cost — a shared pool instead of six
-- connections per workflow agent — and this table is what makes it safe. Every
-- tenant-facing storage call is scoped through it: a slug's runs are the run ids
-- recorded here, and nothing else is reachable. Run ids are ULIDs, so the
-- unscoped surface is not guessable either; this is what makes the boundary
-- ENFORCED rather than merely obscure.
--
-- `on delete cascade` drops the ownership row with the agent. The DevKit's own
-- rows in `workflow.*` outlive it, which is a known leak rather than an
-- oversight: reaping them needs a delete that walks their five tables in
-- dependency order, and it belongs with the rest of the tenant-database
-- teardown. Until then the rows are unreachable, not visible to anyone.
create table if not exists aai_platform.workflow_run_owner (
  run_id text primary key,
  slug text not null references aai_platform.agents (slug) on delete cascade,
  created_at timestamptz not null default now()
);

-- The scoping read: "which runs are this agent's", newest first.
create index if not exists workflow_run_owner_slug_idx
  on aai_platform.workflow_run_owner (slug, created_at desc);

-- Same posture as every other `aai_platform` table: RLS on, no policies, so the
-- anon and authenticated roles reach nothing and the service role bypasses it.
alter table aai_platform.workflow_run_owner enable row level security;
