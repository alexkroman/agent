// Copyright 2026 the AAI authors. MIT license.
/**
 * Apply the REAL migration to a real Postgres, then drive every Pg-backed
 * store against it.
 *
 * `platform-schema.test.ts` is a TEXT check: it greps the source for
 * `aai_platform.<table>` and asserts a migration declares each one. That
 * catches a missing table and a store that reintroduced DDL, and it is blind
 * to everything else about the SQL — a syntax error, a column the code writes
 * that the table lacks, a `not null` the store never supplies, a type the
 * driver cannot round-trip. Nothing in the suite executed this migration at
 * all, so the file that moved the schema out of the stores was the one file
 * with no coverage.
 *
 * The failure mode it guards is the expensive one. Both halves — schema and
 * stores — pass their own tests in isolation (the stores against in-memory
 * implementations), and they only meet in production, on the first read after
 * a deploy, as "relation does not exist" or "column … does not exist".
 *
 * Each run gets its own DATABASE so the migration is applied to virgin state
 * (the point is that it works on a fresh project) and concurrent runs cannot
 * collide.
 *
 * **Runs against the STACK, in a throwaway database on it.** It used to run
 * against a stock server, which meant the migration could not be applied as it
 * ships: every `create extension` line was stripped by a regex and a plpgsql
 * `pgmq.create(text)` was hand-written so the queue block could run — a fourth
 * implementation of a contract, in SQL, whose own comment conceded it was
 * "deliberately not an emulation of pgmq" while being exactly that. Both are
 * gone; the stack has the real extensions.
 *
 * One line still cannot apply, and it is a property of pg_cron rather than of
 * the arm: pg_cron is a SINGLE-DATABASE extension pinned to
 * `cron.database_name` (`postgres`), so `create extension pg_cron` in any other
 * database raises `can only create extension in database postgres`. The
 * throwaway database is what makes the fresh-project claim testable, so the one
 * line is skipped — and COUNTED, so a second such line cannot arrive silently.
 * Nothing is stubbed: the extension really exists in the cluster.
 *
 * The per-store round-trip specs that used to live here are now the conformance
 * tables (`store-conformance.ts`, run over the stack in
 * `store-conformance.scenario.test.ts`). They were a THIRD spec set over
 * contracts that already had two, free to drift and silent about it. What stays
 * is what is about the MIGRATION: that it applies, that re-applying it is a
 * no-op, that the foreign keys and cascades it declares really hold, and that no
 * store issued DDL.
 */

import type { CloseableDb } from "@alexkroman1/aai-runtime";
import { createPostgresDb } from "@alexkroman1/aai-runtime";
import { afterAll, beforeAll, expect, test } from "vitest";
import { describeWithStack, pgUrl } from "./_pg-test-utils.ts";
import { createPgChatStore } from "./chat-store.ts";
import { platformMigrationSql } from "./platform-schema-test-utils.ts";
import type { SqlExec } from "./secret-store.ts";
import { createPgWorkspaceStore } from "./workspace-store.ts";

// The migration as it ships, minus the one line a throwaway database cannot
// run, comes from `platformMigrationSql()` in `test-utils.ts` — the reader
// `pg-cron.scenario.test.ts` already uses, and whose own doc says the regex no
// longer lives in this file. It did: a second copy, down to the `skipped`
// counter. pg_cron is single-database by design (its worker reads job
// descriptions from `cron.database_name`, i.e. `postgres`, so `create extension
// pg_cron` anywhere else raises), and the omission is COUNTED — see the first
// test below, which is what stops a second omitted line arriving silently.

describeWithStack("the platform migration applies and the stores work against it", () => {
  /**
   * Read inside the hooks, not at the top of this body: vitest EXECUTES a
   * `describe.skip` callback (it has to, to enumerate the tests it is skipping),
   * so a `pgUrl()` up here would throw during collection on a machine with no
   * database instead of skipping.
   */
  let adminUrl: string;
  /** Connection to the throwaway database the migration is applied to. */
  let db: CloseableDb;
  let sql: SqlExec;
  let dbName: string;

  beforeAll(async () => {
    adminUrl = pgUrl();
    // `create database` cannot run inside a transaction block, and needs a
    // connection to some OTHER database — hence the two-step.
    dbName = `aai_schema_test_${process.pid}_${Math.trunc(performance.now())}`;
    const admin = createPostgresDb({ url: adminUrl, max: 1 });
    try {
      // Identifier is ours, not user input, and matches [a-z0-9_].
      await admin.query(`create database ${dbName}`);
    } finally {
      await admin.close();
    }
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    db = createPostgresDb({ url: toPgUrl(url), max: 2 });
    sql = (query, params) => db.query(query, params);

    // The whole migration in one statement — as `supabase db push` sends it,
    // `do $$ … $$` blocks and all, so a statement-splitting bug in this test
    // cannot make a broken migration look fine.
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

  test("only pg_cron is omitted, and the other extensions are REAL", async () => {
    // Guards the substitution above: a second omitted line means deciding
    // whether it is testable rather than quietly skipping it.
    expect(platformMigrationSql().skipped).toBe(1);
    // And the two the migration CREATES are really installed here, by the
    // migration itself — which is what makes the pgmq queue block executable
    // rather than something a hand-written plpgsql stub stood in for.
    const rows = await sql(
      `select extname from pg_extension where extname in ('pgmq', 'pg_net') order by extname`,
    );
    expect(rows.map((r) => String(r.extname))).toEqual(["pg_net", "pgmq"]);
    // **`supabase_vault` is ABSENT here, and that is a finding about the
    // migrations rather than about this arm.** No migration creates it — Supabase
    // pre-installs it in the project's own `postgres` database — so a database
    // built from `supabase/migrations` ALONE, which is exactly what this
    // throwaway one is, has no Vault and `createVaultSecretStore` cannot work
    // against it. The conformance table reaches Vault because it runs against the
    // stack's `postgres` database, where the platform's schema really lives.
    // Asserted rather than merely noted, so a migration that starts declaring it
    // has to come and change this line.
    const vault = await sql("select extname from pg_extension where extname = 'supabase_vault'");
    expect(vault).toEqual([]);
  });

  test("re-applying the migration is a no-op, not an error", async () => {
    // Every statement is `if not exists`-guarded or wrapped in an existence
    // check, and `supabase db push` may legitimately re-run it.
    const { sql: migration } = platformMigrationSql();
    await expect(sql(migration)).resolves.toBeDefined();
  });

  // The per-store round-trip specs that used to sit here — agents columns and
  // the version bump, workspace CAS, chat round-trip — are the conformance
  // tables now (`store-conformance.scenario.test.ts`, over the same case list
  // the memory arms run). They were a THIRD spec set over contracts that already
  // had two, and the drift between three internally-green spec sets is silent by
  // construction. What is left in this file is about the MIGRATION: that it
  // applies, that re-applying it is a no-op, that the keys and cascades it
  // declares really hold, and that no store issued DDL.

  test("deleting a workspace cascades to its chat", async () => {
    // The point of the foreign key: project deletion writes the workspace and
    // the chat side by side, so a half-failed delete used to strand a chat row
    // that NOTHING reaps — no sweep covers `studio_chats`, and the only path
    // that deletes one is the delete of a project that no longer exists.
    const workspaces = createPgWorkspaceStore(sql);
    const chats = createPgChatStore(sql);
    await workspaces.put("scope-cascade", "proj", { files: {} }, null);
    await chats.putChat("scope-cascade", "proj", [{ id: "m1", role: "user", parts: [] }]);

    await workspaces.delete("scope-cascade", "proj");

    expect(await chats.getChat("scope-cascade", "proj")).toBeNull();
  });

  test("a parentless chat is REFUSED, not stranded", async () => {
    // The other half of the same key, and the half no cascade can show: before
    // it, this write succeeded and produced a row no surface could see and no
    // code path could ever delete.
    const chats = createPgChatStore(sql);
    await expect(chats.putChat("scope-ghost", "ghost", [])).rejects.toThrow(
      /studio_chats_workspace_fk/,
    );
  });

  test("deleting a workspace cascades to its session too", async () => {
    // `studio_sessions` is the sharper case: the delete route never touched it
    // at all, so the row outlived the project carrying a live `chat_token` and
    // `sandbox_token` until its lease expired. Nothing in the application
    // deletes it even now — unlike the chat, where the cascade backs up a
    // delete that already existed, here the cascade IS the mechanism.
    const workspaces = createPgWorkspaceStore(sql);
    await workspaces.put("scope-session", "proj", { files: {} }, null);
    await sql(
      `insert into aai_platform.studio_sessions
         (scope, project, chat_url, chat_token, guest_origin, sandbox_token, owner, expires_at)
       values ($1, $2, 'u', 't', 'o', 's', 'replica', now() + interval '1 hour')`,
      ["scope-session", "proj"],
    );

    await workspaces.delete("scope-session", "proj");

    const rows = await sql(
      "select 1 from aai_platform.studio_sessions where scope = $1 and project = $2",
      ["scope-session", "proj"],
    );
    expect(rows).toEqual([]);
  });

  test("no store issued DDL — the schema came from the migration alone", async () => {
    // The text-level suite asserts no store SOURCE contains DDL; this asserts
    // the running database agrees, by checking the tables' owners/existence
    // after a full round of store traffic. A store that lazily created its own
    // table would have had to do it above.
    const tables = await sql(
      `select table_name from information_schema.tables
       where table_schema = 'aai_platform' order by table_name`,
    );
    // An EXACT set, which is the whole assertion: a store that lazily created
    // its own table shows up as an extra entry. So a legitimately new table
    // joins this list in the same commit as its migration — that is the cost of
    // the check, and it is cheaper than the failure it catches.
    expect(tables.map((r) => String(r.table_name))).toEqual([
      "agents",
      // Turn-level durability on the platform
      // (`20260827020000_platform_session_state.sql`): a tool's `ctx.slots` and the
      // session event log, which lived in the app's own database until no agent had
      // one. Tenancy is in the primary key rather than a mapping table, because
      // unlike the DevKit's schema this one is the platform's own.
      "session_events",
      "session_slots",
      "studio_chats",
      "studio_rate_limits",
      "studio_sessions",
      "studio_workspaces",
      // The REPLAY ENGINE's journal, owned by the platform
      // (`20260901000000_platform_workflow_journal.sql`) — five tables, and the
      // note above `workflow_queue` used to say why there was only one of it:
      // the journal was the DevKit's, in its own `workflow` schema. It is ours
      // now, and these are the only durable home a DEPLOYED run has, the
      // platform provisioning no tenant database.
      //
      // Tenancy is the leading column of every primary key, so a guessed run id
      // reaches nothing — same design as `session_slots` above, and the reason
      // the `workflow_run_owner` mapping table below had to exist at all.
      // TWO attempt tables, for one release. An attempt CHARGE became a LEASE
      // that expires, which needed the holder in the primary key and so a new
      // table (`20260903160000_workflow_attempt_leases.sql`) — and its drop is
      // owed to a later release, because `supabase db push` runs before the
      // deploy and the old containers still name the old one. `RETIRED_OBJECTS`
      // in `platform-schema.test.ts` is the ledger that remembers; delete this
      // line in the same commit as that drop. `_` precedes `s`, so the new name
      // sorts first.
      "workflow_attempt_leases",
      "workflow_attempts",
      "workflow_hooks",
      // The platform-owned durable-workflow QUEUE
      // (`20260827000000_workflow_world.sql`), which holds a DEPLOYED run's
      // SCHEDULE: that guest's own timers die with a sandbox that self-exits, so
      // a due message here is what boots it and re-walks the journal above.
      "workflow_queue",
      // The correlation-key INDEX (`20260903030000_workflow_run_keys.sql`) —
      // `(workflow, key) -> runId`, the only pointer from a caller to the durable
      // run their last call started. It is the journal's gap one table over: the
      // index's other two backends are a `Map` and the agent's own `DATABASE_URL`,
      // so a deployed agent kept that pointer in a sandbox that self-exits while
      // the run beside it was durable. Tenancy leads the primary key like every
      // table above, and it references `agents` rather than `workflow_runs` on
      // purpose — see the migration.
      "workflow_run_keys",
      // RETIRED, and still here on purpose: which agent owns a durable run
      // (`20260827010000_workflow_run_owner.sql`), scoping every storage read
      // back when the DevKit's tenant-column-less world ran on this database.
      // Nothing reads or writes it now, and dropping it is owed to a LATER
      // release — `20260901010000_drop_workflow_devkit_schema.sql` renames that
      // world's schemas rather than dropping them, and a rollback of the rename
      // needs this table to say whose runs those rows are. The entry in
      // `platform-schema.test.ts`'s retired-object ledger is what fails if the
      // drop is forgotten; delete this line in the same commit as that drop.
      "workflow_run_owner",
      // The journal's own three remaining tables, alphabetically after the owner
      // row — see the block above `workflow_attempt_leases` for the whole
      // account.
      "workflow_runs",
      "workflow_sleeps",
      "workflow_steps",
      // Workflow upload RECORDS (`20260828000000_platform_uploads.sql`) — the last
      // piece of a guest's durable state that lived on local disk. The BYTES are
      // not here; they are the bucket's. Tenancy is in the primary key, like
      // session state, because this schema is the platform's own.
      "workflow_uploads",
    ]);
  });
});

/** `URL` renders `postgres:` as `postgres://…`; keep the driver's spelling. */
function toPgUrl(url: URL): string {
  return url.toString();
}
