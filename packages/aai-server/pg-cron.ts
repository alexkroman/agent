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
 *
 * **The BODIES live in `pg-cron-bodies.ts`** — the SQL, its `guarded()` wrapper
 * and the literal-safety assertions — split off along the seam the paragraph
 * above already draws between what a sweep DOES and when it runs. The blob GC is
 * a third file (`pg-cron-blob-gc.ts`), being a hundred lines of plpgsql where
 * every other body is a one-line `delete`. This file stays the import surface;
 * nothing else imports from either.
 */

import type { PlatformCronStorage } from "./pg-cron-blob-gc.ts";
import { sweepBlobGc } from "./pg-cron-blob-gc.ts";
import {
  SWEEP_CRON_HISTORY,
  SWEEP_ORPHAN_PREVIEWS,
  SWEEP_PREVIEW_ARCHIVE,
  SWEEP_RATE_LIMITS,
  SWEEP_SESSION_STATE,
  SWEEP_STUDIO_SESSIONS,
  SWEEP_UPLOAD_RECORDS,
  SWEEP_WORKFLOW_RUN_KEYS,
  SWEEP_WORKFLOW_RUNS,
} from "./pg-cron-bodies.ts";
import type { SqlExec } from "./secret-store.ts";

// Re-exported by NAME so `pg-cron.ts` stays the one import surface: this type is
// half of `platformCronJobs`'s signature, and a caller reading that signature
// should not have to learn where the sweep bodies live.
export type { PlatformCronStorage } from "./pg-cron-blob-gc.ts";

export type CronJob = {
  /** Unique job name — `cron.schedule` upserts by it. */
  name: string;
  /** Standard 5-field cron schedule, evaluated in the database's clock. */
  schedule: string;
  /** SQL the job runs. */
  command: string;
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
 * Minutes are spread deliberately: no two jobs share one, so the blob GC's
 * Storage fan-out never runs beside another sweep's scan.
 */
export function platformCronJobs(opts: { storage?: PlatformCronStorage } = {}): readonly CronJob[] {
  return [
    { name: "aai-sweep-rate-limits", schedule: "7 * * * *", command: SWEEP_RATE_LIMITS },
    { name: "aai-sweep-studio-sessions", schedule: "*/30 * * * *", command: SWEEP_STUDIO_SESSIONS },
    {
      name: "aai-sweep-preview-archive",
      schedule: "41 3 * * *",
      command: SWEEP_PREVIEW_ARCHIVE,
    },
    { name: "aai-sweep-cron-history", schedule: "52 4 * * *", command: SWEEP_CRON_HISTORY },
    // Back in pg_cron, where it started: with no per-app database to drop, a reap
    // is a Vault row and an agents row. Its own doc has why the move is safe and
    // what guards the duplicated delete path.
    {
      name: "aai-sweep-orphan-previews",
      schedule: "13 * * * *",
      command: SWEEP_ORPHAN_PREVIEWS,
    },
    // Session state a dead guest left behind IS swept from here again, and it is
    // one statement rather than one job per app. It used to live in each app's own
    // database, so the job had to be scheduled INTO that database at provisioning
    // time and its cost scaled with the number of tenants; the rows are in
    // `aai_platform.session_slots` / `session_events` now
    // (`platform-session-state.ts`), which one statement reaches.
    {
      name: "aai-sweep-session-state",
      schedule: "23 * * * *",
      command: SWEEP_SESSION_STATE,
    },
    // The other half of "a guest keeps nothing durable on disk": upload records are
    // the platform's now, so their expiry is too. Daily rather than hourly — the
    // window is seven days, so an hourly pass would scan for nothing 23 times out
    // of 24.
    {
      name: "aai-sweep-upload-records",
      schedule: "36 5 * * *",
      command: SWEEP_UPLOAD_RECORDS,
    },
    // The journal half of the same rule, and the one whose absence was paid for by
    // a query rather than by disk: see {@link SWEEP_WORKFLOW_RUNS}.
    //
    // HOURLY, where every other retention sweep here is daily, and the reason is
    // the ceiling rather than the freshness. One call deletes at most ten batches
    // — the cap that keeps its transaction short — so daily was 50,000 runs a day
    // against measured platform throughput of ~24 runs/second. Hourly turns that
    // into 1.2M a day, which is headroom rather than a race. The objection to
    // hourly for a 30-day window ("finds nothing 23 times out of 24") is answered
    // by `workflow_runs_terminal_idx`: a no-op call is one index probe.
    {
      name: "aai-sweep-workflow-runs",
      schedule: "17 * * * *",
      command: SWEEP_WORKFLOW_RUNS,
    },
    // The correlation-key index is the one child of a run the sweep above cannot
    // delete — see {@link SWEEP_WORKFLOW_RUN_KEYS} for why that table must not
    // reference `workflow_runs` and therefore cannot ride its CTE.
    //
    // Hourly like the run sweep, and at minute 43 because minutes here are spread
    // deliberately: it sits well after :17, so a key is collected in the same hour
    // its run is rather than waiting for the next pass, and it shares its minute
    // with nothing.
    {
      name: "aai-sweep-workflow-run-keys",
      schedule: "43 * * * *",
      command: SWEEP_WORKFLOW_RUN_KEYS,
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
export const CRON_JOB_PREFIX = "aai-sweep-";

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
        "unreferenced deploy blobs, archived queue jobs, runaway tenant queries) will " +
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
