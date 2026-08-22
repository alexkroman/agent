// Copyright 2026 the AAI authors. MIT license.
/**
 * The pg_cron sweep for session state whose guest is GONE — one job per app,
 * running INSIDE that app's own database.
 *
 * ## What it is for
 *
 * A session's slot state is durable (`aai/host/session-state-store.ts`), so a
 * crash or a redeploy no longer costs a caller their cart. The guest reclaims its
 * own rows after the resume grace window (`aai/host/session-state-sweeps.ts`) —
 * and by construction it cannot reclaim the case durability exists for: an agent
 * guest SELF-EXITS on idle, so rows belonging to a session nobody resumed are
 * left behind by a process that is no longer running.
 *
 * The retention window is far above the guest's own
 * {@link SESSION_RESUME_GRACE_MS} (120 s), because this is the backstop for a
 * dead guest rather than a second opinion about a live one — and a row deleted
 * while a caller was still reconnecting is the one failure worth avoiding, being
 * indistinguishable to them from the loss the whole mechanism removes.
 *
 * ## Why it is one job PER APP now
 *
 * This was a single platform-database job iterating `information_schema.tables`
 * for every `app_<hex>` schema. Per-app DATABASES (see `app-database.ts`) make
 * that statement find nothing at all: the catalog is per-database, and the
 * platform's connection cannot see a tenant's tables however they are qualified.
 *
 * `cron.schedule_in_database` is the native answer, and it is available here —
 * pg_cron 1.6.4, callable by Supabase's non-superuser `postgres` role, and it
 * really fires into a database whose `CONNECT` is revoked from `PUBLIC` (the admin
 * OWNS the database, so it has implicit `CONNECT`). Verified end to end on the
 * local stack. The job runs entirely within one tenant's database, needs no
 * cross-database mechanism, no `dblink`, and no replica to be alive — which is
 * strictly more reliable than a server-side timer and was the reason to keep this
 * in pg_cron at all.
 *
 * The statement is correspondingly simpler: no schema iteration, no `format(%I)`
 * identifier assertion, and no per-tenant exception block. A tenant's wedged table
 * can only cost that tenant its own sweep, because the job IS that tenant's.
 *
 * ## The prefix is disjoint from the platform's, and that is load-bearing
 *
 * `schedulePlatformSweeps` DIFFS: every `aai-sweep-*` job in `cron.job` that
 * `platformCronJobs()` no longer declares is unscheduled at boot. Per-app jobs are
 * declared nowhere in that list — they belong to a provision, not to a release —
 * so a name matching that prefix would be silently unscheduled by the next boot,
 * and session state would then accumulate forever with nothing reporting it.
 * Hence {@link APP_CRON_JOB_PREFIX}, and `pg-cron.test.ts` asserts the two cannot
 * collide.
 */

import { SESSION_EVENT_TABLE, SESSION_STATE_TABLE } from "@alexkroman1/aai-runtime/internal";
import type { SqlExec } from "./secret-store.ts";

/**
 * How long a row outlives the last write to it.
 *
 * Two days rather than hours: the cost of keeping one is a few KB in the
 * tenant's own database, and the cost of dropping one early is a caller who
 * reconnects to an agent that has forgotten them — which is the failure this
 * whole path exists to remove, arriving by a new route.
 */
const RETENTION = "2 days";

/**
 * Prefix for every job scheduled INTO an app's own database.
 *
 * Deliberately not `aai-sweep-` — see the module doc. It is still prefixed at all
 * so that "what has this platform scheduled for this app" is one `like` query,
 * which is what a deprovision needs.
 */
export const APP_CRON_JOB_PREFIX = "aai-app-";

/** The per-app session-state job's name. `id` is an `app_<hex>` identifier. */
export function appSessionStateJobName(id: string): string {
  return `${APP_CRON_JOB_PREFIX}session-state-${id}`;
}

/**
 * The sweep, as it runs inside one app's database.
 *
 * Two statements in one command, because pg_cron takes a single command. Both
 * tables are swept: a session's durable footprint is its slot values AND its
 * retained event log (`session-state-store.ts` is one store with two consumers),
 * so reclaiming one would leave the other growing without bound in a database
 * `appDatabaseUsage` reports to the AUTHOR as their own usage.
 *
 * They age by different columns, which is worth stating rather than looking like
 * an inconsistency: a slot row is UPSERTED, so `updated_at` is maintained and is
 * genuinely the last write to it, while an event row is append-only and never
 * rewritten, so `created_at` is the only time it has. Both are therefore "when
 * this row last meant anything".
 *
 * `if exists` on neither: the tables come WITH the database
 * (`provisionAppDatabase` applies `sessionStateDdl`), so their absence is a real
 * fault worth seeing in `cron.job_run_details` rather than one to paper over.
 *
 * @internal
 */
export const SWEEP_APP_SESSION_STATE =
  `delete from public.${SESSION_STATE_TABLE} where updated_at < now() - interval '${RETENTION}'; ` +
  `delete from public.${SESSION_EVENT_TABLE} where created_at < now() - interval '${RETENTION}'`;

/**
 * A daily schedule STAGGERED by the app's identifier.
 *
 * Every app on a cluster sharing one minute is a thundering herd against a
 * t3a.micro's connection budget — 50 apps' sweeps at 05:17 is 50 concurrent
 * background connections. The identifier is a hex digest, so slicing it gives a
 * stable, uniformly distributed slot: the same app always sweeps at the same
 * time (so a run is findable in `cron.job_run_details`) and no two adjacent
 * provisions collide.
 */
export function appSweepSchedule(id: string): string {
  const hex = id.slice("app_".length);
  const minute = Number.parseInt(hex.slice(0, 4), 16) % 60;
  const hour = Number.parseInt(hex.slice(4, 8), 16) % 24;
  return `${minute} ${hour} * * *`;
}

/**
 * Schedule the per-app jobs that run INSIDE the app's own database.
 *
 * `cron.schedule_in_database` rather than a platform-database statement, because
 * the catalog and the tables are per-database now — see `_session-state-sweep.ts`
 * for why this is pg_cron rather than a server-side timer, and why its job-name
 * prefix must stay disjoint from `schedulePlatformSweeps`'s.
 *
 * The `username` argument is left at its default (the current role), so the job
 * runs as the platform admin — which OWNS the app database and therefore holds
 * `CONNECT` on it even though `PUBLIC` does not.
 */
export async function scheduleAppSweeps(sql: SqlExec, id: string): Promise<void> {
  await sql("select cron.schedule_in_database($1, $2, $3, $4)", [
    appSessionStateJobName(id),
    appSweepSchedule(id),
    SWEEP_APP_SESSION_STATE,
    id,
  ]);
}

/**
 * Unschedule every job this platform scheduled into one app's database.
 *
 * Must run BEFORE the database is dropped: a cron job naming a database that no
 * longer exists does not clean itself up, it fails on every tick forever and
 * fills `cron.job_run_details` — which is the table `aai-sweep-cron-history`
 * exists to keep small.
 *
 * Tolerant of every failure, because it runs on the deprovision path: pg_cron may
 * be absent, and a job may already be gone. What must not happen is a delete
 * failing over its janitorial bookkeeping.
 */
export async function unscheduleAppSweeps(sql: SqlExec, id: string): Promise<void> {
  const jobs = await sql("select jobname from cron.job where jobname like $1", [
    `${APP_CRON_JOB_PREFIX}%${id}`,
  ]).catch(() => []);
  for (const row of jobs) {
    // The `::text` cast picks the by-name overload over `unschedule(bigint)`.
    await sql("select cron.unschedule($1::text)", [String(row.jobname)]).catch(() => undefined);
  }
}
