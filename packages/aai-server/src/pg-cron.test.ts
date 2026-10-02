// Copyright 2026 the AAI authors. MIT license.

import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, test } from "vitest";
import { CRON_JOB_PREFIX, platformCronJobs, schedulePlatformSweeps } from "./pg-cron.ts";
import type { SqlExec } from "./sql-exec.ts";

/**
 * Capture every statement; `scheduled` is what `cron.job` already holds.
 *
 * `hasCron` answers the extension PROBE, because that probe is what decides
 * whether anything else runs at all — a fake that answered `[]` to every read
 * would make every test here exercise the missing-extension path.
 */
function captureSql(scheduled: string[] = [], hasCron = true) {
  const calls: { query: string; params?: unknown[] }[] = [];
  const sql: SqlExec = (query, params) => {
    calls.push({ query, ...omitUndefined({ params }) });
    if (query.includes("from pg_extension")) {
      return Promise.resolve(hasCron ? [{ ok: 1 }] : []);
    }
    if (query.includes("from cron.job")) {
      return Promise.resolve(scheduled.map((jobname) => ({ jobname })));
    }
    return Promise.resolve([]);
  };
  return { sql, calls };
}

test("verifies the extension then upserts every job by name", async () => {
  const { sql, calls } = captureSql();
  await schedulePlatformSweeps(sql, platformCronJobs());

  // A READ, not DDL. `create extension if not exists pg_cron` used to run here
  // and was redundant with the platform-schema migration, emitted a `42710`
  // NOTICE on every boot, and had every replica altering the database on the
  // admin connection to learn something it could ask.
  expect(calls[0]?.query).toBe("select 1 as ok from pg_extension where extname = 'pg_cron'");
  expect(calls.some((c) => c.query.startsWith("create extension"))).toBe(false);
  const scheduled = calls.slice(1, 1 + platformCronJobs().length);
  for (const [i, job] of platformCronJobs().entries()) {
    expect(scheduled[i]?.query).toBe("select cron.schedule($1, $2, $3)");
    expect(scheduled[i]?.params).toEqual([job.name, job.schedule, job.command]);
  }
});

test("a database with no pg_cron is reported, and nothing is scheduled", async () => {
  // The caller treats this as non-fatal, so the value of throwing is the
  // SENTENCE: it names what will not happen and how to fix it, where the old
  // path silently altered the database instead.
  const { sql, calls } = captureSql([], false);
  await expect(schedulePlatformSweeps(sql, platformCronJobs())).rejects.toThrow(
    /pg_cron is not installed.*will\s+not run/s,
  );
  expect(calls.some((c) => c.query.includes("cron.schedule"))).toBe(false);
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
  const guarded = platformCronJobs().filter((job) => job.command.includes("to_regclass"));
  expect(guarded.map((job) => job.name).sort()).toEqual(["aai-sweep-preview-archive"]);
});

/**
 * The orphan-preview reap is NOT here any more: it deprovisions through the
 * Management API, which SQL cannot call, so it runs in the server
 * (`orphan-previews.ts`, and its own spec). What used to be asserted about its
 * job body — the suffix, the workspace anti-join, the age floor, the dblink
 * drops and their ordering — moved with it, and the parts that were only true of
 * a cron body (interpolated constants, an exception handler swallowing a failed
 * drop) are gone rather than restated.
 */
test("every job name carries the prefix boot diffs on", () => {
  // A job outside the prefix can never be unscheduled by the retirement diff,
  // so it would fire forever on any database that once had it.
  for (const job of platformCronJobs({ storage: { url: "https://p.supabase.co", bucket: "b" } })) {
    expect.soft(job.name, `${job.name} is outside the aai-sweep- namespace`).toMatch(/^aai-sweep-/);
  }
});

/**
 * `statement_timeout` is a USERSET GUC, so the 10s the app role is provisioned
 * with is advisory — tenant code holding the credential can simply turn it
 * off. This is the half that cannot be overridden from a tenant connection.
 */

describe("blob GC", () => {
  // What the command SAYS is `pg-cron-blob-gc.test.ts`'s; this is whether it is scheduled.
  const withStorage = () =>
    platformCronJobs({ storage: { url: "https://proj.supabase.co", bucket: "aai-blobs" } });

  test("is declared only when object storage is configured", () => {
    // Boot DIFFS declared jobs against the database, so omitting it here is
    // what unschedules a stale one rather than leaving it firing against a
    // bucket name from a previous configuration.
    expect(withStorage().map((j) => j.name)).toContain("aai-sweep-blob-gc");
    expect(platformCronJobs().map((j) => j.name)).not.toContain("aai-sweep-blob-gc");
  });
});

/**
 * Session state is swept by ONE platform job again, and the round trip is the
 * interesting part.
 *
 * It began as a platform job iterating this database's catalog for every
 * `app_<hex>` schema. Per-app DATABASES broke that — a catalog is per-database, so
 * the job found nothing — and it moved into each app's own database at provisioning
 * time, which bought a per-app job name, a stagger across the day, and an
 * identifier-quoting rule, none of which anything now needs.
 *
 * Removing tenant databases put the tables back in `aai_platform`, so the sweep is
 * one statement over two ordinary tables and the cause that drove it out cannot
 * recur: there is no per-tenant schema to enumerate.
 */
describe("the session-state sweep", () => {
  const sweep = () => platformCronJobs().find((j) => j.name === "aai-sweep-session-state");

  test("is a platform job, so boot's diffing owns its lifetime", () => {
    // Being in this list is what makes it survive replica churn AND what makes a
    // renamed job get unscheduled rather than left firing. A per-app job was
    // declared nowhere in it — see the module doc.
    expect(sweep()).toBeDefined();
    expect(sweep()?.name.startsWith(CRON_JOB_PREFIX)).toBe(true);
  });
});
