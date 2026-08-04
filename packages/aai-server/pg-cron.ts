// Copyright 2026 the AAI authors. MIT license.
/**
 * Janitorial sweeps as pg_cron jobs — scheduled in the platform's Supabase
 * Postgres, not in-process. A scheduled database job survives replica churn
 * by construction, runs exactly once platform-wide instead of once per
 * replica, and replaces the in-process sweepers (the rate limiter's
 * piggybacked delete) and the "expired rows are ignored, never removed"
 * posture of the lock lease table.
 *
 * Every job body is a plpgsql DO block that first checks `to_regclass` for
 * the table it sweeps: the platform tables are created lazily by their
 * stores, so on a fresh database a job can fire before its table exists —
 * plpgsql only plans a statement when the branch is reached, so the guard
 * makes that a no-op instead of an hourly error.
 *
 * `cron.schedule(name, …)` upserts by job name, so re-running the setup on
 * every boot is idempotent and a changed schedule or command takes effect on
 * the next deploy.
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

/** Wrap a sweep in a table-existence guard (see module doc). */
function guarded(table: string, body: string): string {
  return `do $$
begin
  if to_regclass('${table}') is not null then
    ${body};
  end if;
end $$`;
}

/**
 * Expired slug-lock leases. `ACQUIRE_SQL` (platform-lock.ts) already treats
 * an expired row as free, so this is dead-row hygiene, not correctness.
 */
const SWEEP_SLUG_LOCKS = guarded(
  "aai_platform.slug_locks",
  "delete from aai_platform.slug_locks where expires_at <= now()",
);

/**
 * Expired rate-limit windows. A live scope reuses its row in place
 * (studio-rate-limit.ts), so an expired row is only read again to be
 * overwritten — deleting it is equivalent and keeps the table proportional
 * to recently active scopes.
 */
const SWEEP_RATE_LIMITS = guarded(
  "aai_platform.studio_rate_limits",
  "delete from aai_platform.studio_rate_limits where reset_at <= now()",
);

/**
 * Orphaned preview agents: `<project>-preview` deploys whose studio project
 * was deleted (project deletion removes the workspace and chat rows but the
 * preview agent — deployed through the standard deploy path — has no other
 * reaper). Matched by the workspace rows' `previewSlug` back-reference, with
 * an age floor so a preview whose workspace stamp hasn't landed yet (the
 * deploy returns before `previewSlug` is written) is never reaped mid-birth.
 * The CTE also removes the slug's Vault secrets (`agent-env:`/`app-db:`);
 * content-addressed blobs are accepted orphans, as everywhere else.
 *
 * The `-preview` suffix is therefore studio-owned: a CLI deploy that claims
 * a `*-preview` slug with no workspace referencing it will be swept.
 */
const SWEEP_ORPHAN_PREVIEWS = `do $$
begin
  if to_regclass('aai_platform.agents') is null
    or to_regclass('aai_platform.studio_workspaces') is null
    or to_regclass('vault.secrets') is null then
    return;
  end if;
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
  delete from vault.secrets s
  where s.name in (
    select 'agent-env:' || slug from deleted
    union all
    select 'app-db:' || slug from deleted
  );
end $$`;

/**
 * Expired sandbox-registry leases (see sandbox-registry.ts). Live owners
 * renew every heartbeat and unregister on detach; expired rows are the
 * residue of crashed replicas, already invisible to `listPeers`.
 */
const SWEEP_SANDBOX_REGISTRY = guarded(
  "aai_platform.sandbox_registry",
  "delete from aai_platform.sandbox_registry where expires_at <= now()",
);

/** The platform core's sweeps. The studio's rate-limit sweep rides along —
 * the table is shared infrastructure in `aai_platform`, and scheduling is
 * idempotent, so both services installing the same job set is correct. */
export const PLATFORM_CRON_JOBS: readonly CronJob[] = [
  { name: "aai-sweep-slug-locks", schedule: "*/30 * * * *", command: SWEEP_SLUG_LOCKS },
  { name: "aai-sweep-rate-limits", schedule: "7 * * * *", command: SWEEP_RATE_LIMITS },
  { name: "aai-sweep-orphan-previews", schedule: "23 * * * *", command: SWEEP_ORPHAN_PREVIEWS },
  { name: "aai-sweep-sandbox-registry", schedule: "*/30 * * * *", command: SWEEP_SANDBOX_REGISTRY },
];

/**
 * Install (or update) the sweep jobs. Runs at boot on the platform admin
 * connection; failures propagate to the caller, which logs loudly — a
 * missing sweep degrades to table growth, never to wrong answers.
 */
export async function schedulePlatformSweeps(
  sql: SqlExec,
  jobs: readonly CronJob[] = PLATFORM_CRON_JOBS,
): Promise<void> {
  await sql("create extension if not exists pg_cron");
  for (const job of jobs) {
    await sql("select cron.schedule($1, $2, $3)", [job.name, job.schedule, job.command]);
  }
}
