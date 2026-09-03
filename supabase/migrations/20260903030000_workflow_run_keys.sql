-- The correlation-key index, owned by the platform.
--
-- `(workflow, key) -> runId` is how a caller's NEXT call finds the durable run
-- their last one started. The Workflow Development Kit cannot be asked that
-- question — `runs.list()` filters by workflow name and status and nothing else —
-- and the reason it has to be answerable is specifically a voice one: a run
-- outlives the session that started it, and `ctx.state`, the obvious place to
-- keep a `runId`, is swept `SESSION_RESUME_GRACE_MS` after the caller hangs up.
-- Without the index the run is unreachable from the next call, which is the case
-- `StartOptions.key` and `WorkflowClient.find` exist for.
--
-- ## This is the journal's gap, one table over, and it was still open
--
-- `20260901000000_platform_workflow_journal.sql` opens "a durable run's whole
-- claim is that it outlives the process running it", and closed exactly that for
-- the journal. The index had the same two backends and the same hole:
-- `createPostgresKeyStore` needs a `DATABASE_URL` and the platform provisions no
-- tenant database (`aai-server/sandbox-resolve.ts` passes through the AUTHOR's own
-- secret; `ctx.db` is gone), so on a typical deployed agent `resolveKeyStore` fell
-- to `createMemoryKeyStore` — a `Map` in a sandbox that self-exits after
-- `AGENT_IDLE_EXIT_MS`.
--
-- What that cost is the whole feature, silently: the run stayed durable in the
-- platform's journal and the only pointer to it died with the container, so
-- `find(workflow, "+14155550123")` answered `[]` on the next call and the agent
-- started a second run for a caller it had already served. Nothing reported it —
-- an empty index and a caller with no prior run are the same answer — and the boot
-- line said `keyStore: "memory"` on every deployment with nobody reading it.
--
-- This table is the third backend, reached over `POST /:slug/workflow-keys` with
-- the per-sandbox bearer, exactly as the journal, session state and the queue are.
--
-- ## Which of the journal migration's decisions apply here
--
-- Its "Tenancy is a COLUMN" section applies WHOLE. The self-hosted table
-- (`aai-runtime/workflow-keys.ts`, `aai_workflow_run_keys`) has no slug because
-- there the database IS the agent and a column would be a constant; here one
-- database serves every agent, so the slug leads the primary key and is the first
-- parameter of every statement, and a guessed run id reaches nothing. The
-- `bigint` epoch-millisecond `created_at` applies for its reason too — the ENGINE
-- assigns it and the ENGINE compares it, so a `timestamptz` would put the
-- database's clock and the driver's parsing in the one ordering the index
-- promises. (The self-hosted table's `timestamptz default now()` predates that
-- rule and is the statement's own transaction time; both agree on the contract,
-- "the order they were started", which is what
-- `aai-runtime/workflow-keys-conformance-cases.ts` asserts of all three.)
--
-- Two of its decisions do NOT apply:
--
--   * `workflow_hooks`'s `unique (slug, token)`. That exists because a token is
--     what a THIRD PARTY dials and a globally-unique one would let one agent's
--     token collide with another's. A correlation key is dialled by nobody; it is
--     read back only by the agent that recorded it, under `where slug = $1`, so
--     the primary key is the whole of its uniqueness.
--   * The five-table shape. This is one table, and it has no children.
--
-- ## The primary key is `(slug, run_id)`, and a KEY is deliberately not unique
--
-- `StartOptions.key` says a key may name several runs — a caller who phones twice
-- has two — so keying on `(slug, workflow, key)` would make the second `start`
-- either fail or silently replace the first, and "the newest run for this caller"
-- is a READ. Keying on the run instead gives the store its idempotency for free:
-- `on conflict (slug, run_id) do nothing` means a retried `record` after a lost
-- connection is a no-op rather than a second row, which is the property both of
-- the drifts the conformance table found were about.
--
-- ## It references `agents` and NOT `workflow_runs`, which is a contract point
--
-- Every other table in this schema that names a run references `agents`, and here
-- that is load-bearing rather than conventional: `WorkflowKeyStore.record` takes a
-- run id and promises nothing about a run existing, so all three backends accept
-- one that names no run (the conformance cases mint ids that never were). A
-- foreign key to `workflow_runs` would make this arm refuse what the other two
-- accept — a divergence in exactly the direction the shared case list exists to
-- prevent — and would additionally couple the index's writes to the journal's,
-- which are two different backends' business.
--
-- The cost of that choice is that the run-retention sweep
-- (`aai_platform.sweep_terminal_workflow_runs`, which deletes a run's steps,
-- attempts, sleeps and hooks in its own statement for the same
-- no-cascade-to-lean-on reason) leaves a key row behind. `SWEEP_WORKFLOW_RUN_KEYS`
-- in `aai-server/pg-cron-bodies.ts` is what collects those; read it there for why
-- a key is collected when its RUN is gone rather than on an age of its own.
create table if not exists aai_platform.workflow_run_keys (
  slug text not null references aai_platform.agents (slug) on delete cascade,
  run_id text not null,
  workflow text not null,
  key text not null,
  created_at bigint not null,
  primary key (slug, run_id)
);

-- The ONE query the store makes: `where slug = $1 and workflow = $2 and key = $3
-- order by created_at desc, run_id desc limit $4`. All five columns, in that
-- order, so the lookup is one walk that serves the filter, the ordering and the
-- bound — without it a `find` on a busy agent scans every run that agent has ever
-- keyed. `run_id desc` is the tiebreak for two runs recorded in the same
-- millisecond: a run id is a ULID, so it sorts by generation time, which is what
-- makes "newest first" true rather than planner-dependent.
create index if not exists workflow_run_keys_lookup_idx
  on aai_platform.workflow_run_keys (slug, workflow, key, created_at desc, run_id desc);

-- What the retention sweep's prefilter reads. Its predicate is "old AND the run is
-- gone", and the age half exists to make a no-op pass an index probe rather than a
-- sequential scan plus one primary-key probe per row — the same reason
-- `workflow_runs_terminal_idx` was added for the run sweep in
-- `20260902120000_workflow_run_abandonment.sql`. No slug, because the sweep is
-- fleet-wide and has none to lead with.
create index if not exists workflow_run_keys_created_idx
  on aai_platform.workflow_run_keys (created_at);

-- Same posture as every other `aai_platform` table: RLS on with no policies, so
-- the anon and authenticated roles reach nothing and the service role bypasses it.
-- `platform-schema.test.ts` derives its table list from the `create table`
-- statements above, so omitting this line fails "every declared table has it
-- enabled" by name rather than shipping a table a browser could read if anything
-- ever granted on it.
alter table aai_platform.workflow_run_keys enable row level security;
