// Copyright 2026 the AAI authors. MIT license.
/**
 * Janitorial sweeps as pg_cron jobs — scheduled in the platform's Supabase
 * Postgres, not in-process. A scheduled database job survives replica churn
 * by construction, runs exactly once platform-wide instead of once per
 * replica, and replaces the in-process sweepers (the rate limiter's
 * piggybacked delete).
 *
 * The platform tables are declared in
 * `supabase/migrations/*_platform_schema.sql` and applied before any code
 * runs, so a sweep body no longer needs to guard against its own table's
 * absence — that `to_regclass` wrapper existed only because the stores
 * created their tables lazily on first use. Two guards remain, for tables
 * migrations do NOT own: `pgmq.a_<queue>` (created by pgmq on the first
 * archive, so it can legitimately not exist yet) and `vault.secrets`.
 *
 * `cron.schedule(name, …)` upserts by job name, so re-running the setup on
 * every boot is idempotent and a changed schedule or command takes effect on
 * the next deploy. Retirement is the same statement read the other way: boot
 * unschedules every `aai-*` job the code no longer declares, so
 * {@link platformCronJobs} is the whole truth about what the platform runs.
 */

import { PLATFORM_STORAGE_KEY_SECRET, type SqlExec } from "./secret-store.ts";

export type CronJob = {
  /** Unique job name — `cron.schedule` upserts by it. */
  name: string;
  /** Standard 5-field cron schedule, evaluated in the database's clock. */
  schedule: string;
  /** SQL the job runs. */
  command: string;
};

/**
 * Wrap a sweep in a table-existence guard, for the tables migrations do not
 * own (see module doc). plpgsql only plans a statement when its branch is
 * reached, so this makes a missing table a no-op instead of an hourly error.
 */
function guarded(table: string, body: string): string {
  return `do $$
begin
  if to_regclass('${table}') is not null then
    ${body};
  end if;
end $$`;
}

/**
 * Expired rate-limit windows. A live scope reuses its row in place
 * (studio-rate-limit.ts), so an expired row is only read again to be
 * overwritten — deleting it is equivalent and keeps the table proportional
 * to recently active scopes.
 */
const SWEEP_RATE_LIMITS = "delete from aai_platform.studio_rate_limits where reset_at <= now()";

/**
 * Archived preview-deploy jobs (aai-studio-server/studio-preview-queue.ts).
 * `pgmq.archive` moves a job that could not be run — unreadable payload,
 * crash loop, no resolvable credential — out of the queue and into
 * `pgmq.a_<queue>`, deliberately keeping it for inspection rather than
 * dropping it. Without a sweep that table only grows; a week is long enough
 * to notice a pattern in it and act.
 */
const SWEEP_PREVIEW_ARCHIVE = guarded(
  "pgmq.a_aai_studio_preview",
  "delete from pgmq.a_aai_studio_preview where archived_at < now() - interval '7 days'",
);

/**
 * Expired studio session registrations — the same hygiene as above for the
 * studio broker's own registry (aai-studio-server/studio-session-registry.ts),
 * whose rows carry guest credentials and so should not linger past their
 * lease any longer than the sweep interval.
 */
const SWEEP_STUDIO_SESSIONS = "delete from aai_platform.studio_sessions where expires_at <= now()";

/**
 * Orphaned preview agents: `<project>-preview` deploys whose studio project
 * was deleted (project deletion removes the workspace and chat rows but the
 * preview agent — deployed through the standard deploy path — has no other
 * reaper). Matched by the workspace rows' `previewSlug` back-reference, with
 * an age floor so a preview whose workspace stamp hasn't landed yet (the
 * deploy returns before `previewSlug` is written) is never reaped mid-birth.
 *
 * The back-reference is joined through `studio_workspaces.preview_slug` — a
 * STORED generated column over `doc->>'previewSlug'`
 * (`20260810020000_preview_slug_column.sql`), indexed. Reading the field out of
 * `doc` here instead would detoast the whole project file map for every
 * workspace row, once an hour, forever; that migration's header has the
 * measurement and the reason an expression index does not fix it.
 *
 * Each reaped slug is cleaned up the way the delete route would: its app
 * database is deprovisioned FIRST (schema + role, named by the `role` in the
 * stored `app-db:` meta — dropping the secret before the schema would strand
 * an unreachable schema whose credentials are gone), then its Vault secrets
 * (`agent-env:`/`app-db:`) go. Deprovisioning is best-effort per slug and
 * primary-cluster only — pg_cron runs here, and an app sharded to an extra
 * APP_DB_URLS cluster has no local schema/role, so the drops no-op there.
 * Content-addressed blobs are accepted orphans, as everywhere else.
 *
 * The `-preview` suffix is therefore studio-owned: a CLI deploy that claims
 * a `*-preview` slug with no workspace referencing it will be swept.
 */
const SWEEP_ORPHAN_PREVIEWS = `do $$
declare
  target record;
  app_id text;
begin
  -- Only vault.secrets needs guarding: the aai_platform tables come from
  -- migrations, but Vault belongs to Supabase and may not be provisioned.
  if to_regclass('vault.secrets') is null then
    return;
  end if;
  for target in
    with deleted as (
      delete from aai_platform.agents a
      where a.slug like '%-preview'
        and a.updated_at < now() - interval '1 hour'
        and not exists (
          select 1 from aai_platform.studio_workspaces w
          where w.preview_slug = a.slug
        )
      returning slug
    )
    select d.slug,
      (select s.decrypted_secret from vault.decrypted_secrets s
       where s.name = 'app-db:' || d.slug) as app_db_meta
    from deleted d
  loop
    begin
      app_id := (target.app_db_meta::jsonb)->>'role';
      -- Same identifier shape assertion as app-database.ts, so a corrupt
      -- meta can never steer the drops at an arbitrary schema/role.
      if app_id ~ '^app_[a-f0-9]{16}$' then
        execute format('drop schema if exists %I cascade', app_id);
        execute format('drop role if exists %I', app_id);
      end if;
    exception when others then
      raise warning 'orphan-preview sweep: deprovision failed for %: %',
        target.slug, sqlerrm;
    end;
    delete from vault.secrets s
    where s.name in ('agent-env:' || target.slug, 'app-db:' || target.slug);
  end loop;
end $$`;

/**
 * pg_cron's own run log. It records a row per job execution and Supabase
 * prunes NOTHING, so the sweeps' bookkeeping outgrows everything they sweep —
 * this is the standard way a Supabase project's largest table turns out to be
 * cron history. A week is long enough to answer "did the sweep run, and did it
 * fail" and short enough to stay small.
 */
const SWEEP_CRON_HISTORY =
  "delete from cron.job_run_details where end_time < now() - interval '7 days'";

/**
 * Partition maintenance for `aai_platform.agent_events` — the only job here
 * that creates as well as removes.
 *
 * Retention for that table is {@link ANALYTICS_RETENTION_DAYS} days and is
 * enforced by DROPPING whole daily partitions rather than deleting rows. It is
 * the platform's highest-write table, and an hourly `delete from` there would
 * leave as many dead tuples as it removed rows, hand autovacuum a full pass
 * every hour, and bloat the indexes the Analytics pane reads through. Dropping
 * a partition frees its files and touches no index.
 *
 * This job is what `pg_partman` would be. Supabase documents that extension
 * but does not ship it (supabase/postgres #1586 — planned for a future
 * Postgres 17 image, absent from the dashboard today), and no migration can
 * install it, so the plpgsql below stands in for `create_parent` plus a
 * retention setting. If it lands, this is what it replaces.
 *
 * Three properties are load-bearing:
 *
 * - **It creates ahead**, {@link PARTITION_LEAD_DAYS} days of them. Ingest
 *   fails outright on a row matching no partition, so the lead is how long
 *   this job may be broken before analytics stops arriving — a week rather
 *   than the hour its schedule alone would buy, with the default partition as
 *   the backstop under that.
 * - **It DRAINS the default partition rather than reporting it**, and that is
 *   the difference between a backstop and a trap. `create table … partition
 *   of …` must prove that no row in the default belongs to the new bound, and
 *   it RAISES rather than moving them — so the first row that ever lands in
 *   the default makes every later run abort on its first `create`, which
 *   stops partition creation, stops retention, and never reaches the warning
 *   that would have said so. The state is permanent and silent. It is reached
 *   the ordinary way too, not only after a week-long outage: the day the
 *   migration is pushed, ingest starts before this job's first run. So the
 *   default is detached, the partitions are created, its rows are routed back
 *   through the parent, and it is re-attached empty — the same detach/move/
 *   re-attach `pg_partman`'s maintenance does, for the same reason.
 * - **It drops only partitions wholly past retention**, computed from each
 *   partition's own upper bound in the catalog rather than parsed out of its
 *   name — so a naming change here cannot become a delete of live data.
 */
export const ANALYTICS_RETENTION_DAYS = 7;

/** Days of partitions kept pre-created ahead of today. */
export const PARTITION_LEAD_DAYS = 7;

/**
 * Partitions are also created BACKWARD across the retention window, not just
 * ahead. They cost nothing when they already exist, none of them is old enough
 * for the drop loop below to reclaim (a partition for `today - 7` has upper
 * bound `today - 6`), and they are what gives every rescued row a home: a
 * drain that had to discard rows still inside retention because their day had
 * no partition would be a data loss dressed as maintenance.
 */
const PARTITION_TRAIL_DAYS = ANALYTICS_RETENTION_DAYS;

const MAINTAIN_AGENT_EVENTS = `do $$
declare
  day date;
  part record;
  drained boolean;
  moved bigint := 0;
  expired bigint := 0;
begin
  -- Detached BEFORE the creates, which is the whole point: with the default
  -- out of the partition tree there is nothing for \`create … partition of\`
  -- to validate against, so the creates below cannot fail on rows the default
  -- is holding. It all runs in one transaction, and today's partition exists
  -- before the re-attach, so a concurrent insert always has somewhere to go.
  drained := exists (select 1 from aai_platform.agent_events_default limit 1);
  if drained then
    alter table aai_platform.agent_events
      detach partition aai_platform.agent_events_default;
  end if;

  for day in
    select generate_series(
             current_date - ${PARTITION_TRAIL_DAYS},
             current_date + ${PARTITION_LEAD_DAYS},
             interval '1 day')::date
  loop
    execute format(
      'create table if not exists aai_platform.%I partition of aai_platform.agent_events for values from (%L) to (%L)',
      'agent_events_' || to_char(day, 'YYYYMMDD'), day, day + 1
    );
  end loop;

  if drained then
    -- DELETE … RETURNING rather than a copy, so what remains afterwards is
    -- exactly the set that found no home — the two counts below are then a
    -- partition of the rows, not a total and an overlapping subset.
    -- Re-inserted through the PARENT so each row lands in its own day.
    with rehomed as (
      delete from aai_platform.agent_events_default
       where received_at >= current_date - ${PARTITION_TRAIL_DAYS}
         and received_at < current_date + ${PARTITION_LEAD_DAYS} + 1
      returning *
    )
    insert into aai_platform.agent_events select * from rehomed;
    get diagnostics moved = row_count;
    -- Anything left is older than retention would have kept anyway; the
    -- truncate is what makes the re-attach's own validation scan trivial.
    select count(*) into expired from aai_platform.agent_events_default;
    truncate aai_platform.agent_events_default;
    alter table aai_platform.agent_events
      attach partition aai_platform.agent_events_default default;
    raise warning 'aai_platform.agent_events_default drained: % row(s) rehomed, % past retention dropped', moved, expired;
  end if;

  for part in
    select c.relname,
           (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \\((''[^'']+'')\\)'))[1] as upper_bound
      from pg_class c
      join pg_inherits i on i.inhrelid = c.oid
      join pg_class p on p.oid = i.inhparent
      join pg_namespace n on n.oid = p.relnamespace
     where n.nspname = 'aai_platform' and p.relname = 'agent_events'
  loop
    if part.upper_bound is not null
       and part.upper_bound::timestamptz <= now() - interval '${ANALYTICS_RETENTION_DAYS} days'
    then
      execute format('drop table if exists aai_platform.%I', part.relname);
    end if;
  end loop;
end $$`;

/**
 * Terminate runaway tenant queries.
 *
 * Provisioning sets `statement_timeout = '10s'` on each app role, and that is
 * a courtesy rather than a control: `statement_timeout` is a `USERSET` GUC, so
 * tenant code holding the credential can `set statement_timeout = 0` on its
 * own connection and run unbounded SQL against the shared cluster. (The other
 * two settings do hold — `connection limit` is superuser-only to raise, and
 * `temp_file_limit` is `SUSET`, so a tenant may lower it and never raise it.)
 *
 * This is the enforceable half. The ceiling is deliberately far above the role
 * default: the 10s setting is what a well-behaved app should see, while this
 * exists only to stop a query that has escaped it, and killing a legitimate
 * slow migration would be the worse error. Matching on the role NAME is what
 * keeps it scoped — `app\_%` is the provisioned shape (`app_` + 16 hex), and
 * the platform's own connections authenticate as `postgres`, so no sweep of
 * this kind can reach them.
 */
const SWEEP_APP_DB_RUNAWAYS = `select pg_terminate_backend(pid)
from pg_stat_activity
where usename like 'app\\_%'
  and state = 'active'
  and query_start < now() - interval '60 seconds'`;

/**
 * Unreferenced deploy blobs.
 *
 * Blobs are content-addressed and immutable, and no referrer may delete one
 * (two agents with an identical file share a key), so nothing has ever deleted
 * them — every deploy that changes a byte writes a new ~8 MB worker bundle
 * that stays forever, including for agents since deleted and previews the
 * hourly sweep reaped. Mark-and-sweep is safe precisely BECAUSE the keys are
 * hashes: the live set is every `worker_hash` plus every value of
 * `client_files`, and a blob outside it is unreferenced by construction.
 *
 * Four things make this safe to run unattended, and each is load-bearing:
 *
 *   * **It refuses to run against an empty agents table.** Reading zero
 *     referenced hashes and deleting everything not in that set is the
 *     catastrophic failure mode, and it is one bad read away — a truncated
 *     table, a wrong database, a migration mid-flight. A platform with agents
 *     always has rows; one without has nothing worth reclaiming.
 *   * **A generous grace window.** A day is far past the retirement drain
 *     (10 min) and the signed-URL TTL (5 min), so an object cannot be swept
 *     while a spawn is still reaching for it. The cost of being slow here is
 *     storage; the cost of being fast is a failed deploy.
 *   * **Bounded per run.** 500 deletes an hour reclaims steadily without
 *     turning one sweep into a stampede against the Storage API.
 *   * **The delete goes through the Storage API, never `storage.objects`.**
 *     Deleting the row leaves the S3 object behind AND removes the only record
 *     that it exists — strictly worse than doing nothing. `pg_net` is how a
 *     SQL job calls an API, and it is fire-and-forget: a failed delete simply
 *     leaves the object for the next run to find, so the sweep is
 *     self-healing without any retry bookkeeping.
 *
 * Everything is guarded so a project without `pg_net`, without Vault, or
 * without the stored key no-ops rather than erroring hourly.
 */
function sweepBlobGc(storage: { url: string; bucket: string }): string {
  const base = storage.url.replace(/\/+$/, "");
  return `do $$
declare
  target record;
  storage_key text;
  live_agents bigint;
begin
  if to_regnamespace('net') is null or to_regclass('storage.objects') is null then
    return;
  end if;
  if to_regclass('vault.secrets') is null then
    return;
  end if;
  select decrypted_secret into storage_key from vault.decrypted_secrets
    where name = '${PLATFORM_STORAGE_KEY_SECRET}';
  if storage_key is null then
    return;
  end if;
  -- The empty-table guard. Never derive "unreferenced" from a set that may
  -- simply have failed to load.
  select count(*) into live_agents from aai_platform.agents;
  if live_agents = 0 then
    return;
  end if;
  for target in
    with referenced as (
      select worker_hash as hash from aai_platform.agents
      union
      select f.value from aai_platform.agents a, jsonb_each_text(a.client_files) f
    )
    select o.name
    from storage.objects o
    where o.bucket_id = '${storage.bucket}'
      and o.name like 'blobs/%'
      and o.created_at < now() - interval '1 day'
      and not exists (
        select 1 from referenced r where r.hash = substring(o.name from 7)
      )
    limit 500
  loop
    perform net.http_delete(
      url := '${base}/storage/v1/object/${storage.bucket}/' || target.name,
      headers := jsonb_build_object(
        'apikey', storage_key,
        'Authorization', 'Bearer ' || storage_key
      )
    );
  end loop;
end $$`;
}

/** Where deploy blobs live, when this deployment has object storage at all. */
export type PlatformCronStorage = {
  /** Supabase project URL (`https://<ref>.supabase.co`). */
  url: string;
  /** The deploy-artifact bucket. */
  bucket: string;
};

/**
 * The platform core's sweeps. The studio's rate-limit sweep rides along —
 * the table is shared infrastructure in `aai_platform`, and scheduling is
 * idempotent, so both services installing the same job set is correct.
 *
 * A FUNCTION rather than a constant because one job needs deployment config
 * (the Storage project + bucket the blob GC deletes through). Omitting
 * `storage` omits that job, and since boot DIFFS what it declares against
 * what the database has, a deployment without object storage actively
 * unschedules it rather than leaving it firing against a bucket name from a
 * previous config.
 *
 * Minutes are spread deliberately: the three hourly jobs sit at :07, :23 and
 * :51 so the busiest one (the orphan-preview sweep, which anti-joins every
 * workspace) never shares a minute with the blob GC's Storage fan-out.
 */
export function platformCronJobs(opts: { storage?: PlatformCronStorage } = {}): readonly CronJob[] {
  return [
    { name: "aai-sweep-rate-limits", schedule: "7 * * * *", command: SWEEP_RATE_LIMITS },
    { name: "aai-sweep-studio-sessions", schedule: "*/30 * * * *", command: SWEEP_STUDIO_SESSIONS },
    { name: "aai-sweep-orphan-previews", schedule: "23 * * * *", command: SWEEP_ORPHAN_PREVIEWS },
    {
      name: "aai-sweep-preview-archive",
      schedule: "41 3 * * *",
      command: SWEEP_PREVIEW_ARCHIVE,
    },
    { name: "aai-sweep-cron-history", schedule: "52 4 * * *", command: SWEEP_CRON_HISTORY },
    {
      name: "aai-maintain-agent-events",
      schedule: "34 * * * *",
      command: MAINTAIN_AGENT_EVENTS,
    },
    {
      name: "aai-sweep-app-db-runaways",
      schedule: "*/5 * * * *",
      command: SWEEP_APP_DB_RUNAWAYS,
    },
    ...(opts.storage
      ? [
          {
            name: "aai-sweep-blob-gc",
            schedule: "51 * * * *",
            command: sweepBlobGc(opts.storage),
          },
        ]
      : []),
  ];
}

/**
 * Every job name this module owns starts with this — so what the platform
 * schedules can be DIFFED against what the database has, and a retired job
 * needs no list of its own.
 *
 * The list it replaces was hand-maintained and permanent, and its only
 * failure mode was forgetting to add to it: `cron.schedule` upserts by name,
 * so deleting a job from {@link platformCronJobs} leaves a database that
 * already has it firing forever, against a table that may no longer exist.
 * The `guarded()` wrapper makes that harmless rather than noisy, which is
 * exactly why it went unnoticed — the job just sat in `cron.job` looking
 * current in every operator's listing. Diffing cannot be forgotten.
 */
/**
 * Broader than `aai-sweep-` on purpose: the prefix names jobs THIS PLATFORM
 * DECLARES, not jobs that happen to delete something. The first job that
 * wasn't a sweep (`aai-maintain-agent-events`, which creates partitions as
 * well as dropping them) would otherwise have been invisible to the diff
 * below — retiring it would leave it firing forever on every database that
 * already had it, which is the exact failure this mechanism exists to stop.
 */
const CRON_JOB_PREFIX = "aai-";

/**
 * Install (or update) the platform's jobs, and unschedule every `aai-*` job
 * the platform no longer declares. Runs at boot on the platform admin
 * connection; failures propagate to the caller, which logs loudly — a missing
 * sweep degrades to table growth, never to wrong answers.
 */
export async function schedulePlatformSweeps(
  sql: SqlExec,
  jobs: readonly CronJob[] = platformCronJobs(),
): Promise<void> {
  await sql("create extension if not exists pg_cron");
  for (const job of jobs) {
    await sql("select cron.schedule($1, $2, $3)", [job.name, job.schedule, job.command]);
  }
  const declared = new Set(jobs.map((job) => job.name));
  const existing = await sql("select jobname from cron.job where jobname like $1", [
    `${CRON_JOB_PREFIX}%`,
  ]);
  for (const row of existing) {
    const jobname = String(row.jobname);
    if (declared.has(jobname)) continue;
    // The `::text` cast picks the by-name overload over `unschedule(bigint)`.
    // Tolerated individually: another replica booting concurrently may have
    // unscheduled it between the read and here.
    await sql("select cron.unschedule($1::text)", [jobname]).catch(() => undefined);
  }
}
