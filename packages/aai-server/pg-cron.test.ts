// Copyright 2026 the AAI authors. MIT license.

import { expect, test } from "vitest";
import { PLATFORM_CRON_JOBS, RETIRED_CRON_JOBS, schedulePlatformSweeps } from "./pg-cron.ts";
import type { SqlExec } from "./secret-store.ts";

function captureSql() {
  const calls: { query: string; params?: unknown[] }[] = [];
  const sql: SqlExec = (query, params) => {
    calls.push({ query, ...(params && { params }) });
    return Promise.resolve([]);
  };
  return { sql, calls };
}

test("installs the extension then upserts every job by name", async () => {
  const { sql, calls } = captureSql();
  await schedulePlatformSweeps(sql, PLATFORM_CRON_JOBS, []);

  expect(calls[0]?.query).toBe("create extension if not exists pg_cron");
  const scheduled = calls.slice(1);
  expect(scheduled).toHaveLength(PLATFORM_CRON_JOBS.length);
  for (const [i, job] of PLATFORM_CRON_JOBS.entries()) {
    expect(scheduled[i]?.query).toBe("select cron.schedule($1, $2, $3)");
    expect(scheduled[i]?.params).toEqual([job.name, job.schedule, job.command]);
  }
});

/**
 * `cron.schedule` upserts by name, so deleting a job from the list leaves a
 * database that already has it firing forever — and `guarded()` makes that
 * silent. Retirement has to be an explicit statement.
 */
test("unschedules retired jobs, tolerating the ones already gone", async () => {
  const { sql, calls } = captureSql();
  const failing: SqlExec = (query, params) =>
    query.includes("unschedule")
      ? Promise.reject(new Error(`could not find job ${String(params?.[0])}`))
      : sql(query, params);
  await expect(
    schedulePlatformSweeps(failing, [], ["aai-sweep-slug-locks", "aai-sweep-gone"]),
  ).resolves.toBeUndefined();
  expect(calls.filter((c) => c.query.includes("unschedule"))).toHaveLength(0);

  const fresh = captureSql();
  await schedulePlatformSweeps(fresh.sql, [], ["aai-sweep-slug-locks"]);
  expect(fresh.calls.at(-1)).toEqual({
    query: "select cron.unschedule($1::text)",
    params: ["aai-sweep-slug-locks"],
  });
});

test("the retired list names no job that is still scheduled", () => {
  const live = new Set(PLATFORM_CRON_JOBS.map((j) => j.name));
  for (const name of RETIRED_CRON_JOBS) expect(live.has(name)).toBe(false);
});

test("every sweep body is guarded on its table's existence", () => {
  for (const job of PLATFORM_CRON_JOBS) {
    // The platform tables are created lazily by their stores; an unguarded
    // job errors on schedule until the table exists.
    expect(job.command).toContain("to_regclass");
  }
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
