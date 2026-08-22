// Copyright 2026 the AAI authors. MIT license.
/**
 * Do the pg_cron sweep bodies actually RUN?
 *
 * Nothing had ever executed one. `pg-cron.test.ts` asserts that
 * `select cron.schedule($1, $2, $3)` was called with the body as a *parameter* —
 * a test of the scheduler call, not of the SQL inside it, and `cron.schedule`
 * stores the text without parsing it. So a sweep body with a syntax error, a
 * column that no longer exists, or the `::text::jsonb` bug reached through an
 * arrow operator was green here and wrong HOURLY in production, silently, because
 * `guarded()` swallows whatever it raises.
 *
 * That contradicts a rule this package already states: "anything that reaches
 * into a jsonb column from inside Postgres — an arrow operator, `-`,
 * `jsonb_set`, a predicate in a pg_cron body — needs a test against a real
 * database." Every sweep body does exactly that (`client_files` for the blob GC,
 * `doc->>'previewSlug'` via the generated `preview_slug` column, now read by
 * `orphan-previews.ts`), and not one had been EXECUTED by anything.
 *
 * This is the cheapest version that closes it: apply the migration to a
 * throwaway database, run every body once, and assert what two of them did.
 *
 * ## Why a throwaway database
 *
 * The bodies are GLOBAL by construction — the rate-limit and archive sweeps
 * delete every expired row, and the runaway sweep terminates backends. Run
 * against the shared stack they would touch a developer's real state. An
 * isolated database makes execution safe AND makes the seeded state the only
 * state, so "it deleted the expired one" is a real assertion rather than a count
 * that drifts with whatever else is in there.
 *
 * The orphan-preview reap is here too, though it is no longer a cron body: its
 * candidate read is the same `preview_slug` anti-join those bodies had, and it is
 * the one that had actually gone wrong (see the spec).
 *
 * `supabase_vault` is created here explicitly, because NO migration creates it
 * (Supabase pre-installs it) and the blob GC returns early without it —
 * `to_regclass('vault.secrets') is null`, since its Storage key comes from
 * Vault. Testing that early return is testing nothing.
 *
 * pg_cron itself is single-database (pinned to `cron.database_name`, i.e.
 * `postgres`), so the SCHEDULING half runs against the main database under
 * throwaway job names and unschedules itself.
 */

import type { CloseableDb } from "@alexkroman1/aai-runtime";
import { createPostgresDb } from "@alexkroman1/aai-runtime";
import { afterAll, beforeAll, expect, test } from "vitest";
import { describeWithStack, pgUrl } from "./_pg-test-utils.ts";
import { createOrphanPreviewSweep } from "./orphan-previews.ts";
import { platformCronJobs } from "./pg-cron.ts";
import type { SqlExec } from "./secret-store.ts";
import { createMemorySecretStore } from "./secret-store.ts";
import { createTestStore, fakeAppDatabases, platformMigrationSql } from "./test-utils.ts";

/** The reap's collaborators, none of which this spec exercises. */
function fakeReapEnv() {
  return {
    store: createTestStore(),
    secrets: createMemorySecretStore(),
    slugLock: <T>(_slug: string, fn: () => Promise<T>) => fn(),
    appDb: fakeAppDatabases(),
  };
}

/** Every sweep, including the blob GC — which needs a storage config to exist. */
const JOBS = platformCronJobs({ storage: { url: "https://probe.test", bucket: "blobs" } });

/**
 * Sweeps that touch pg_cron's OWN schema, so a throwaway database is the wrong
 * arm for them.
 *
 * `aai-sweep-cron-history` prunes `cron.job_run_details`, and pg_cron is
 * single-database (pinned to `cron.database_name`, i.e. `postgres`) — so that
 * table exists in the platform database and nowhere else. Unguarded on purpose:
 * the platform database always has pg_cron, so a `to_regclass` wrapper would be
 * pretending the sweep might run somewhere it never does. Split out rather than
 * excused, so it is still EXECUTED — against the database where it belongs.
 */
const NEEDS_CRON_SCHEMA = (job: { command: string }): boolean => /\bcron\./.test(job.command);

describeWithStack("the pg_cron sweep bodies", () => {
  let adminUrl: string;
  let db: CloseableDb;
  let sql: SqlExec;
  let dbName: string;

  beforeAll(async () => {
    // `pgUrl()` inside the hook: vitest executes a `describe.skip` callback to
    // enumerate what it is skipping, so up top this throws during collection.
    adminUrl = pgUrl();
    // `create database` cannot run inside a transaction and needs a connection to
    // some OTHER database — hence the two-step.
    dbName = `aai_cron_test_${process.pid}_${Math.trunc(performance.now())}`;
    const admin = createPostgresDb({ url: adminUrl, max: 1 });
    try {
      await admin.query(`create database ${dbName}`);
    } finally {
      await admin.close();
    }
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    db = createPostgresDb({ url: url.toString(), max: 2 });
    sql = (query, params) => db.query(query, params);
    // Vault first: the blob GC's own guard returns early without it.
    await sql("create extension if not exists supabase_vault");
    await sql(platformMigrationSql().sql);
  });

  afterAll(async () => {
    await db?.close();
    const admin = createPostgresDb({ url: adminUrl, max: 1 });
    try {
      await admin.query(`drop database if exists ${dbName}`);
    } finally {
      await admin.close();
    }
  });

  test("there are sweeps to run, and the blob GC is one of them", () => {
    // A loop over an empty list passes, which is the shape of failure this whole
    // file exists to end. The blob GC is named because it is the one that is
    // CONDITIONAL on a storage config — with none, `platformCronJobs()` omits it
    // and every assertion below would quietly cover one sweep less.
    // Lowered as jobs leave this list, deliberately and each time: a floor is only
    // a floor while it matches the real count. 8 → 7 when the session-state sweep
    // became one job per APP, scheduled into that app's own database because
    // per-app databases put a tenant's tables outside this catalog entirely
    // (`_session-state-sweep.ts`); 7 → 6 when the orphan-preview reap moved into
    // the server, because its drop is a Management API call and SQL cannot make
    // one (`orphan-previews.ts`).
    expect(JOBS.length).toBeGreaterThanOrEqual(6);
    expect(JOBS.map((j) => j.name)).toContain("aai-sweep-blob-gc");
    // And the two that left are really gone from here, rather than renamed: a
    // platform job sweeping a catalog that no longer holds what it looks for runs
    // on its schedule forever and reclaims nothing.
    expect(JOBS.map((j) => j.name)).not.toContain("aai-sweep-session-state");
    expect(JOBS.map((j) => j.name)).not.toContain("aai-sweep-orphan-previews");
  });

  test.each(JOBS.filter((j) => !NEEDS_CRON_SCHEMA(j)).map((j) => [j.name, j.command] as const))(
    "%s executes against the real schema",
    async (_name, command) => {
      // The whole assertion is "this SQL is valid against this schema and does not
      // raise". That sounds thin and is the single largest thing missing: every one
      // of these runs hourly in production inside `guarded()`, which swallows the
      // exception, so a broken body is invisible forever. A `do $$ … $$` block is
      // parsed at EXECUTION, so a syntax error anywhere in one fails right here.
      await expect(sql(command)).resolves.toBeDefined();
    },
  );

  test("the orphan-preview reap picks the UNCLAIMED preview and spares a claimed one", async () => {
    // The behavioural half, and the one that has actually gone wrong: the guard is
    // `not exists (select 1 from studio_workspaces w where w.preview_slug = a.slug)`,
    // and `preview_slug` is generated from `doc->>'previewSlug'`. On rows written
    // double-encoded that read NULL out of a jsonb *string*, so the guard matched
    // nothing and the sweep deleted LIVE previews on the hour.
    //
    // The reap is no longer a cron body (`orphan-previews.ts`) — this executes its
    // CANDIDATE READ against a real database, which is the half that predicate
    // lives in. The reap itself is stubbed: what it does with a slug is
    // `deleteAgentResources`, covered end to end in
    // `management-provision.scenario.test.ts`.
    const stale = "orphan-x1-preview";
    const claimed = "orphan-x2-preview";
    for (const slug of [stale, claimed]) {
      await sql(
        `insert into aai_platform.agents
           (slug, credential_hashes, worker_hash, client_files, version, updated_at)
         values ($1, $2::text::jsonb, 'w', $3::text::jsonb, 1, now() - interval '2 hours')`,
        [slug, "[]", "{}"],
      );
    }
    // One workspace CLAIMS the second preview, through the same document shape the
    // studio writes — so the generated column is what has to see it.
    await sql(
      `insert into aai_platform.studio_workspaces (scope, project, doc)
       values ('cron-scope', 'x2', $1::text::jsonb)`,
      [JSON.stringify({ files: {}, previewSlug: claimed })],
    );

    const reaped: string[] = [];
    const sweep = createOrphanPreviewSweep({
      adminDb: db,
      env: fakeReapEnv(),
      reap: async (slug) => {
        reaped.push(slug);
      },
    });
    expect(await sweep.sweepOnce()).toMatchObject({ swept: true });
    expect(reaped).toEqual([stale]);
    // And nothing was deleted by the read itself — the row is the reap's last act.
    const rows = await sql("select slug from aai_platform.agents where slug like 'orphan-%'");
    expect(rows.map((r) => String(r.slug)).sort()).toEqual([stale, claimed].sort());
  });

  test("the rate-limit sweep deletes expired windows and keeps live ones", async () => {
    await sql(
      `insert into aai_platform.studio_rate_limits (name, key, count, reset_at)
       values ('cron-test', 'expired', 1, now() - interval '1 minute'),
              ('cron-test', 'live', 1, now() + interval '1 hour')`,
    );
    const sweep = JOBS.find((j) => j.name === "aai-sweep-rate-limits");
    await sql(sweep?.command ?? "");
    const rows = await sql(
      "select key from aai_platform.studio_rate_limits where name = 'cron-test'",
    );
    expect(rows.map((r) => String(r.key))).toEqual(["live"]);
  });

  test("the studio-session sweep deletes an expired lease", async () => {
    await sql(
      `insert into aai_platform.studio_workspaces (scope, project, doc)
       values ('cron-scope', 'sess', $1::text::jsonb)`,
      [JSON.stringify({ files: {} })],
    );
    await sql(
      `insert into aai_platform.studio_sessions
         (scope, project, chat_url, chat_token, guest_origin, sandbox_token, owner, expires_at)
       values ('cron-scope', 'sess', 'u', 't', 'o', 's', 'r', now() - interval '1 minute')`,
    );
    const sweep = JOBS.find((j) => j.name === "aai-sweep-studio-sessions");
    await sql(sweep?.command ?? "");
    const rows = await sql("select 1 from aai_platform.studio_sessions where scope = 'cron-scope'");
    expect(rows).toEqual([]);
  });
});

describeWithStack("pg_cron accepts every schedule the platform declares", () => {
  let db: CloseableDb;

  beforeAll(() => {
    // The MAIN database: pg_cron is single-database and lives in `postgres`.
    db = createPostgresDb({ url: pgUrl(), max: 1 });
  });

  afterAll(async () => {
    await db?.close();
  });

  test.each(JOBS.filter(NEEDS_CRON_SCHEMA).map((j) => [j.name, j.command] as const))(
    "%s executes against pg_cron's own schema",
    async (_name, command) => {
      // Against the MAIN database, which is the only one that has
      // `cron.job_run_details`. Safe on a shared stack by construction rather
      // than by luck: the body deletes run rows older than SEVEN DAYS, which is
      // exactly the pruning it exists to do, and a local stack's own history is
      // the only thing in it.
      await expect(db.query(command)).resolves.toBeDefined();
    },
  );

  test("each schedule expression is valid", async () => {
    // `cron.schedule` VALIDATES the schedule string (a malformed expression is
    // rejected outright), which is the one thing the statement-text assertions in
    // `pg-cron.test.ts` cannot see. Job names are prefixed and unscheduled
    // immediately, so this never disturbs the real `aai-sweep-*` set — which
    // matters because `schedulePlatformSweeps` DIFFS and would unschedule
    // anything it does not declare.
    for (const job of JOBS) {
      const name = `conf-probe-${job.name}`;
      try {
        await expect(
          db.query("select cron.schedule($1, $2, $3)", [name, job.schedule, "select 1"]),
        ).resolves.toBeDefined();
      } finally {
        await db.query("select cron.unschedule($1)", [name]).catch(() => undefined);
      }
    }
  });
});
