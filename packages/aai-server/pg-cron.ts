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
 * {@link PLATFORM_CRON_JOBS} is the whole truth about what the platform runs.
 */

import type { SqlExec } from "./secret-store.ts";

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
          where w.doc->>'previewSlug' = a.slug
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

/** The platform core's sweeps. The studio's rate-limit sweep rides along —
 * the table is shared infrastructure in `aai_platform`, and scheduling is
 * idempotent, so both services installing the same job set is correct. */
export const PLATFORM_CRON_JOBS: readonly CronJob[] = [
  { name: "aai-sweep-rate-limits", schedule: "7 * * * *", command: SWEEP_RATE_LIMITS },
  { name: "aai-sweep-studio-sessions", schedule: "*/30 * * * *", command: SWEEP_STUDIO_SESSIONS },
  { name: "aai-sweep-orphan-previews", schedule: "23 * * * *", command: SWEEP_ORPHAN_PREVIEWS },
  {
    name: "aai-sweep-preview-archive",
    schedule: "41 3 * * *",
    command: SWEEP_PREVIEW_ARCHIVE,
  },
];

/**
 * Every job name this module owns starts with this — so what the platform
 * schedules can be DIFFED against what the database has, and a retired job
 * needs no list of its own.
 *
 * The list it replaces was hand-maintained and permanent, and its only
 * failure mode was forgetting to add to it: `cron.schedule` upserts by name,
 * so deleting a job from {@link PLATFORM_CRON_JOBS} leaves a database that
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
 */
export async function schedulePlatformSweeps(
  sql: SqlExec,
  jobs: readonly CronJob[] = PLATFORM_CRON_JOBS,
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
