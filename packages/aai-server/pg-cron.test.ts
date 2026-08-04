// Copyright 2026 the AAI authors. MIT license.

import { expect, test } from "vitest";
import { PLATFORM_CRON_JOBS, schedulePlatformSweeps } from "./pg-cron.ts";
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
  await schedulePlatformSweeps(sql);

  expect(calls[0]?.query).toBe("create extension if not exists pg_cron");
  const scheduled = calls.slice(1);
  expect(scheduled).toHaveLength(PLATFORM_CRON_JOBS.length);
  for (const [i, job] of PLATFORM_CRON_JOBS.entries()) {
    expect(scheduled[i]?.query).toBe("select cron.schedule($1, $2, $3)");
    expect(scheduled[i]?.params).toEqual([job.name, job.schedule, job.command]);
  }
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
  expect(command).toContain("'agent-env:' || slug");
  expect(command).toContain("'app-db:' || slug");
});

test("lock and rate-limit sweeps delete only expired rows", () => {
  const locks = PLATFORM_CRON_JOBS.find((j) => j.name === "aai-sweep-slug-locks");
  expect(locks?.command).toContain("expires_at <= now()");
  const limits = PLATFORM_CRON_JOBS.find((j) => j.name === "aai-sweep-rate-limits");
  expect(limits?.command).toContain("reset_at <= now()");
});
