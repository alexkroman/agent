// Copyright 2026 the AAI authors. MIT license.

import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, test } from "vitest";
import { CRON_JOB_PREFIX, platformCronJobs, schedulePlatformSweeps } from "./pg-cron.ts";
import { SESSION_STATE_RETENTION } from "./platform-session-state.ts";
import type { SqlExec } from "./secret-store.ts";

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
test("lease sweeps delete only expired rows", () => {
  const limits = platformCronJobs().find((j) => j.name === "aai-sweep-rate-limits");
  expect(limits?.command).toContain("reset_at <= now()");
});

test("every job name carries the prefix boot diffs on", () => {
  // A job outside the prefix can never be unscheduled by the retirement diff,
  // so it would fire forever on any database that once had it.
  for (const job of platformCronJobs({ storage: { url: "https://p.supabase.co", bucket: "b" } })) {
    expect.soft(job.name, `${job.name} is outside the aai-sweep- namespace`).toMatch(/^aai-sweep-/);
  }
});

test("the cron-history sweep prunes pg_cron's own run log", () => {
  // The one table the sweeps themselves grow. Supabase prunes nothing.
  const history = platformCronJobs().find((j) => j.name === "aai-sweep-cron-history");
  expect(history?.command).toContain("delete from cron.job_run_details");
  expect(history?.command).toContain("interval '7 days'");
});

/**
 * `statement_timeout` is a USERSET GUC, so the 10s the app role is provisioned
 * with is advisory — tenant code holding the credential can simply turn it
 * off. This is the half that cannot be overridden from a tenant connection.
 */

describe("blob GC", () => {
  const withStorage = () =>
    platformCronJobs({ storage: { url: "https://proj.supabase.co", bucket: "aai-blobs" } });
  const command = () => withStorage().find((j) => j.name === "aai-sweep-blob-gc")?.command ?? "";

  test("is declared only when object storage is configured", () => {
    // Boot DIFFS declared jobs against the database, so omitting it here is
    // what unschedules a stale one rather than leaving it firing against a
    // bucket name from a previous configuration.
    expect(withStorage().map((j) => j.name)).toContain("aai-sweep-blob-gc");
    expect(platformCronJobs().map((j) => j.name)).not.toContain("aai-sweep-blob-gc");
  });

  test("refuses to run against an empty agents table", () => {
    // The catastrophic failure: read zero referenced hashes, conclude every
    // blob is garbage. One bad read away, and unrecoverable.
    expect(command()).toContain("select count(*) into live_agents from aai_platform.agents");
    expect(command()).toContain("if live_agents = 0 then");
  });

  test("treats both worker and client blobs as referenced", () => {
    // client_files is path→hash, so the live set needs its VALUES; taking its
    // keys would mark every client asset unreferenced.
    expect(command()).toContain("select worker_hash as hash from aai_platform.agents");
    expect(command()).toContain("jsonb_each_text(a.client_files) f");
    expect(command()).toContain("select f.value");
  });

  test("only considers aged blobs, and bounds each run", () => {
    // Comfortably past the retirement drain (10 min) and the signed worker
    // URL's TTL (5 min), so a spawn can never be reaching for what it deletes.
    expect(command()).toContain("interval '1 day'");
    expect(command()).toContain("like 'blobs/%'");
    expect(command()).toContain("limit 500");
  });

  test("deletes through the Storage API, never storage.objects", () => {
    // Deleting the row orphans the S3 object AND destroys the only record it
    // exists — strictly worse than leaving it.
    expect(command()).toContain("net.http_delete");
    expect(command()).toContain("https://proj.supabase.co/storage/v1/object/aai-blobs/");
    expect(command()).not.toContain("delete from storage.objects");
    // The credential comes from Vault, never the job command.
    expect(command()).toContain("platform:storage-key");
    expect(command()).not.toContain("sb_secret_");
  });

  test("no-ops rather than erroring where its dependencies are absent", () => {
    for (const guard of [
      "to_regnamespace('net')",
      "to_regclass('storage.objects')",
      "to_regclass('vault.secrets')",
    ]) {
      expect.soft(command(), `${guard} is unguarded`).toContain(guard);
    }
  });

  /**
   * The uploads arm — the half that reclaims an uploaded BYTE, which nothing in
   * this platform did until it existed.
   *
   * These are text assertions, and text is all they can be: `pg-cron.test.ts`
   * reads the command as a string. What the arm actually SELECTS is asserted
   * against a real Postgres in `pg-cron.scenario.test.ts`, including the negative
   * that matters (an in-flight upload with no record yet is not deleted) and an
   * A/B on each guard below. These exist so a guard that is DELETED fails a test
   * somebody runs in under a second, without a database.
   */
  describe("the uploads arm", () => {
    test("refuses to run against an empty workflow_uploads table", () => {
      // The blobs arm's empty-agents guard, one table over and for the identical
      // reason: an upload RECORD is the referrer here, so a table that failed to
      // load would condemn every recording in a bucket shared by every tenant.
      expect(command()).toContain(
        "select count(*) into live_uploads from aai_platform.workflow_uploads",
      );
      expect(command()).toContain("if live_uploads = 0 then");
    });

    test("treats the presence of a record as the reference", () => {
      // Joined on the two halves of the key, which are also the record's primary
      // key — that correspondence is the whole predicate.
      expect(command()).toContain("from aai_platform.workflow_uploads u");
      expect(command()).toContain("u.slug = split_part(o.name, '/', 2)");
      expect(command()).toContain("u.id = split_part(o.name, '/', 3)");
    });

    test("only reads a key it can decompose", () => {
      // A key that does not parse is a key whose slug and id cannot be read back
      // out, so the join above would be against the wrong halves of somebody's
      // object. The arm leaves it rather than guessing.
      expect(command()).toContain("^uploads/[^/]+/[^/]+/[0-9]+$");
      expect(command()).toContain("like 'uploads/%'");
    });

    test("waits out a window longer than any sandbox can live", () => {
      // Bytes precede the record in `create` alone, and that gap is one guest
      // request inside a sandbox `SANDBOX_TIMEOUT_SECS` clamps to 86,400 seconds.
      // Three days is three times that ceiling; shortening it past a day is what
      // would start deleting uploads in flight.
      expect(command()).toContain("interval '3 days'");
      expect(command()).toContain("limit 500");
    });

    test("deletes through the Storage API, exactly as the blobs arm does", () => {
      // Both arms share one `net.http_delete` builder, so this is really asserting
      // that the shared one is what the uploads arm got: two objects deleted per
      // pass at two different prefixes, one credential path.
      const deletes = command().match(/net\.http_delete/g) ?? [];
      expect(deletes).toHaveLength(2);
      expect(command()).not.toContain("delete from storage.objects");
    });
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

  test("reaches both tables, because a slot and an event expire together", () => {
    // Slots without their events is a session that reconnects to state it cannot
    // explain; events without slots is a log describing state that is gone.
    expect(sweep()?.command).toContain("aai_platform.session_slots");
    expect(sweep()?.command).toContain("aai_platform.session_events");
  });

  test("names no tenant identifier, so there is nothing to quote", () => {
    // The `format(%I)` + `'^app_[a-f0-9]{16}$'` pair existed because one statement
    // addressed every tenant's schema by name. Tenancy is a COLUMN now, so the
    // isolation is structural and the sweep is deliberately tenant-blind — it
    // expires by age across the fleet.
    expect(sweep()?.command).not.toContain("format(");
    expect(sweep()?.command).not.toContain("app_");
  });

  test("takes its window from the module that owns the tables", () => {
    // Imported rather than written twice: a retention the sweep and the store
    // disagree about deletes rows one of them believes are live.
    expect(sweep()?.command).toContain(`interval '${SESSION_STATE_RETENTION}'`);
  });

  test("keeps a row far longer than the in-process grace window", () => {
    // A backstop for a guest that is GONE, not a second opinion about a live one:
    // deleting a row while a caller is still reconnecting is indistinguishable,
    // to them, from the loss durable state exists to remove.
    expect(SESSION_STATE_RETENTION).toBe("2 days");
  });
});
