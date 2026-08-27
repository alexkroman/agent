-- The platform owns the durable-workflow QUEUE.
--
-- A workflow agent runs the Workflow DevKit's Postgres world inside its guest,
-- and a queue has to be woken: graphile-worker holds a Postgres `LISTEN`
-- connection for the life of the process, `world-postgres`'s streamer holds a
-- second, and `workflow-lock-sweep.ts` holds a third for its session-scoped
-- advisory lock. Three connections per tenant, parked, doing nothing —
-- `aai/sdk/app-db-budget.ts`'s own table names all three.
--
-- Per tenant that is fatal at small numbers. `max_connections` is a CLUSTER
-- setting — one backend process per connection regardless of which database it
-- targets — so N tenants cost 3N of one instance's 60. Load testing eight
-- workflow guests against a 100-connection instance saturated it and the `53300`
-- refusals began, including on the platform's own reads. Per-app databases do
-- not help: they share the postmaster.
--
-- ── ONE TABLE, BECAUSE THE ENGINE IS REUSED ─────────────────────────────────
--
-- An earlier draft of this migration declared seven tables — events, runs, steps,
-- hooks, waits, stream chunks and this queue — on the plan that the platform
-- would own the whole journal. That plan is dropped, and the reason is worth
-- recording: `events.create` is not a projection, it is the durable-execution
-- state machine, and its ERROR TYPES are contract. `world-postgres` throws
-- `RunExpiredError` on `run_started` against a terminal run specifically "so the
-- runtime knows to exit without retrying", and `EntityConflictError` for other
-- terminal transitions. It also carries resilient start (a `run_started` on a
-- missing run creates it), idempotent `run_cancelled`, and optimistic concurrency
-- against a per-run marker. Reimplementing that is owning an engine — ~1,200
-- lines in every reference implementation — against a contract that moves.
--
-- It does not have to be reimplemented. Every reference's `createWorld` returns a
-- FLAT SPREAD of three independently-built objects:
--
--     return { specVersion, ...storage, ...streamer, ...queue, start, close };
--
-- and `PostgresWorldConfig` accepts a `pool`. So the platform can take
-- `world-postgres`'s storage and streamer UNCHANGED and override only the queue —
-- which is the one piece that has to route per tenant, and therefore the one
-- piece that cannot be theirs. Proven rather than assumed: a composed world
-- (their storage, our queue) loaded through `WORKFLOW_TARGET_WORLD` ran the
-- `dev-workflow.scenario.test.ts` chain with 121 of 121 messages delivered,
-- without the event state machine being touched.
--
-- So the journal stays the DevKit's, in its own `workflow` schema created by its
-- own migration. What the platform owns is this table.
--
-- ── WHY A TABLE AND NOT graphile-worker ─────────────────────────────────────
--
-- graphile-worker IS the `LISTEN` connection this change exists to give back, and
-- it cannot route per tenant anyway: `world-postgres` dispatches its callbacks to
-- one process-global origin (`getExecutionBaseUrl()`), while every tenant's guest
-- has a different tunnel. A row with a due time plus the platform's own interval
-- sweep replaces both — the sweep selects due messages and POSTs them into the
-- tenant's guest through the broker, which already knows how to boot a sandbox
-- that has exited.
--
-- `available_at` IS how `sleep` works: `QueueOptions.delaySeconds` becomes a
-- future due time, and nothing is held in the meantime. That is the same
-- mechanism Vercel's hosted world uses, whose docs describe a seven-day sleep as
-- consuming no resources.
--
-- Delivery must be OUT OF BAND, and a spike proved why: an in-process stand-in
-- that awaited the handler deadlocked, because a handler enqueues a message for
-- its own run and cannot be blocked behind itself. `queue()` therefore writes a
-- row and returns; the sweep delivers later, and per-run ordering belongs to the
-- sweep rather than to the enqueue.

create schema if not exists aai_platform;

create table if not exists aai_platform.workflow_queue (
  id text primary key,
  -- The tenant, and a real foreign key: deleting an agent must not strand
  -- messages addressed to a guest that will never exist again. Follows
  -- `20260810010000_workspace_child_foreign_keys.sql`.
  slug text not null references aai_platform.agents (slug) on delete cascade,
  -- The DevKit's own queue name, e.g. `__wkf_workflow_<workflowId>`. Its PREFIX
  -- selects the handler (`__wkf_workflow_` / `__wkf_step_`), so the full name is
  -- stored and the prefix derived rather than the reverse.
  queue_name text not null,
  -- `QueuePayloadSchema` — a real zod object (`runId`, `traceCarrier`,
  -- `runInput`, …) the runtime reads, so `jsonb` rather than the opaque `bytea`
  -- the journal's payloads need.
  payload jsonb not null,
  headers jsonb,
  deployment_id text,
  idempotency_key text,
  -- Attempts already made. The sweep raises it and pushes `available_at` out, so
  -- a guest that cannot be reached backs off rather than spinning.
  attempt integer not null default 0,
  -- The due time. `now()` for an immediate message, `now() + delaySeconds` for a
  -- sleep.
  available_at timestamptz not null default now(),
  -- A claim, so two replicas cannot deliver one message twice. Cleared when a
  -- delivery fails, so a crashed replica's claim is reclaimable by the sweep's
  -- own staleness rule rather than pinning the message forever.
  locked_at timestamptz,
  created_at timestamptz not null default now()
);

-- The sweep's only query: due, unclaimed, oldest first. PARTIAL, because a
-- claimed or future message is not a candidate and indexing one would cost the
-- write path for nothing.
create index if not exists workflow_queue_due_idx
  on aai_platform.workflow_queue (available_at)
  where locked_at is null;

-- A stale claim has to be findable, or a replica that died mid-delivery holds its
-- messages forever.
create index if not exists workflow_queue_claimed_idx
  on aai_platform.workflow_queue (locked_at)
  where locked_at is not null;

-- `QueueOptions.idempotencyKey` must collapse a duplicate enqueue, per tenant.
create unique index if not exists workflow_queue_idempotency_idx
  on aai_platform.workflow_queue (slug, idempotency_key)
  where idempotency_key is not null;

-- Deny-all RLS, as every table in this schema carries: no policies and no grant
-- to `anon`/`authenticated`, so an accidental grant yields zero rows rather than
-- every tenant's messages. `platform-schema.test.ts` derives the table list from
-- these `create table` statements, so omitting this line fails that test by name.
-- ENABLE, never FORCE — the owner is every query the platform makes.
alter table aai_platform.workflow_queue enable row level security;
