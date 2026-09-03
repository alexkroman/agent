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
 * **That was half the requirement, and the missing half made the point twice
 * over.** The GC reads a SECRET out of Vault, not merely the schema, so an empty
 * `vault.secrets` left `storage_key` null and the body returned anyway. `pg_net`
 * and `storage.objects` were absent for the same reason. So the sweep with the
 * most dangerous predicate in the repo was covered by "it did not raise", and it
 * took writing a POSITIVE control to notice — a test asserting a deletion
 * happens, beside the ones asserting it does not.
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
import { platformMigrationSql } from "./platform-schema-test-utils.ts";
import type { SqlExec } from "./secret-store.ts";
import { PLATFORM_STORAGE_KEY_SECRET } from "./secret-store.ts";

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
    // The blob GC's other two dependencies, so its arms EXECUTE here rather than
    // taking the early return that made "it ran" mean "it did nothing".
    //
    // `pg_net` is the real extension, not a stub: its worker is pinned to
    // `pg_net.database_name` (i.e. `postgres`), so in a throwaway database a
    // request is enqueued and never sent — which is exactly the observation this
    // file wants. `net.http_request_queue` is then a record of every object the
    // sweep DECIDED to delete, with no HTTP leaving the machine.
    await sql("create extension if not exists pg_net");
    // `storage.objects` is Supabase's, created by migrations we do not ship, so
    // this is a stand-in carrying the three columns the sweep reads. The shape is
    // not taken on trust — the second suite below asserts the real table still has
    // them, which is the half a stand-in cannot prove about itself.
    await sql("create schema if not exists storage");
    await sql(
      `create table if not exists storage.objects (
         bucket_id text not null,
         name text not null,
         created_at timestamptz not null default now()
       )`,
    );
    // And the Storage KEY, without which the body returns before either arm —
    // which is what it had been doing. Creating the vault EXTENSION was believed
    // to be what stopped the early return (see the module doc), but the GC reads a
    // SECRET out of it, and nothing had ever stored one: `storage_key is null`,
    // return, and every blob-GC assertion in this file was an assertion about an
    // early return. The three positive controls below are what surfaced it.
    await sql("select vault.create_secret($1, $2)", [
      "sb_secret_probe",
      PLATFORM_STORAGE_KEY_SECRET,
    ]);
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

  /** The GC body, and the URL prefix every delete it decides on carries. */
  const blobGc = (): string => JOBS.find((j) => j.name === "aai-sweep-blob-gc")?.command ?? "";
  const OBJECT_URL = "https://probe.test/storage/v1/object/blobs/";

  /**
   * Run the GC and report which OBJECT KEYS it decided to delete.
   *
   * The queue is cleared first so each test reads its own pass rather than the
   * file's history, and the URL prefix is stripped so a failure names an object
   * key — the thing under test — instead of a URL.
   *
   * The verb THROWS rather than asserting, for the reason
   * `pg-cron-delete-parity.test.ts` gives about its own helper: an `expect` here is
   * what `noMisplacedAssertion` bans, and it would be the wrong shape anyway. A
   * queued request that is not a DELETE means this helper's whole reading of the
   * queue is wrong — a broken harness, not a failed expectation about the sweep.
   */
  async function sweptKeys(): Promise<string[]> {
    await sql("delete from net.http_request_queue");
    await sql(blobGc());
    const rows = await sql("select url, method from net.http_request_queue order by url");
    for (const row of rows) {
      if (String(row.method) !== "DELETE") {
        throw new Error(
          `the blob GC enqueued a ${String(row.method)}; this harness reads the queue as DELETEs`,
        );
      }
    }
    return rows.map((r) => String(r.url).replace(OBJECT_URL, ""));
  }

  /**
   * Empty the stand-in bucket, so each pass below is about its own objects.
   *
   * Needed because the sweep deliberately does NOT delete `storage.objects` rows
   * — it calls the Storage API and lets the object's disappearance come back as a
   * row deletion — and in this database that call is only ever enqueued. So an
   * object stays selectable after the pass that condemned it, and without this a
   * later test reads every earlier test's verdict as its own.
   */
  const resetBucket = (): Promise<unknown[]> => sql("delete from storage.objects");

  /** One object in the bucket, aged by hand. */
  const putObject = async (name: string, age: string): Promise<void> => {
    await sql(
      `insert into storage.objects (bucket_id, name, created_at)
       values ('blobs', $1, now() - interval '${age}')`,
      [name],
    );
  };

  const putAgent = async (slug: string, workerHash: string): Promise<void> => {
    await sql(
      `insert into aai_platform.agents (slug, credential_hashes, worker_hash, client_files, version)
       values ($1, '[]'::jsonb, $2, '{}'::jsonb, 1) on conflict (slug) do nothing`,
      [slug, workerHash],
    );
  };

  /**
   * The empty-table guard for the UPLOADS arm, asserted before any record exists.
   *
   * First of these tests deliberately: `workflow_uploads` is empty right now, and
   * this is the one guard that can only be observed in that state. An upload
   * record IS the referrer for the uploads arm, so a table that failed to load
   * would condemn every recording in the bucket — the same catastrophe the agents
   * guard exists for, one table over.
   */
  test("the uploads arm reclaims nothing while workflow_uploads reads empty", async () => {
    await resetBucket();
    await putAgent("gc-guard", "gc-guard-hash");
    expect(await sql("select 1 from aai_platform.workflow_uploads")).toEqual([]);
    // Old, unrecorded, perfectly shaped — garbage by every rule the arm applies
    // except the one being tested.
    await putObject("uploads/gc-guard/upl_guard/0", "30 days");

    expect(await sweptKeys()).toEqual([]);

    await sql("delete from aai_platform.agents where slug = 'gc-guard'");
  });

  /**
   * The whole predicate, positives and negatives in ONE pass.
   *
   * One test rather than six because the assertion that matters is the SET the
   * sweep chose: "it deleted the orphan" and "it kept the in-flight window" are
   * the same fact read twice, and splitting them lets one pass while the other is
   * being broken. `toEqual` on the sorted set is what makes an unexpected
   * deletion — the failure mode that destroys a customer's recording — fail here.
   */
  test("the uploads arm deletes only aged, unrecorded, parsable windows", async () => {
    await resetBucket();
    await putAgent("gc-up-live", "gc-up-live-hash");
    await sql(
      `insert into aai_platform.workflow_uploads (slug, id, size, complete, parts, created_at)
       values ('gc-up-live', 'upl_recorded', 8, true, '[]'::jsonb, now() - interval '30 days')`,
    );
    for (const [name, age] of [
      // KEEP: a record names it. The record is 30 days old and the sweep does not
      // care — a record is the referrer, and age only gates the unrecorded.
      ["uploads/gc-up-live/upl_recorded/0", "30 days"],
      // KEEP: no record YET. This is the one that matters — `create` writes its
      // windows before its row, so an upload in flight looks exactly like garbage
      // and is inside UPLOAD_ORPHAN_GRACE. Two days is past any sandbox's default
      // life and still inside the window, which is the margin being asserted.
      ["uploads/gc-up-live/upl_inflight/0", "2 days"],
      // KEEP: under the prefix and not a key this sweep can decompose, so it
      // cannot prove it is garbage and leaves it for a human.
      ["uploads/gc-up-live/not-a-window", "30 days"],
      ["uploads/gc-up-live/upl_x/nested/0", "30 days"],
      // DELETE: aged past the grace window with no record — both windows of it,
      // since the predicate is per object and they share an id.
      ["uploads/gc-up-live/upl_orphan/0", "30 days"],
      ["uploads/gc-up-live/upl_orphan/8388608", "30 days"],
    ] as const) {
      await putObject(name, age);
    }

    expect(await sweptKeys()).toEqual([
      "uploads/gc-up-live/upl_orphan/0",
      "uploads/gc-up-live/upl_orphan/8388608",
    ]);
  });

  /**
   * Deleting an agent reclaims its uploaded BYTES, and it does so without
   * `deleteAgent` growing a step.
   *
   * This is the case the leak was worst in: `workflow_uploads.slug` is
   * `on delete cascade`, so un-publishing an agent took away the only record of
   * where its recordings were and left every byte of them in a bucket shared by
   * every tenant. The cascade is now the SIGNAL — the arm reads a missing record
   * as garbage — which is why the delete path in `bundle-store.ts` still has the
   * two steps `pg-cron-delete-parity.test.ts` pins it to.
   */
  test("an agent's upload windows are reclaimed once the agent is deleted", async () => {
    await resetBucket();
    await putAgent("gc-up-gone", "gc-up-gone-hash");
    await sql(
      `insert into aai_platform.workflow_uploads (slug, id, size, complete, parts, created_at)
       values ('gc-up-gone', 'upl_kept', 8, true, '[]'::jsonb, now() - interval '30 days')`,
    );
    await putObject("uploads/gc-up-gone/upl_kept/0", "30 days");
    // Held by its record while the agent is live — the control that makes the
    // second half of this test about the DELETE rather than about the age.
    expect(await sweptKeys()).toEqual([]);

    await sql("delete from aai_platform.agents where slug = 'gc-up-gone'");
    expect(
      await sql("select 1 from aai_platform.workflow_uploads where slug = 'gc-up-gone'"),
    ).toEqual([]);

    expect(await sweptKeys()).toEqual(["uploads/gc-up-gone/upl_kept/0"]);
  });

  /**
   * The blobs arm, EXECUTED — which nothing had done either.
   *
   * It is here as the positive control for everything above: the uploads
   * assertions are mostly "this was not deleted", and that is only evidence while
   * something proves the sweep deletes in this harness at all. It also finally
   * runs the `jsonb_each_text(client_files)` reference set against a real planner.
   */
  test("the blobs arm deletes an unreferenced blob and keeps every referenced one", async () => {
    await resetBucket();
    await putAgent("gc-blob", "gc-blob-worker");
    await sql(
      `update aai_platform.agents set client_files = $1::text::jsonb where slug = 'gc-blob'`,
      [JSON.stringify({ "index.html": "gc-blob-client" })],
    );
    for (const [name, age] of [
      ["blobs/gc-blob-worker", "30 days"],
      // The values of `client_files`, never its keys — taking the keys would mark
      // every client asset unreferenced.
      ["blobs/gc-blob-client", "30 days"],
      // Inside the blobs arm's own day of grace: a deploy could still be reaching
      // for it.
      ["blobs/gc-blob-fresh", "1 hour"],
      ["blobs/gc-blob-orphan", "30 days"],
    ] as const) {
      await putObject(name, age);
    }

    expect(await sweptKeys()).toEqual(["blobs/gc-blob-orphan"]);
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

  /**
   * The stand-in above is only evidence while the REAL table still looks like it.
   *
   * The suite that exercises the blob GC's predicate runs in a throwaway database
   * and creates its own `storage.objects`, because Supabase's storage migrations
   * are not ours to apply. That is fine for the predicate and useless for the
   * schema: the day Supabase renames `created_at`, every one of those assertions
   * still passes and the sweep silently stops aging anything in production.
   *
   * Read-only, and against the main database on purpose — this is the only place
   * the real table exists.
   */
  test("the real storage.objects still has the three columns the GC reads", async () => {
    const rows = await db.query(
      `select column_name from information_schema.columns
       where table_schema = 'storage' and table_name = 'objects'
         and column_name in ('bucket_id', 'name', 'created_at')`,
    );
    expect(rows.map((r) => String(r.column_name)).sort()).toEqual([
      "bucket_id",
      "created_at",
      "name",
    ]);
  });

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
