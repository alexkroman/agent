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
 * The orphan-preview reap is a cron body again, and it is the one that had
 * actually gone wrong — its guard reads the generated `preview_slug` column, and
 * on double-encoded rows that read NULL out of a jsonb STRING, so the guard
 * matched nothing and the sweep deleted LIVE previews on the hour. It is executed
 * here end to end rather than stubbed.
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
import { platformCronJobs } from "./pg-cron.ts";
import { SLUG_LOCK_NAMESPACE } from "./platform-lock.ts";
import type { SqlExec } from "./secret-store.ts";
import { platformMigrationSql } from "./test-utils.ts";

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
  /** The throwaway database's own URL — a second connection needs it. */
  let dbUrl: string;

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
    dbUrl = url.toString();
    db = createPostgresDb({ url: dbUrl, max: 2 });
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
    // Moved as jobs enter and leave this list, deliberately and each time: a floor
    // is only a floor while it matches the real count. 8 → 7 when the session-state
    // sweep became one job per APP, scheduled into that app's own database because
    // per-app databases put a tenant's tables outside this catalog entirely; 7 → 6
    // when the orphan-preview reap moved into the server, because its drop was a
    // Management API call and SQL cannot make one; 6 → 6 when the session-state
    // sweep came BACK, since there are no app databases and one statement reaches
    // the whole fleet while the app-role runaway sweep left with the roles it
    // terminated; and 6 → 7 when the orphan reap came back for the same reason —
    // with no database to drop, a reap is a Vault row and an agents row.
    //
    // 7 → 9 with the durable-workflow retention sweep, and the JUMP is the finding:
    // the real count was already 8 because `aai-sweep-upload-records` landed
    // without moving this line. A floor that lags is a floor that would not have
    // noticed the sweep it lagged by going away, so it is set to the actual here
    // rather than nudged by one.
    expect(JOBS.length).toBeGreaterThanOrEqual(9);
    expect(JOBS.map((j) => j.name)).toContain("aai-sweep-blob-gc");
    // Back here, and this is the assertion that says which side of the move we are
    // on: it read `not.toContain` for as long as those rows lived in a catalog this
    // database could not see.
    expect(JOBS.map((j) => j.name)).toContain("aai-sweep-session-state");
    // Back here too, and for the same reason the session-state sweep is: the step
    // that could not be SQL does not exist any more.
    expect(JOBS.map((j) => j.name)).toContain("aai-sweep-orphan-previews");
    // Named because it is the one whose body a MIGRATION owns — the schedule here
    // and `aai_platform.sweep_terminal_workflow_runs()` there — so a migration that
    // stopped shipping the function would leave this list looking complete.
    expect(JOBS.map((j) => j.name)).toContain("aai-sweep-workflow-runs");
    // This one is really gone rather than renamed: a platform job sweeping a
    // catalog that no longer holds what it looks for runs on its schedule forever
    // and reclaims nothing.
    expect(JOBS.map((j) => j.name)).not.toContain("aai-sweep-app-db-runaways");
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

  /**
   * The reap, executed — not its candidate read.
   *
   * The predicate is `not exists (select 1 from studio_workspaces w where
   * w.preview_slug = a.slug)`, and `preview_slug` is generated from
   * `doc->>'previewSlug'`. On rows written double-encoded that read NULL out of a
   * jsonb *string*, so the guard matched nothing and the sweep deleted LIVE
   * previews on the hour. That is why the workspace below is inserted through the
   * same document shape the studio writes: the generated column has to see it.
   */
  test("the orphan reap deletes the unclaimed preview, its secret, and nothing else", async () => {
    const stale = "orphan-x1-preview";
    const claimed = "orphan-x2-preview";
    const young = "orphan-x3-preview";
    for (const [slug, age] of [
      [stale, "2 hours"],
      [claimed, "2 hours"],
      // Inside the age window: a workspace row is written BEFORE its preview
      // deploys, so a reap that ignored age would race a deploy in flight.
      [young, "1 minute"],
    ] as const) {
      await sql(
        `insert into aai_platform.agents
           (slug, credential_hashes, worker_hash, client_files, version, updated_at)
         values ($1, $2::text::jsonb, 'w', $3::text::jsonb, 1, now() - interval '${age}')`,
        [slug, "[]", "{}"],
      );
      await sql("select vault.create_secret($1, $2)", ["{}", `agent-env:${slug}`]);
    }
    await sql(
      `insert into aai_platform.studio_workspaces (scope, project, doc)
       values ('cron-scope', 'x2', $1::text::jsonb)`,
      [JSON.stringify({ files: {}, previewSlug: claimed })],
    );

    await sql(JOBS.find((j) => j.name === "aai-sweep-orphan-previews")?.command ?? "");

    const rows = await sql("select slug from aai_platform.agents where slug like 'orphan-%'");
    expect(rows.map((r) => String(r.slug)).sort()).toEqual([claimed, young].sort());
    // The Vault row goes too, and only the reaped one's — a survivor's credential
    // deleted here is an agent that exists and cannot boot.
    const secrets = await sql(
      "select name from vault.secrets where name like 'agent-env:orphan-%'",
    );
    expect(secrets.map((r) => String(r.name)).sort()).toEqual(
      [`agent-env:${claimed}`, `agent-env:${young}`].sort(),
    );
  });

  /**
   * A slug someone is deploying is SKIPPED, not waited for.
   *
   * The body takes `pg_try_advisory_xact_lock(SLUG_LOCK_NAMESPACE, hashtext(slug))`
   * and `withSlugLock` takes the SESSION-scoped `pg_advisory_lock` on the same
   * pair. The two forms share one lock space and differ only in when they release,
   * which is the whole reason this move is safe — a parallel lock that merely
   * looked like the deploy's would exclude nothing.
   *
   * Asserted from a SECOND connection, because a lock held by the connection
   * running the sweep would be re-acquired by it rather than contended.
   */
  test("a slug whose deploy lock is held is skipped, and reaped on the next pass", async () => {
    const busy = "orphan-locked-preview";
    await sql(
      `insert into aai_platform.agents
         (slug, credential_hashes, worker_hash, client_files, version, updated_at)
       values ($1, $2::text::jsonb, 'w', $3::text::jsonb, 1, now() - interval '2 hours')`,
      [busy, "[]", "{}"],
    );
    const body = JOBS.find((j) => j.name === "aai-sweep-orphan-previews")?.command ?? "";
    const rival = createPostgresDb({ url: dbUrl, max: 1 });
    try {
      await rival.query("select pg_advisory_lock($1::int, hashtext($2)::int)", [
        SLUG_LOCK_NAMESPACE,
        busy,
      ]);
      await sql(body);
      const held = await sql("select slug from aai_platform.agents where slug = $1", [busy]);
      expect(held).toHaveLength(1);
      await rival.query("select pg_advisory_unlock($1::int, hashtext($2)::int)", [
        SLUG_LOCK_NAMESPACE,
        busy,
      ]);
    } finally {
      await rival.close();
    }
    // Released, so the next pass takes it — which is what makes a skip a deferral
    // rather than a leak.
    await sql(body);
    expect(await sql("select slug from aai_platform.agents where slug = $1", [busy])).toEqual([]);
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

  test("the session-state sweep deletes stale slots and events, keeping fresh ones", async () => {
    // The rows a dead guest left behind. Fleet-wide in ONE statement now: the
    // per-app version was scheduled into each app's own database, so its cost
    // scaled with the number of tenants.
    await sql(
      `insert into aai_platform.agents (slug, credential_hashes, worker_hash, client_files, version)
       values ('pgc-sess', '{}'::jsonb, '', '{}'::jsonb, 1) on conflict do nothing`,
    );
    await sql(
      `insert into aai_platform.session_slots (slug, session_id, slot, value, updated_at)
       values ('pgc-sess', 'old', 'k', '"v"'::jsonb, now() - interval '3 days'),
              ('pgc-sess', 'new', 'k', '"v"'::jsonb, now())`,
    );
    await sql(
      `insert into aai_platform.session_events (slug, session_id, event_index, event, created_at)
       values ('pgc-sess', 'old', 0, '{}'::jsonb, now() - interval '3 days'),
              ('pgc-sess', 'new', 0, '{}'::jsonb, now())`,
    );

    const sweep = JOBS.find((j) => j.name === "aai-sweep-session-state");
    expect(sweep).toBeDefined();
    await sql(sweep?.command ?? "");

    const slots = await sql(
      "select session_id from aai_platform.session_slots where slug = 'pgc-sess'",
    );
    const events = await sql(
      "select session_id from aai_platform.session_events where slug = 'pgc-sess'",
    );
    expect(slots.map((r) => r.session_id)).toEqual(["new"]);
    expect(events.map((r) => r.session_id)).toEqual(["new"]);

    await sql("delete from aai_platform.agents where slug = 'pgc-sess'");
  });

  test("the workflow retention sweep drops an old terminal run and its whole journal", async () => {
    // The one sweep whose body lives in a migration rather than in `pg-cron.ts`,
    // and the one with children to take with it: `workflow_steps` and the other
    // three reference `agents`, not `workflow_runs`, so nothing cascades and the
    // CTE is the only thing keeping them together.
    const day = 86_400_000;
    const now = Date.now();
    await sql(
      `insert into aai_platform.agents (slug, credential_hashes, worker_hash, client_files, version)
       values ('pgc-wkf', '{}'::jsonb, '', '{}'::jsonb, 1) on conflict do nothing`,
    );
    await sql(
      `insert into aai_platform.workflow_runs (slug, run_id, workflow, status, created_at)
       values ('pgc-wkf', 'old_done', 'd', 'completed', $1),
              ('pgc-wkf', 'old_live', 'd', 'running',   $1),
              ('pgc-wkf', 'new_done', 'd', 'completed', $2)`,
      [now - 40 * day, now - 1000],
    );
    await sql(
      `insert into aai_platform.workflow_steps
         (slug, run_id, key, name, status, attempts, finished_at)
       values ('pgc-wkf', 'old_done', 'k', 'n', 'ok', 1, $1)`,
      [now - 40 * day],
    );
    await sql(
      `insert into aai_platform.workflow_hooks (slug, run_id, key, token)
       values ('pgc-wkf', 'old_done', 'h', 'pgc-wkf-token')`,
    );

    const sweep = JOBS.find((j) => j.name === "aai-sweep-workflow-runs");
    expect(sweep).toBeDefined();
    await sql(sweep?.command ?? "");

    const runs = await sql("select run_id from aai_platform.workflow_runs where slug = 'pgc-wkf'");
    // The old TERMINAL one, and only it: a run still `running` at 40 days is a
    // long park, not garbage, and a run that finished a second ago is history
    // somebody is still reading.
    expect(runs.map((r) => String(r.run_id)).sort()).toEqual(["new_done", "old_live"]);
    const steps = await sql("select 1 from aai_platform.workflow_steps where slug = 'pgc-wkf'");
    const hooks = await sql("select 1 from aai_platform.workflow_hooks where slug = 'pgc-wkf'");
    expect(steps).toEqual([]);
    // The hook row in particular: it holds a TOKEN, and a token held by a run
    // nobody can reach is one an author's derived `retention:<id>` collides with
    // forever.
    expect(hooks).toEqual([]);

    await sql("delete from aai_platform.agents where slug = 'pgc-wkf'");
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
