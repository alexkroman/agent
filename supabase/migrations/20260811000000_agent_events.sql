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
-- ── Why one PLATFORM-owned table, not a per-app schema ──────────────────────
--
-- The obvious alternative is the shape `ctx.db` already uses: a schema plus a
-- login role per app (`app-database.ts`). It was rejected for four reasons,
-- and the first is the one that decides it:
--
-- 1. The tenant would own its own audit trail. Tenant code holds that role's
--    credentials inside the guest, so an agent could forge or delete its own
--    telemetry. Analytics has to be readable BY the tenant and writable only
--    by the platform.
-- 2. App databases are OPT-IN (`aai storage enable`); analytics is not. Every
--    deployed agent would need a schema and a role provisioned whether or not
--    it ever wanted storage — and every one of those needs sweeping when the
--    agent goes away.
-- 3. A project is TWO agents, and `APP_DB_URLS` shards app databases across
--    clusters by `hash(slug)` — so a project's production and preview rows
--    could land on different Postgres instances, and the pane's one summary
--    query becomes a cross-cluster join in JavaScript.
-- 4. Ingest is the hot path. Per-app schemas mean resolving and pooling a
--    per-slug credential per batch instead of one shared pool.
--
-- What the per-app pattern DOES contribute is its second half — a dedicated
-- role with a narrow grant — which is what `aai_analytics_reader` below is.
-- The cost of this choice is real and worth stating: analytics cannot be
-- joined against a tenant's own `ctx.db` tables. Closing that would mean
-- granting the app role `select` here and colocating the two, which is a
-- decision about cross-schema coupling rather than an oversight.
--
-- ── Retention is SEVEN DAYS, enforced by DROPPING PARTITIONS ────────────────
--
-- This is the highest-write path the platform has, and the rows carry end-user
-- speech (see the redaction note in packages/aai-server/CLAUDE.md). Seven days
-- is long enough to answer "did my change help" week over week and short
-- enough that the table cannot become a transcript archive nobody decided to
-- keep.
--
-- The table is RANGE partitioned by day so retention is `drop table` on a
-- whole partition — a catalog operation — rather than `delete from` on the
-- largest table in the schema. A bulk delete there would be the classic
-- mistake: it leaves as many dead tuples as it removed rows, hands autovacuum
-- a full pass of the table every hour, and bloats the very indexes the pane's
-- queries use. Dropping a partition frees the files outright and touches no
-- index at all.
--
-- **`pg_partman` is deliberately not used**, and not for lack of looking:
-- Supabase documents the extension but does not ship it (supabase/postgres
-- #1586 — it is planned for a future Postgres 17 image and is absent from the
-- dashboard's extension list today). Enabling it is not something a migration
-- can do on our behalf. The maintenance it would perform is ~20 lines of
-- plpgsql on the pg_cron schedule the platform already runs
-- (`aai-maintain-agent-events` in aai-server/pg-cron.ts), so the dependency
-- buys ergonomics rather than capability. If it becomes available, that job
-- is what `partman.create_parent` + a retention setting would replace.
--
-- ── Partitioned on `received_at`, and every reader must filter on it ────────
--
-- Not on `ts`. `ts` is reported by the GUEST, so a skewed clock could place a
-- row in a partition that never expires — or in one that does not exist,
-- which is an insert error rather than a slow query. `received_at` defaults
-- to `now()` on this server, so a row can only ever belong to a partition
-- around the present.
--
-- The consequence is that partition PRUNING keys off `received_at`, so a
-- query filtered only on `ts` scans every partition. Every reader in
-- `analytics-store.ts` and the `events` CTE in `analytics-query.ts` therefore
-- carries a `received_at` bound as well as its `ts` one.

create table if not exists aai_platform.agent_events (
  id bigserial,
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
  -- When the row was accepted, as opposed to when the event happened — the
  -- partition key, for the reason above.
  received_at timestamptz not null default now(),
  -- A partitioned table's primary key must contain the partition key, which
  -- is why this is a composite rather than `id` alone. Nothing joins on it;
  -- it exists so a row is addressable.
  primary key (received_at, id)
) partition by range (received_at);

-- Every read is "this slug (or these two), recently, newest first" — the
-- pane's default view, the summary aggregates, and any WHERE clause an agent
-- writes. Declared on the PARENT, so every partition (including ones the
-- maintenance job creates months from now) inherits it automatically.
create index if not exists agent_events_slug_ts
  on aai_platform.agent_events (slug, ts desc);

-- Reconstructing one conversation: all rows for a session in order.
create index if not exists agent_events_session
  on aai_platform.agent_events (session_id, ts);

-- There is deliberately NO index on `received_at`. Retention no longer scans
-- for expired rows — it drops whole partitions — and the partition bounds
-- already answer every range predicate on this column.

-- The backstop partition. Inserts land here if the maintenance job has been
-- dead long enough to exhaust the partitions it creates ahead of time; without
-- it, that outage would turn into failing ingest. It should always be empty,
-- and `aai-maintain-agent-events` reports it when it is not. It is never
-- dropped: attaching a new partition while the default holds matching rows is
-- an error, so a non-empty default is a condition to notice, not to sweep.
create table if not exists aai_platform.agent_events_default
  partition of aai_platform.agent_events default;

-- ── Row-level security ──────────────────────────────────────────────────────
--
-- Unlike every other table in this schema, RLS here is NOT purely defense in
-- depth: it is the mechanism that scopes model-authored SQL.
--
-- The platform still connects as the table owner (owners bypass policies), so
-- ingest and the pane's own aggregates are unaffected. But an ad-hoc query
-- from `query_analytics` runs under `set local role aai_analytics_reader` on a
-- reserved connection (analytics-store.ts), and for THAT role the policy below
-- is what limits the rows to the caller's own agents — in the database, rather
-- than in a CTE a clever query might get around.
alter table aai_platform.agent_events enable row level security;

-- The reader is NOLOGIN: it is reachable only by `set role` from a connection
-- the platform already holds, never by connecting. That is what lets it exist
-- without a password to provision, store in Vault, or rotate.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'aai_analytics_reader') then
    create role aai_analytics_reader nologin;
  end if;
end $$;

grant usage on schema aai_platform to aai_analytics_reader;
grant select on aai_platform.agent_events to aai_analytics_reader;
-- Explicitly nothing else in the schema, now or later: a future table must be
-- granted deliberately rather than inherited into this role by a blanket
-- `grant select on all tables`.

-- Scope comes from a session GUC the platform sets before switching role.
-- `current_setting(..., true)` returns NULL when unset, and `= any(NULL)` is
-- NULL — so a connection that forgot to set it reads ZERO rows rather than
-- every row. Fail-closed is the whole point; the alternative would make a
-- missing `set` into a cross-tenant leak.
drop policy if exists agent_events_reader_scope on aai_platform.agent_events;
create policy agent_events_reader_scope on aai_platform.agent_events
  for select to aai_analytics_reader
  using (slug = any (string_to_array(current_setting('aai.analytics_slugs', true), ',')));

-- Not added to the `supabase_realtime` publication and not granted to
-- `service_role`: nothing subscribes to analytics, and a grant there would put
-- end-user transcripts behind the same key the browser-facing Realtime client
-- authenticates with.
