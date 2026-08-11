-- Per-session analytics for deployed agents.
--
-- One append-only row per thing that happened inside a live session: turns,
-- tool calls, errors, latencies, and the runtime's own log lines. Written by
-- `POST /analytics/ingest` (aai-server/analytics-routes.ts) from batches the
-- guest ships; read by the studio's Analytics pane and by the coding agent's
-- `query_analytics` tool.
--
-- ── Why ONE wide table ──────────────────────────────────────────────────────
--
-- The consumer that matters is an LLM writing ad-hoc SQL against a schema it
-- was handed in a tool description. Three normalized tables (sessions, turns,
-- tool calls) would make it join before it can count, and every join is a
-- chance to write a subtly wrong query that still returns rows. One table with
-- a `kind` discriminator makes the common questions single-scan filters, and
-- `data` carries the kind-specific remainder. The columns that are hoisted out
-- of `data` are exactly the ones that get filtered, grouped, or aggregated.
--
-- ── Retention is SEVEN DAYS, enforced by a sweep ────────────────────────────
--
-- This is the highest-write path the platform has, and the rows carry end-user
-- speech (see the redaction note in packages/aai-server/CLAUDE.md). Seven days
-- is long enough to answer "did my change help" across a week-over-week
-- comparison and short enough that the table cannot become a transcript
-- archive nobody decided to keep. The sweep lives with the other janitorial
-- jobs in aai-server/pg-cron.ts (`aai-sweep-agent-events`); the index below is
-- what keeps it from being a sequential scan of the whole table every hour.

create table if not exists aai_platform.agent_events (
  id bigserial primary key,
  -- The deployed agent this happened in. A studio project has TWO of these
  -- (production and `<project>-preview`), which is why every studio query
  -- filters on a slug LIST rather than one slug.
  slug text not null,
  -- The deploy generation, copied from the agents row at spawn. This is the
  -- column that makes "is the new version better" answerable at all.
  agent_version bigint,
  session_id text not null,
  ts timestamptz not null,
  kind text not null,
  -- 1-based user-turn ordinal within the session; 0 before the first turn.
  turn integer not null default 0,
  duration_ms integer,
  level text,
  name text,
  body text,
  ok boolean,
  data jsonb not null default '{}'::jsonb,
  -- When the row was accepted, as opposed to when the event happened. The
  -- sweep and the ingest rate accounting both want the arrival time: `ts` is
  -- reported by the guest and a clock-skewed one must not be able to outlive
  -- retention (or be swept the moment it lands).
  received_at timestamptz not null default now()
);

-- Every read is "this slug (or these two), recently, newest first" — the pane's
-- default view, the summary aggregates, and any WHERE clause an agent writes.
create index if not exists agent_events_slug_ts
  on aai_platform.agent_events (slug, ts desc);

-- Reconstructing one conversation: all rows for a session in order.
create index if not exists agent_events_session
  on aai_platform.agent_events (session_id, ts);

-- The retention sweep's predicate. Without it the hourly delete scans the
-- whole table — which is the table most likely to be large.
create index if not exists agent_events_received_at
  on aai_platform.agent_events (received_at);

-- Deny-all RLS, for the reason the whole platform schema has it: nothing here
-- goes through policies (the platform connects as the table owner), so this is
-- defense in depth against an accidental grant. See
-- 20260807000000_platform_rls.sql for why it is ENABLE and never FORCE, and
-- why there are deliberately no policies.
--
-- This table is the sharpest one in the schema for that mistake: its rows are
-- end-user speech. It is deliberately NOT added to the `supabase_realtime`
-- publication and NOT granted to `service_role` — nothing subscribes to
-- analytics, and a grant here would put transcripts behind the same key the
-- browser-facing Realtime client authenticates with.
alter table aai_platform.agent_events enable row level security;
