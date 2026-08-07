-- Platform schema for the AAI control plane.
--
-- Everything in `aai_platform` used to be created LAZILY by the store that
-- read it: a memoized `create schema/table if not exists` on first use
-- (`pg-ensure.ts`), which is why pg_cron sweep bodies had to be wrapped in
-- `to_regclass` guards — on a fresh database a job could fire before its
-- table existed. Declaring the schema here removes both: the tables exist
-- before any code runs, so no store carries DDL and no sweep guards against
-- its own table's absence.
--
-- The trade is deploy ordering: this must be applied BEFORE the code that
-- queries it (`supabase db push`, then deploy). A missed migration now fails
-- loudly with "relation does not exist" instead of being papered over by a
-- lazy create — which is the better failure, but it is a new obligation.
--
-- Idempotent throughout, so re-applying is safe.

create schema if not exists aai_platform;

-- Extensions the platform schedules work with. pg_cron owns the janitorial
-- sweeps (aai-server/pg-cron.ts); pgmq owns the durable preview-deploy queue
-- (aai-studio-server/studio-preview-queue.ts).
create extension if not exists pg_cron;
create extension if not exists pgmq;

-- ── Deploy records ──────────────────────────────────────────────────────────
-- One row per agent. `version` doubles as the cross-replica invalidation
-- signal: resident sandboxes compare against it and retire on a mismatch
-- (see sandbox-resolve.ts).
create table if not exists aai_platform.agents (
  slug text primary key,
  credential_hashes jsonb not null,
  config jsonb not null,
  worker_hash text not null,
  client_files jsonb not null,
  harness_image_tag text,
  version bigint not null,
  updated_at timestamptz not null default now()
);

-- ── Studio workspaces and chats ─────────────────────────────────────────────
-- `doc` carries the whole workspace (files + preview/deploy stamps); `version`
-- is the optimistic-concurrency token `mutateWorkspace` retries against.
create table if not exists aai_platform.studio_workspaces (
  scope text not null,
  project text not null,
  doc jsonb not null,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (scope, project)
);

create table if not exists aai_platform.studio_chats (
  scope text not null,
  project text not null,
  messages jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (scope, project)
);

-- ── Cross-replica coordination ──────────────────────────────────────────────
-- Per-scope fixed-window rate limits, shared across replicas so the limit
-- holds platform-wide instead of multiplying by the replica count.
create table if not exists aai_platform.studio_rate_limits (
  name text not null,
  key text not null,
  count integer not null,
  reset_at timestamptz not null,
  primary key (name, key)
);

-- The pg_cron sweep filters on reset_at; without the index every sweep is a
-- sequential scan.
create index if not exists studio_rate_limits_reset_at
  on aai_platform.studio_rate_limits (reset_at);

-- Live studio coding-agent sandboxes, one row per (scope, project). This is a
-- LEASE: the row's expiry is the only cross-replica record that someone has
-- used a project recently, which the owning replica's idle sweeper consults
-- before evicting a guest a peer may be actively serving. (Agent sandboxes
-- need no such table — their fleet-wide identity is a Modal sandbox NAME; see
-- sandbox-directory.ts.)
create table if not exists aai_platform.studio_sessions (
  scope text not null,
  project text not null,
  chat_url text not null,
  chat_token text not null,
  guest_origin text not null,
  sandbox_token text not null,
  owner text not null,
  expires_at timestamptz not null,
  primary key (scope, project)
);

create index if not exists studio_sessions_expires_at
  on aai_platform.studio_sessions (expires_at);

-- ── Durable preview-deploy queue ────────────────────────────────────────────
-- `pgmq.create` is not `if not exists`, so the duplicate is caught.
do $$
begin
  perform pgmq.create('aai_studio_preview');
exception
  when duplicate_table or duplicate_object then null;
end $$;

-- ── Realtime change streams ─────────────────────────────────────────────────
-- The watched tables must be in the `supabase_realtime` publication before
-- the Realtime service will stream their changes.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'aai_platform' and tablename = 'agents'
  ) then
    alter publication supabase_realtime add table aai_platform.agents;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'aai_platform' and tablename = 'studio_workspaces'
  ) then
    alter publication supabase_realtime add table aai_platform.studio_workspaces;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'aai_platform' and tablename = 'studio_chats'
  ) then
    alter publication supabase_realtime add table aai_platform.studio_chats;
  end if;
end $$;

-- Realtime validates a channel's `filter` column — and walrus gates row
-- visibility — against the columns the subscriber's claimed role can SELECT,
-- and the platform client authenticates with the service-role key. The
-- app-created `aai_platform` schema gets none of Supabase's default `public`
-- grants, so without these every filtered subscribe fails server-side with
-- `invalid column for filter <col>` (P0001) and realtime-js retries the join
-- forever.
--
-- THE GRANT IS ALSO THE SECURITY BOUNDARY, and it is the only one: these
-- tables carry no RLS policies, so what stops a browser subscribing to every
-- tenant's workspace is that `anon`/`authenticated` are granted nothing here
-- (and `aai_platform` is not a PostgREST-exposed schema). Supabase's docs
-- assume RLS is that gate and their linter only inspects `public`, so nothing
-- outside this file would report a mistake. Adding a role to this grant, or
-- exposing the schema, therefore needs RLS policies in the same change.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema aai_platform to service_role;
    grant select on
      aai_platform.agents,
      aai_platform.studio_workspaces,
      aai_platform.studio_chats
      to service_role;
  end if;
end $$;
