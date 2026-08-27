-- Turn-level durability, owned by the platform.
--
-- A tool's `ctx.slots` and the session event log are committed at the END of every
-- tool call, awaited, so a crash preserves the turn. Both lived in the app's own
-- database — which is the thing being removed, and removing it with nothing here
-- would silently downgrade every agent to memory-only state: a guest restart
-- mid-conversation loses the turn, with `durable: false` in a log line as the only
-- trace.
--
-- ## Tenancy is a COLUMN here, not a mapping table
--
-- `aai_platform.workflow_run_owner` exists because the DevKit's schema is fixed and
-- has no tenant column, so ownership had to be recorded beside it. This schema is
-- the platform's own, so the slug is simply part of the primary key: every read and
-- write is filtered by it, and a guessed session id reaches nothing. That is the
-- design the run journal could not have.
--
-- ## The shapes mirror the app-database tables exactly
--
-- `session-state-postgres.ts` is the contract both ends derive from, and the
-- reasons carry over unchanged:
--
-- - `jsonb`, not `text`, for `value` and `event`. Every read and write here is a
--   string, so `text` would work and be marginally cheaper; `jsonb` earns it by
--   REJECTING anything that is not JSON at write time, which is the one check the
--   process above cannot fake, and exactly the class of bug an in-memory store
--   cannot represent.
-- - `(…, session_id, event_index)` as the event key is what makes a retried flush
--   idempotent: `on conflict do nothing` turns a re-append of a stored index into
--   the no-op the backend contract promises. The index is assigned ABOVE the
--   backend, so the database never invents one — a `serial` would hand out
--   positions a live session had already told a client about.
-- - `updated_at` / `created_at` are what the retention sweep reads.
create table if not exists aai_platform.session_slots (
  slug text not null references aai_platform.agents (slug) on delete cascade,
  session_id text not null,
  slot text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (slug, session_id, slot)
);

create table if not exists aai_platform.session_events (
  slug text not null references aai_platform.agents (slug) on delete cascade,
  session_id text not null,
  event_index bigint not null,
  event jsonb not null,
  created_at timestamptz not null default now(),
  primary key (slug, session_id, event_index)
);

-- What the retention sweep scans. Partial on nothing — every row is a candidate
-- eventually — so a plain btree on the timestamp is what a `< now() - interval`
-- delete wants.
create index if not exists session_slots_stale_idx
  on aai_platform.session_slots (updated_at);
create index if not exists session_events_stale_idx
  on aai_platform.session_events (created_at);

-- Same posture as every other `aai_platform` table: RLS on with no policies, so the
-- anon and authenticated roles reach nothing and the service role bypasses it.
alter table aai_platform.session_slots enable row level security;
alter table aai_platform.session_events enable row level security;
