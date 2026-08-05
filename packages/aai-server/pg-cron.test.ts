// Copyright 2026 the AAI authors. MIT license.

import { expect, test } from "vitest";
import { PLATFORM_CRON_JOBS, schedulePlatformSweeps } from "./pg-cron.ts";
import type { SqlExec } from "./secret-store.ts";

/** Capture every statement; `scheduled` is what `cron.job` already holds. */
function captureSql(scheduled: string[] = []) {
  const calls: { query: string; params?: unknown[] }[] = [];
  const sql: SqlExec = (query, params) => {
    calls.push({ query, ...(params && { params }) });
    if (query.includes("from cron.job")) {
      return Promise.resolve(scheduled.map((jobname) => ({ jobname })));
    }
    return Promise.resolve([]);
  };
  return { sql, calls };
}

test("installs the extension then upserts every job by name", async () => {
  const { sql, calls } = captureSql();
  await schedulePlatformSweeps(sql, PLATFORM_CRON_JOBS);

  expect(calls[0]?.query).toBe("create extension if not exists pg_cron");
  const scheduled = calls.slice(1, 1 + PLATFORM_CRON_JOBS.length);
  for (const [i, job] of PLATFORM_CRON_JOBS.entries()) {
    expect(scheduled[i]?.query).toBe("select cron.schedule($1, $2, $3)");
    expect(scheduled[i]?.params).toEqual([job.name, job.schedule, job.command]);
  }
});

/**
 * `cron.schedule` upserts by name, so deleting a job from the list leaves a
 * database that already has it firing forever — and `guarded()` makes that
 * silent. Boot therefore diffs what it declares against what `cron.job`
 * holds, so retirement cannot be forgotten.
 */
test("unschedules every aai-sweep job it no longer declares", async () => {
  const { sql, calls } = captureSql(["aai-sweep-rate-limits", "aai-sweep-slug-locks"]);
  await schedulePlatformSweeps(sql, [
    { name: "aai-sweep-rate-limits", schedule: "7 * * * *", command: "select 1" },
  ]);
  expect(calls.filter((c) => c.query.includes("unschedule"))).toEqual([
    { query: "select cron.unschedule($1::text)", params: ["aai-sweep-slug-locks"] },
  ]);
});

test("only looks at jobs it owns", async () => {
  const { sql, calls } = captureSql();
  await schedulePlatformSweeps(sql, []);
  const read = calls.find((c) => c.query.includes("from cron.job"));
  // A prefix match, so a job some other tenant of this database scheduled is
  // never in scope for unscheduling.
  expect(read?.params).toEqual(["aai-sweep-%"]);
});

/** A concurrent boot may have unscheduled it between the read and the call. */
test("tolerates an unschedule that finds nothing", async () => {
  const { sql } = captureSql(["aai-sweep-gone"]);
  const failing: SqlExec = (query, params) =>
    query.includes("unschedule")
      ? Promise.reject(new Error(`could not find job ${String(params?.[0])}`))
      : sql(query, params);
  await expect(schedulePlatformSweeps(failing, [])).resolves.toBeUndefined();
});

/**
 * The platform tables come from migrations now, applied before any code runs,
 * so a sweep over one needs no existence guard. The exceptions are tables
 * migrations do not own: pgmq creates `a_<queue>` on the first archive, and
 * `vault.secrets` belongs to Supabase.
 */
test("only sweeps over tables migrations do not own are guarded", () => {
  const guarded = PLATFORM_CRON_JOBS.filter((job) => job.command.includes("to_regclass"));
  expect(guarded.map((job) => job.name).sort()).toEqual([
    "aai-sweep-orphan-previews",
    "aai-sweep-preview-archive",
  ]);
});

test("the orphan-preview sweep only reaps unreferenced, aged preview slugs", () => {
  const orphans = PLATFORM_CRON_JOBS.find((j) => j.name === "aai-sweep-orphan-previews");
  expect(orphans).toBeDefined();
  const command = orphans?.command ?? "";
  // Only `-preview` slugs, never production agents.
  expect(command).toContain("like '%-preview'");
  // The workspace back-reference is what marks a preview as live.
  expect(command).toContain("doc->>'previewSlug'");
  // Age floor: a preview whose workspace stamp hasn't landed yet is not an
  // orphan.
  expect(command).toContain("interval '1 hour'");
  // The slug's Vault secrets go with the row.
  expect(command).toContain("'agent-env:' || target.slug");
  expect(command).toContain("'app-db:' || target.slug");
});

test("the orphan-preview sweep deprovisions the app database like the delete route", () => {
  const orphans = PLATFORM_CRON_JOBS.find((j) => j.name === "aai-sweep-orphan-previews");
  const command = orphans?.command ?? "";
  // Schema + role go the way deprovisionAppDatabase drops them…
  expect(command).toContain("drop schema if exists %I cascade");
  expect(command).toContain("drop role if exists %I");
  // …named by the stored app-db meta, shape-asserted like app-database.ts
  // so a corrupt meta can never steer the drops at an arbitrary identifier.
  expect(command).toContain("->>'role'");
  expect(command).toContain("'^app_[a-f0-9]{16}$'");
  // Best-effort: a failed drop must not abort the sweep (or the row delete).
  expect(command).toContain("exception when others");
});

test("lease sweeps delete only expired rows", () => {
  const limits = PLATFORM_CRON_JOBS.find((j) => j.name === "aai-sweep-rate-limits");
  expect(limits?.command).toContain("reset_at <= now()");
});
