-- The replay engine's journal, owned by the platform.
--
-- A durable run's whole claim is that it outlives the process running it. The
-- engine has two journal backends and a deployed guest can reach NEITHER: the
-- Postgres one needs a `DATABASE_URL`, and the platform provisions no tenant
-- database, so every deployed run fell back to a `Map` in a sandbox that
-- self-exits after `AGENT_IDLE_EXIT_MS`. A step's result, its attempt count and
-- an open approval window all died with it, and nothing said so — the run simply
-- never resumed.
--
-- These tables are that third backend, reached over `POST /:slug/workflow-journal`
-- with the per-sandbox bearer, exactly as session state and the queue are.
--
-- ## Tenancy is a COLUMN, which is what the self-hosted schema could not have
--
-- `aai_workflow_*` (aai-runtime/workflow-journal-schema.ts) has no slug: there the
-- database IS the agent, so a column would be a constant. Here one database serves
-- every agent, so the slug is part of every primary key and every statement, and a
-- guessed run id reaches nothing. Same design as `session_slots` beside it, and the
-- reason `workflow_run_owner` is a mapping table is that the DevKit's fixed schema
-- could not do this.
--
-- ## Why the shapes differ from the self-hosted ones in exactly two ways
--
-- Everything else mirrors `workflow-journal-schema.ts`, deliberately, so the two
-- stores are the same contract and a scenario test over one is evidence about the
-- other. The two differences are both tenancy:
--
-- - the leading `slug` column, cascading from `agents`, so deleting an agent takes
--   its runs with it rather than leaving rows no slug can reach;
-- - `workflow_hooks` carries a UNIQUE `(slug, token)` rather than a bare unique
--   `token`. A token is what a third party dials, and the URL it dials carries the
--   slug (`/:slug/.well-known/workflow/v1/webhook/:token`), so delivery is already
--   slug-scoped. Making the token globally unique instead would mean one agent
--   minting a token that collides with another's — a cross-tenant failure with no
--   symptom on either side.
--
-- ## `created_at`/`finished_at`/`wake_at` are `bigint`, not `timestamptz`
--
-- They are epoch milliseconds the ENGINE assigns, and the engine compares them
-- against its own clock to decide whether a sleep is due. A `timestamptz` would
-- hand that decision to the database's clock and to the driver's parsing, which is
-- a second source of truth for the one value replay determinism rests on.
-- `bigint` rather than `integer` because a 32-bit column overflows in 1970 + 24
-- days of milliseconds.
create table if not exists aai_platform.workflow_runs (
  slug text not null references aai_platform.agents (slug) on delete cascade,
  run_id text not null,
  workflow text not null,
  status text not null,
  created_at bigint not null,
  input jsonb,
  output jsonb,
  error text,
  primary key (slug, run_id)
);

-- What `listRuns(workflow, limit)` reads: newest first, one workflow at a time.
create index if not exists workflow_runs_listing_idx
  on aai_platform.workflow_runs (slug, workflow, created_at desc, run_id desc);

create table if not exists aai_platform.workflow_steps (
  slug text not null references aai_platform.agents (slug) on delete cascade,
  run_id text not null,
  key text not null,
  name text not null,
  status text not null,
  output jsonb,
  error text,
  attempts integer not null,
  finished_at bigint not null,
  primary key (slug, run_id, key)
);

-- The attempt counter, incremented in ONE statement so two concurrent deliveries
-- cannot read the same number and take a step past its ceiling. Its own table
-- rather than a column on `workflow_steps` because it is claimed BEFORE the step
-- runs — a step with no row yet still has to burn an attempt, which is what makes
-- a crash count against the ceiling instead of retrying forever.
create table if not exists aai_platform.workflow_attempts (
  slug text not null references aai_platform.agents (slug) on delete cascade,
  run_id text not null,
  key text not null,
  n integer not null,
  primary key (slug, run_id, key)
);

create table if not exists aai_platform.workflow_sleeps (
  slug text not null references aai_platform.agents (slug) on delete cascade,
  run_id text not null,
  key text not null,
  wake_at bigint not null,
  woken boolean not null default false,
  correlation_id text,
  -- `sleep` or `hookTimeout`. The distinction is load-bearing and was missing
  -- once: journaling a hook's deadline as an ordinary sleep meant a bare
  -- `wakeUp()` — a "send it now" tool — also closed every open approval window on
  -- the run.
  kind text not null default 'sleep',
  primary key (slug, run_id, key)
);

-- What the wake sweep scans: the earliest unwoken deadline, across every agent.
create index if not exists workflow_sleeps_due_idx
  on aai_platform.workflow_sleeps (wake_at)
  where woken = false;

create table if not exists aai_platform.workflow_hooks (
  slug text not null references aai_platform.agents (slug) on delete cascade,
  run_id text not null,
  key text not null,
  token text not null,
  delivered boolean not null default false,
  payload jsonb,
  -- A window the run has moved past. Kept rather than deleted so a late delivery
  -- answers "closed" instead of "never existed" — the same answer to the caller,
  -- and the difference between them is the only thing an author can debug from.
  closed boolean not null default false,
  primary key (slug, run_id, key)
);

create unique index if not exists workflow_hooks_token_idx
  on aai_platform.workflow_hooks (slug, token);

-- Same posture as every other `aai_platform` table: RLS on with no policies, so
-- the anon and authenticated roles reach nothing and the service role bypasses it.
alter table aai_platform.workflow_runs enable row level security;
alter table aai_platform.workflow_steps enable row level security;
alter table aai_platform.workflow_attempts enable row level security;
alter table aai_platform.workflow_sleeps enable row level security;
alter table aai_platform.workflow_hooks enable row level security;
