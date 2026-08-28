-- Workflow upload RECORDS on the platform's own database.
--
-- The last thing a guest kept on local disk, and the reason the answer to
-- "should a guest have a durable disk?" was not already no.
--
-- ── WHAT THIS REPLACES ───────────────────────────────────────────────────────
--
-- `createUploadStore` decided an upload's home from whether the agent had a
-- `ctx.db`, on a premise its own comment stated: "A database means durable runs,
-- so the bytes have to be durable too." That premise was falsified when the
-- workflow queue moved here — a deployed app's runs are durable with no database
-- of the author's at all — so the decision keyed off a signal that had stopped
-- meaning durability.
--
-- What that cost, observed on a real sandbox: a deployed agent with no
-- `DATABASE_URL` got DURABLE RUNS and put their uploads on a disk that recycles.
-- A transcription workflow then filled the guest's filesystem, every write raised
-- `ENOSPC`, and three layers retried it as though it were transient.
--
-- ── TENANCY IS IN THE KEY ────────────────────────────────────────────────────
--
-- The slug is half the primary key and appears in every statement
-- (`platform-uploads.ts`), so there is no query that can be pointed at another
-- agent's rows and therefore no check to forget. Same shape as
-- `session_slots`/`session_events`, and for the same reason: this schema is the
-- platform's own, unlike the DevKit's, which has no tenant column and needs the
-- `workflow_run_owner` mapping table instead.
--
-- The id is a TEXT the guest chooses. It is unique per slug rather than globally:
-- `claim` exists precisely so a caller-chosen id can be refused when taken, and
-- scoping that refusal per agent is what stops one tenant's id space from
-- colliding with another's — or leaking its contents through a rejected claim.

create table if not exists aai_platform.workflow_uploads (
  slug text not null references aai_platform.agents (slug) on delete cascade,
  id text not null,
  name text not null default '',
  type text not null default '',
  -- `bigint`, so an upload past 2^31 bytes is representable. postgres.js hands a
  -- bigint back as a STRING, which `platform-uploads.ts` coerces at the boundary
  -- rather than letting a string reach arithmetic.
  size bigint not null,
  complete boolean not null default true,
  -- NULL is a DIFFERENT value from 0 and the store reads which: it is the declared
  -- total of a PARTS upload and is absent for every other kind, which is what
  -- tells them apart. A streamed upload's completion is decided by its body
  -- ending, never by its prefix reaching a number nobody declared.
  expected bigint,
  -- Raw window boundaries, UN-MERGED. A merge loses which object holds a byte,
  -- which is what a resumed read needs.
  parts jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (slug, id)
);

-- The one non-key read pattern: the sweep below expires by age. Without this it
-- is a full scan of every tenant's uploads on every pass.
create index if not exists workflow_uploads_expiry_idx
  on aai_platform.workflow_uploads (created_at);

-- Same posture as every other `aai_platform` table: RLS on with no policies, so the
-- anon and authenticated roles reach nothing and the service role bypasses it.
-- Worth stating for this table specifically: an upload record names the bucket
-- OBJECTS holding a tenant's bytes, so a row leaked here is a map to another
-- tenant's audio.
alter table aai_platform.workflow_uploads enable row level security;
