// Copyright 2026 the AAI authors. MIT license.

import { SESSION_STATE_TABLE } from "@alexkroman1/aai/runtime";
import { PREVIEW_SLUG_SUFFIX } from "@alexkroman1/aai/utils";
import { describe, expect, test } from "vitest";
import { platformCronJobs, schedulePlatformSweeps } from "./pg-cron.ts";
import { AGENT_ENV_SECRET_PREFIX, APP_DB_SECRET_PREFIX, type SqlExec } from "./secret-store.ts";

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
  await schedulePlatformSweeps(sql, platformCronJobs());

  expect(calls[0]?.query).toBe("create extension if not exists pg_cron");
  const scheduled = calls.slice(1, 1 + platformCronJobs().length);
  for (const [i, job] of platformCronJobs().entries()) {
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
  const guarded = platformCronJobs().filter((job) => job.command.includes("to_regclass"));
  expect(guarded.map((job) => job.name).sort()).toEqual([
    "aai-sweep-orphan-previews",
    "aai-sweep-preview-archive",
  ]);
});

test("the orphan-preview sweep only reaps unreferenced, aged preview slugs", () => {
  const orphans = platformCronJobs().find((j) => j.name === "aai-sweep-orphan-previews");
  expect(orphans).toBeDefined();
  const command = orphans?.command ?? "";
  // Only `-preview` slugs, never production agents.
  expect(command).toContain("like '%-preview'");
  // The workspace back-reference is what marks a preview as live, joined
  // through the indexed generated column rather than dug out of `doc` — see
  // 20260810020000_preview_slug_column.sql.
  expect(command).toContain("w.preview_slug = a.slug");
  expect(command).not.toContain("doc->>'previewSlug'");
  // Age floor: a preview whose workspace stamp hasn't landed yet is not an
  // orphan.
  expect(command).toContain("interval '1 hour'");
  // The slug's Vault secrets go with the row.
  expect(command).toContain("'agent-env:' || target.slug");
  expect(command).toContain("'app-db:' || target.slug");
});

test("the sweep's suffix and Vault prefixes come from the constants, not literals", () => {
  // These three strings are spelled in SQL that no type-checker relates to the
  // writers, and the guide names PREVIEW_SLUG_SUFFIX's consumers explicitly
  // "because a disagreement is silent data loss" — a sweep whose prefix has
  // drifted deletes nothing and says nothing. Asserting against the CONSTANTS
  // rather than the strings is what makes this a link instead of a second copy.
  const command = platformCronJobs().find((j) => j.name === "aai-sweep-orphan-previews")?.command;
  expect(command).toContain(`like '%${PREVIEW_SLUG_SUFFIX}'`);
  expect(command).toContain(`'${AGENT_ENV_SECRET_PREFIX}' || target.slug`);
  expect(command).toContain(`'${APP_DB_SECRET_PREFIX}' || target.slug`);
  expect(command).toContain(`'${APP_DB_SECRET_PREFIX}' || d.slug`);
  // ...and the interpolation is only safe while the values carry no quote and
  // no LIKE wildcard, which the module asserts at import.
  for (const value of [PREVIEW_SLUG_SUFFIX, AGENT_ENV_SECRET_PREFIX, APP_DB_SECRET_PREFIX]) {
    expect(value).not.toMatch(/['%_\\]/);
  }
});

test("the orphan-preview sweep deprovisions the app database like the delete route", () => {
  const orphans = platformCronJobs().find((j) => j.name === "aai-sweep-orphan-previews");
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
test("the runaway sweep reaches app roles and nothing else", () => {
  const runaways = platformCronJobs().find((j) => j.name === "aai-sweep-app-db-runaways");
  expect(runaways?.command).toContain("pg_terminate_backend");
  // Scoped by role NAME. The platform's own connections are `postgres`, so
  // the pattern is what keeps this from reaching them — note the escaped
  // underscore, without which `app_` would match any three characters.
  expect(runaways?.command).toContain(String.raw`usename like 'app\_%'`);
  expect(runaways?.command).toContain("state = 'active'");
});

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
});

describe("the session-state sweep", () => {
  const command = (): string =>
    platformCronJobs().find((j) => j.name === "aai-sweep-session-state")?.command ?? "";

  test("is declared", () => {
    expect(command()).not.toBe("");
  });

  test("only touches provisioned app schemas, and never interpolates one raw", () => {
    // The identifier rule this file states for every other statement: the cursor
    // filters to the provisioned shape, and `format(%I)` is what quotes it. A
    // schema name reaching a statement unquoted is the failure worth preventing.
    expect(command()).toContain("'^app_[a-f0-9]{16}$'");
    expect(command()).toContain("format(");
    expect(command()).toContain("%I.%I");
  });

  test("reads the table name from the SDK, so a rename cannot be two edits", () => {
    // The guest writes this table and the sweep reads it; one spelling is what
    // keeps them from disagreeing.
    expect(command()).toContain(SESSION_STATE_TABLE);
  });

  test("keeps a row far longer than the in-process grace window", () => {
    // A backstop for a guest that is GONE, not a second opinion about a live one:
    // deleting a row while a caller is still reconnecting is indistinguishable,
    // to them, from the loss durable state exists to remove.
    // Doubled quotes: the delete is a `format()` argument, so its own literals
    // are escaped inside the outer plpgsql string.
    expect(command()).toContain("interval ''2 days''");
  });

  test("isolates each tenant, so one broken schema costs only itself", () => {
    // The plpgsql equivalent of the wake read's SAVEPOINT — the table is
    // tenant-owned, so a reshaped or locked copy must not end the sweep.
    expect(command()).toContain("exception when others then");
    expect(command()).toContain("raise warning");
  });
});
