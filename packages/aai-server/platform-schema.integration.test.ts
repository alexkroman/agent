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
 * pg_cron, pgmq and pg_net are Supabase-provided and cannot be installed on a
 * stock server (all three are compiled extensions; pg_cron additionally needs
 * `shared_preload_libraries`). Everything else — every table, index, the
 * publication block, the grants, the foreign keys, and the pgmq queue
 * creation — executes VERBATIM, because `stubPgmq` below supplies the one
 * function the migration calls.
 *
 * pg_net needs no stub, unlike pgmq: nothing in the migrations CALLS `net.*`.
 * Its only consumer is a pg_cron sweep body, which lives in TypeScript
 * (pg-cron.ts) and guards itself on `to_regnamespace('net')` — so a database
 * without the extension is a sweep that no-ops, which is exactly the shape
 * this stock server stands in for.
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
  // `with schema extensions` is part of the line for pg_net (Supabase's
  // convention; a bare create lands the extension in `public`), so the pattern
  // has to allow the clause or that one silently stops being stripped — the
  // count below is what turns "silently" into a failure.
  const sql = raw.replace(/^create extension if not exists \w+(?: with schema \w+)?;$/gm, () => {
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

  test("needs exactly the three extensions that cannot be installed locally", () => {
    // Guards the substitution above: if the migration grows another extension,
    // decide whether it is testable rather than quietly skipping it. pg_net
    // was the third such decision — see the note on
    // `migrationForStockPostgres`.
    expect(migrationForStockPostgres().stripped).toBe(3);
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
      worker_hash: "wh-1",
      client_files: { "index.html": "ch-1" },
      harness_image_tag: "aai-guest-harness:deadbeef",
    });

    const got = await rows.get("round-trip");
    expect(got).toMatchObject({
      slug: "round-trip",
      credential_hashes: ["sha256:abc"],
      // jsonb, so the nested object has to survive the driver both ways.
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
    // A chat BELONGS to a workspace (`studio_chats_workspace_fk`), so the
    // project has to exist first — which is the real ordering: a chat row is
    // only ever written by `studio/persist-chat`, at the end of a turn in a
    // session brokered against an existing project. Writing one standalone
    // is a shape production never produces, and until the foreign key landed
    // this test was the only place it happened.
    const workspaces = createPgWorkspaceStore(sql);
    await workspaces.put("scope-chat", "proj", { files: {} }, null);

    const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }];
    await chats.putChat("scope-chat", "proj", messages);
    expect(await chats.getChat("scope-chat", "proj")).toEqual(messages);
    expect(await chats.getChat("scope-chat", "absent")).toBeNull();
    await chats.deleteChat("scope-chat", "proj");
    expect(await chats.getChat("scope-chat", "proj")).toBeNull();
  });

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
    //
    // PARTITIONS are excluded rather than listed: `agent_events` is range
    // partitioned by day, so its children are named after dates and the set
    // changes every time the clock does — an exact list of them would be a
    // test that fails tomorrow. `pg_inherits` is what tells a partition from a
    // declared table; the parent and the default backstop are both named
    // below, so nothing about the partitioned table goes unasserted.
    const tables = await sql(
      `select c.relname from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'aai_platform'
          and c.relkind in ('r', 'p')
          and not exists (select 1 from pg_inherits i where i.inhrelid = c.oid)
        order by c.relname`,
    );
    expect(tables.map((r) => String(r.relname))).toEqual([
      "agent_events",
      "agents",
      "studio_chats",
      "studio_rate_limits",
      "studio_sessions",
      "studio_workspaces",
    ]);
  });

  test("agent_events is partitioned, with the default backstop attached", async () => {
    const [parent] = await sql(
      "select relkind::text as kind from pg_class where oid = 'aai_platform.agent_events'::regclass",
    );
    // 'p' — a partitioned table. If this ever reads 'r', retention silently
    // stopped being `drop table` on a partition and became nothing at all.
    expect(parent?.kind).toBe("p");

    const children = await sql(
      `select c.relname from pg_class c
         join pg_inherits i on i.inhrelid = c.oid
        where i.inhparent = 'aai_platform.agent_events'::regclass`,
    );
    const names = children.map((r) => String(r.relname));
    expect(names).toContain("agent_events_default");
    // The migration creates the first week itself, so a fresh deployment never
    // writes into the default — see agent-events-partitions.integration.test.ts.
    expect(names.filter((n) => /^agent_events_\d{8}$/.test(n)).length).toBeGreaterThan(0);
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
