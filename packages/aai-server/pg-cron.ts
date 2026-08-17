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
 * unschedules every `aai-sweep-*` job the code no longer declares, so
 * {@link platformCronJobs} is the whole truth about what the platform runs.
 */

import { PREVIEW_SLUG_SUFFIX } from "@alexkroman1/aai/utils";
import { SWEEP_SESSION_STATE } from "./_session-state-sweep.ts";
import {
  AGENT_ENV_SECRET_PREFIX,
  APP_DB_SECRET_PREFIX,
  PLATFORM_STORAGE_KEY_SECRET,
  type SqlExec,
} from "./secret-store.ts";

/**
 * Refuse a constant that cannot be interpolated into these sweep bodies.
 *
 * Three ways an innocuous constant change would break the SQL silently: a `'`
 * would close the literal it sits in, and `%` or `_` are LIKE WILDCARDS — so a
 * suffix that grew one would start matching slugs the sweep must not delete,
 * which is a deleting sweep given a wider net with no error anywhere. Today's
 * values are plain, so this only ever fires at boot for a change that has to be
 * thought about (an `escape` clause, or a `right(slug, n) =` rewrite).
 */
function assertSqlLiteralSafe(value: string, name: string): string {
  if (/['%_\\]/.test(value)) {
    throw new Error(
      `${name} = ${JSON.stringify(value)} cannot be interpolated into the pg_cron sweeps: ` +
        "a quote would close the literal, and % / _ / \\ are LIKE wildcards.",
    );
  }
  return value;
}

for (const [name, value] of [
  ["PREVIEW_SLUG_SUFFIX", PREVIEW_SLUG_SUFFIX],
  ["AGENT_ENV_SECRET_PREFIX", AGENT_ENV_SECRET_PREFIX],
  ["APP_DB_SECRET_PREFIX", APP_DB_SECRET_PREFIX],
] as const) {
  assertSqlLiteralSafe(value, name);
}

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
  -- The suffix and the two Vault prefixes below are INTERPOLATED from the
  -- constants that define them (PREVIEW_SLUG_SUFFIX in the SDK's slug contract,
  -- AGENT_ENV_SECRET_PREFIX/APP_DB_SECRET_PREFIX in secret-store.ts). They were
  -- literals, which is the one shape this repo already calls out as silent data
  -- loss: three independent things key off the suffix, and a sweep whose
  -- prefixes have drifted from the writer's deletes nothing while reporting
  -- nothing. assertSqlLiteralSafe above is what makes putting them in a
  -- literal (and the suffix in a LIKE) safe rather than assumed.
  -- Only vault.secrets needs guarding: the aai_platform tables come from
  -- migrations, but Vault belongs to Supabase and may not be provisioned.
  if to_regclass('vault.secrets') is null then
    return;
  end if;
  for target in
    with deleted as (
      delete from aai_platform.agents a
      where a.slug like '%${PREVIEW_SLUG_SUFFIX}'
        and a.updated_at < now() - interval '1 hour'
        and not exists (
          select 1 from aai_platform.studio_workspaces w
          where w.preview_slug = a.slug
        )
      returning slug
    )
    select d.slug,
      (select s.decrypted_secret from vault.decrypted_secrets s
       where s.name = '${APP_DB_SECRET_PREFIX}' || d.slug) as app_db_meta
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
    where s.name in ('${AGENT_ENV_SECRET_PREFIX}' || target.slug,
                     '${APP_DB_SECRET_PREFIX}' || target.slug);
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
 * workspace) never shares a minute with the blob GC's Storage fan-out. The daily
 * ones are spread for the same reason — the session-state sweep runs one delete
 * per app schema, so it stays off the blob GC's minute and the cron history's.
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
      name: "aai-sweep-app-db-runaways",
      schedule: "*/5 * * * *",
      command: SWEEP_APP_DB_RUNAWAYS,
    },
    // Session state a dead guest left behind — `_session-state-sweep.ts` carries
    // the argument, including why this is not the wake sweep's reader.
    { name: "aai-sweep-session-state", schedule: "17 5 * * *", command: SWEEP_SESSION_STATE },
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
const CRON_JOB_PREFIX = "aai-sweep-";

/**
 * Install (or update) the sweep jobs, and unschedule every `aai-sweep-*` job
 * the platform no longer declares. Runs at boot on the platform admin
 * connection; failures propagate to the caller, which logs loudly — a missing
 * sweep degrades to table growth, never to wrong answers.
 *
 * **It VERIFIES pg_cron rather than creating it**, the same way
 * `ensurePlatformTables` verifies a CLI-built database. `create extension if not
 * exists pg_cron` used to run here, and it was three things at once: redundant
 * (the platform-schema migration declares it, and migrations are applied before
 * any code runs), noisy (Postgres answers an already-installed extension with a
 * `42710` NOTICE, which postgres.js surfaces — a warning object on every single
 * boot, in a log where a real NOTICE then reads as routine), and DDL executed by
 * every replica on the admin connection, which is exactly the class the migration
 * consolidation removed. An absent extension now reports ONE sentence naming what
 * will not happen, which is strictly more use than a stack of notices: the caller
 * treats a scheduling failure as non-fatal, so the database is left as it is
 * rather than being altered by a process that only wanted to read it.
 */
export async function schedulePlatformSweeps(
  sql: SqlExec,
  jobs: readonly CronJob[] = platformCronJobs(),
): Promise<void> {
  const [installed] = await sql("select 1 as ok from pg_extension where extname = 'pg_cron'");
  if (!installed) {
    throw new Error(
      "pg_cron is not installed, so the janitorial sweeps (dead rate-limit windows, " +
        "orphaned -preview agents, unreferenced deploy blobs, runaway tenant queries) will " +
        "not run. It is declared in supabase/migrations/*_platform_schema.sql — apply " +
        "migrations against this database (`supabase db push`, or `supabase start` locally).",
    );
  }
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
