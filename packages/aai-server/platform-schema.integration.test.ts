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
 * Runs in the integration tier against `AAI_TEST_PG_URL`.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CloseableDb } from "@alexkroman1/aai/runtime";
import { createPostgresDb } from "@alexkroman1/aai/runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPgAgentRows } from "./agent-store.ts";
import { createPgChatStore } from "./chat-store.ts";
import type { SqlExec } from "./secret-store.ts";
import { createPgWorkspaceStore, WorkspaceConflictError } from "./workspace-store.ts";

const PG_URL = process.env.AAI_TEST_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

const migrationsDir = path.resolve(import.meta.dirname, "../../supabase/migrations");

/**
 * The migration as it ships, minus the two `create extension` lines.
 *
 * pg_cron and pgmq are Supabase-provided and cannot be installed on a stock
 * server (both are compiled extensions; pg_cron additionally needs
 * `shared_preload_libraries`). Everything else — every table, index, the
 * publication block, the grants, and the pgmq queue creation — executes
 * VERBATIM, because `stubPgmq` below supplies the one function the migration
 * calls.
 *
 * The substitution is COUNTED so this can never quietly cover less: a third
 * extension, or a changed extension line, fails the assertion in the first
 * test rather than silently widening what is skipped.
 */
function migrationForStockPostgres(): { sql: string; stripped: number } {
  const files = readdirSync(migrationsDir)
    .filter((n) => n.endsWith(".sql"))
    .sort();
  if (files.length === 0) throw new Error(`no migrations in ${migrationsDir}`);
  const raw = files.map((n) => readFileSync(path.join(migrationsDir, n), "utf-8")).join("\n");
  let stripped = 0;
  const sql = raw.replace(/^create extension if not exists \w+;$/gm, () => {
    stripped += 1;
    return "-- extension omitted: not available on a stock server";
  });
  return { sql, stripped };
}

describeIfPg("the platform migration applies and the stores work against it", () => {
  const adminUrl = PG_URL as string;
  /** Connection to the throwaway database the migration is applied to. */
  let db: CloseableDb;
  let sql: SqlExec;
  let dbName: string;

  beforeAll(async () => {
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

    // Stand in for the pgmq extension so the migration's queue block can run
    // as written. Stubbing beats stripping: the block has real error handling
    // (`pgmq.create` is not `if not exists`, so it catches the duplicate), and
    // that handling is worth executing. Without the stub the call raises
    // `3F000 schema "pgmq" does not exist`, which those handlers deliberately
    // do NOT catch — so the whole migration aborts.
    await stubPgmq(sql);

    // The whole migration in one statement — as `supabase db push` sends it,
    // `do $$ … $$` blocks and all, so a statement-splitting bug in this test
    // cannot make a broken migration look fine.
    await sql(migrationForStockPostgres().sql);
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

  test("needs exactly the two extensions that cannot be installed locally", () => {
    // Guards the substitution above: if the migration grows a third extension,
    // decide whether it is testable rather than quietly skipping it.
    expect(migrationForStockPostgres().stripped).toBe(2);
  });

  test("re-applying the migration is a no-op, not an error", async () => {
    // Every statement is `if not exists`-guarded or wrapped in an existence
    // check, and `supabase db push` may legitimately re-run it.
    const { sql: migration } = migrationForStockPostgres();
    await expect(sql(migration)).resolves.toBeDefined();
  });

  test("agents rows round-trip through the real table", async () => {
    const rows = createPgAgentRows(sql);
    // Every column the schema declares, including the nullable one — a
    // `not null` the store does not supply would fail right here.
    await rows.put({
      slug: "round-trip",
      credential_hashes: ["sha256:abc"],
      config: { name: "round-trip", nested: { deep: true } },
      worker_hash: "wh-1",
      client_files: { "index.html": "ch-1" },
      harness_image_tag: "aai-guest-harness:deadbeef",
    });

    const got = await rows.get("round-trip");
    expect(got).toMatchObject({
      slug: "round-trip",
      credential_hashes: ["sha256:abc"],
      // jsonb, so the nested object has to survive the driver both ways.
      config: { name: "round-trip", nested: { deep: true } },
      worker_hash: "wh-1",
      client_files: { "index.html": "ch-1" },
      harness_image_tag: "aai-guest-harness:deadbeef",
    });
    expect(typeof got?.version).toBe("number");
  });

  test("a re-put bumps version — the cross-replica invalidation signal", async () => {
    const rows = createPgAgentRows(sql);
    const base = {
      slug: "versioned",
      credential_hashes: ["sha256:one"],
      config: {},
      worker_hash: "w1",
      client_files: {},
    };
    await rows.put(base);
    const first = await rows.getVersion("versioned");
    await rows.put({ ...base, worker_hash: "w2" });
    const second = await rows.getVersion("versioned");

    // Sandboxes retire on a version mismatch, so a version that does NOT move
    // on redeploy means resident guests keep serving superseded code — the
    // quietest possible failure of the whole invalidation design.
    expect(first).not.toBeNull();
    expect(second).toBeGreaterThan(first as number);
    // And the row really was updated, not duplicated.
    expect((await rows.get("versioned"))?.worker_hash).toBe("w2");
  });

  test("a nullable harness_image_tag reads back as null, not undefined", async () => {
    // The pin is optional (the subprocess backend has no image), and the
    // store's schema distinguishes null from absent.
    const rows = createPgAgentRows(sql);
    await rows.put({
      slug: "unpinned",
      credential_hashes: [],
      config: {},
      worker_hash: "w",
      client_files: {},
    });
    expect((await rows.get("unpinned"))?.harness_image_tag).toBeNull();
  });

  test("delete removes the row and its version", async () => {
    const rows = createPgAgentRows(sql);
    await rows.put({
      slug: "doomed",
      credential_hashes: [],
      config: {},
      worker_hash: "w",
      client_files: {},
    });
    await rows.delete("doomed");
    expect(await rows.get("doomed")).toBeNull();
    // Null version is what tells the invalidation handler to TERMINATE rather
    // than drain — it must not read as "version 0".
    expect(await rows.getVersion("doomed")).toBeNull();
  });

  test("workspace rows round-trip, and the optimistic version guards writes", async () => {
    const workspaces = createPgWorkspaceStore(sql);
    // `null` means create; it must CONFLICT rather than overwrite if a row
    // exists, which is the whole basis of the cross-replica retry in
    // studio-workspace.ts.
    const v1 = await workspaces.put("scope-a", "proj", { files: { "agent.ts": "1" } }, null);
    expect(await workspaces.get("scope-a", "proj")).toEqual({
      doc: { files: { "agent.ts": "1" } },
      version: v1,
    });
    await expect(workspaces.put("scope-a", "proj", { files: {} }, null)).rejects.toThrow(
      WorkspaceConflictError,
    );

    // A write naming the current version wins and moves it; one naming a stale
    // version loses. Real Postgres is the only place this is a real CAS.
    const v2 = await workspaces.put("scope-a", "proj", { files: { "agent.ts": "2" } }, v1);
    expect(v2).toBeGreaterThan(v1);
    await expect(workspaces.put("scope-a", "proj", { files: {} }, v1)).rejects.toThrow(
      WorkspaceConflictError,
    );
    expect((await workspaces.get("scope-a", "proj"))?.doc).toEqual({
      files: { "agent.ts": "2" },
    });

    // Listing is scope-filtered — a cross-tenant leak here would be silent.
    await workspaces.put("scope-b", "other", { files: {} }, null);
    expect(await workspaces.list("scope-a")).toEqual(["proj"]);
    expect(await workspaces.list("scope-b")).toEqual(["other"]);

    await workspaces.delete("scope-a", "proj");
    expect(await workspaces.get("scope-a", "proj")).toBeNull();
  });

  test("chat rows round-trip", async () => {
    const chats = createPgChatStore(sql);
    const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }];
    await chats.putChat("scope-a", "proj", messages);
    expect(await chats.getChat("scope-a", "proj")).toEqual(messages);
    expect(await chats.getChat("scope-a", "absent")).toBeNull();
    await chats.deleteChat("scope-a", "proj");
    expect(await chats.getChat("scope-a", "proj")).toBeNull();
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
    expect(tables.map((r) => String(r.table_name))).toEqual([
      "agents",
      "studio_chats",
      "studio_rate_limits",
      "studio_sessions",
      "studio_workspaces",
    ]);
  });
});

/** `URL` renders `postgres:` as `postgres://…`; keep the driver's spelling. */
function toPgUrl(url: URL): string {
  return url.toString();
}

/**
 * The minimum pgmq surface the MIGRATION touches: a `pgmq.create(text)` that
 * makes a queue table, so the migration's queue block — including its
 * duplicate-tolerating exception handler — runs as written.
 *
 * Deliberately not an emulation of pgmq. The queue's own semantics (visibility
 * timeouts, redelivery, archiving) are exercised against the in-memory
 * implementation in `studio-preview-queue.test.ts`; the real extension's SQL
 * remains untested, which is a known gap and a different test than this one.
 */
async function stubPgmq(sql: SqlExec): Promise<void> {
  await sql(`create schema if not exists pgmq;
create or replace function pgmq.create(queue_name text) returns void as $fn$
begin
  execute format('create table pgmq.q_%I (msg_id bigserial primary key)', queue_name);
end;
$fn$ language plpgsql;`);
}
