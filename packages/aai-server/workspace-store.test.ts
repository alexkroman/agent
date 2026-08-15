// Copyright 2026 the AAI authors. MIT license.
// WorkspaceStore: the CONTRACT over the memory arm (shared with the stack arm —
// see store-conformance.ts), the memory arm's own no-aliasing property, and the
// STATEMENTS the Postgres implementation issues, recorded through a fake SqlExec.

import { describe, expect, test } from "vitest";
import { workspaceStoreConformance } from "./store-conformance-cases.ts";
import {
  createDispatchingSql,
  createRecordingSql,
  refusingDdl,
  type SqlHandler,
} from "./test-utils.ts";
import { createMemoryWorkspaceStore, createPgWorkspaceStore } from "./workspace-store.ts";

/**
 * Fake SqlExec implementing the store's five statements over a Map, keeping
 * a log of every statement for shape assertions. Documents are stored (and
 * returned) as the bound JSON string, which also exercises the store's
 * string-doc parse branch.
 */
function createFakeSql(opts: { failEnsures?: number } = {}) {
  const rows = new Map<string, { doc: string; version: number }>();
  const key = (scope: unknown, project: unknown) => `${scope} ${project}`;

  const ddl = refusingDdl(opts.failEnsures);
  const selectRow: SqlHandler = ([scope, project]) => {
    const row = rows.get(key(scope, project));
    return row ? [{ doc: row.doc, version: row.version }] : [];
  };
  const insertRow: SqlHandler = ([scope, project, doc]) => {
    const k = key(scope, project);
    if (rows.has(k)) return [];
    rows.set(k, { doc: String(doc), version: 1 });
    return [{ version: 1 }];
  };
  const updateRow: SqlHandler = ([scope, project, doc, expected]) => {
    const k = key(scope, project);
    const row = rows.get(k);
    if (!row || row.version !== expected) return [];
    const version = row.version + 1;
    rows.set(k, { doc: String(doc), version });
    return [{ version }];
  };
  // `((doc #>> '{}')::jsonb - $4::text[]) || $3::text::jsonb` — removals, then
  // the merge, matching the statement's own evaluation order. The `#>> '{}'`
  // unwrap has no analogue here: this fake stores the doc as text and parses
  // it on every read, so it cannot represent the double-encoded row the
  // unwrap exists for. That shape is covered against a real Postgres in
  // jsonb-encoding.scenario.test.ts, which is the only place it is
  // representable at all. Distinguished from the versioned update by a longer
  // prefix (both statements begin `update <table> set doc =`), and listed
  // FIRST so that longer prefix is the one that matches.
  const patchRow: SqlHandler = ([scope, project, set, remove]) => {
    const k = key(scope, project);
    const row = rows.get(k);
    if (!row) return [];
    const doc = JSON.parse(row.doc) as Record<string, unknown>;
    for (const name of remove as string[]) delete doc[name];
    const merged = { ...doc, ...(JSON.parse(String(set)) as Record<string, unknown>) };
    const version = row.version + 1;
    rows.set(k, { doc: JSON.stringify(merged), version });
    return [{ doc: JSON.stringify(merged), version }];
  };
  const deleteRow: SqlHandler = ([scope, project]) => {
    rows.delete(key(scope, project));
    return [];
  };
  const listRows: SqlHandler = ([scope]) => {
    const prefix = `${scope} `;
    return [...rows.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => ({ project: k.slice(prefix.length) }))
      .sort((a, b) => a.project.localeCompare(b.project));
  };
  return createDispatchingSql([
    ["create schema", ddl],
    ["create table", ddl],
    ["select doc, version", selectRow],
    ["insert into", insertRow],
    ["update aai_platform.studio_workspaces set doc = ((doc", patchRow],
    ["update", updateRow],
    ["delete", deleteRow],
    ["select project", listRows],
  ]);
}

// ── The CONTRACT, over the arm that runs everywhere ─────────────────────────
//
// One case list, in `store-conformance.ts`, shared with the stack arm in
// `store-conformance.scenario.test.ts`. The memory arm is unconditional and so
// keeps covering this module on every machine; the stack arm adds the semantics
// a JS value cannot hold.
//
// The arm this REPLACED was labelled `postgres` and was `createFakeSql()` — a
// hand-written JS reimplementation of this store's own SQL, i.e. a third
// implementation of the contract, and the one a reader trusts most because of
// its label. It could not represent the `::text::jsonb` double-encode that broke
// every metadata stamp in production. It is not gone: it is a RECORDER, and what
// it uniquely asserts (the statements this store issues, and the DDL it must
// never issue) is the subject of `createPgWorkspaceStore SQL` below.

describe("WorkspaceStore conformance: memory", () => {
  workspaceStoreConformance(() => createMemoryWorkspaceStore());
});

test("memory store never shares mutable state with callers", async () => {
  const store = createMemoryWorkspaceStore();
  const doc = { files: { "a.ts": "1" } };
  await store.put("s", "p", doc, null);
  doc.files["a.ts"] = "mutated-after-put";
  const readDoc = async () => (await store.get("s", "p"))?.doc as { files: Record<string, string> };
  const read = await readDoc();
  expect(read.files["a.ts"]).toBe("1");
  read.files["a.ts"] = "mutated-after-get";
  expect((await readDoc()).files["a.ts"]).toBe("1");
});

// ── Postgres SQL shapes ─────────────────────────────────────────────────────

describe("createPgWorkspaceStore SQL", () => {
  /**
   * The table is declared in supabase/migrations, applied before any code
   * runs. A store that issues DDL is the regression: it papers over a missed
   * migration and creates the table under whatever connection first noticed.
   */
  test("issues no DDL — the schema comes from migrations", async () => {
    const { sql, log } = createFakeSql();
    const store = createPgWorkspaceStore(sql);
    await store.put("s", "p", { v: 1 }, null);
    await store.get("s", "p");
    await store.list("s");
    expect(log.filter((entry) => /^\s*(create|alter)/i.test(entry.query))).toEqual([]);
  });

  test("create is insert … on conflict do nothing with the doc as jsonb", async () => {
    const { sql, log } = createFakeSql();
    await createPgWorkspaceStore(sql).put("s", "p", { v: 1 }, null);
    const insert = log.find((entry) => entry.query.includes("insert into"));
    expect(insert?.query).toContain("aai_platform.studio_workspaces");
    // `::text::jsonb`, never a bare `$3::jsonb`: the driver types the parameter
    // from the cast and JSON-encodes an already-encoded document, storing a
    // jsonb STRING. See the store's doc comment and the integration suite.
    expect(insert?.query).toContain("$3::text::jsonb");
    expect(insert?.query).toContain("on conflict do nothing returning version");
    expect(insert?.params).toEqual(["s", "p", JSON.stringify({ v: 1 })]);
  });

  test("update is version-guarded and bumps version + updated_at", async () => {
    const { sql, log } = createFakeSql();
    const store = createPgWorkspaceStore(sql);
    await store.put("s", "p", { v: 1 }, null);
    await store.put("s", "p", { v: 2 }, 1);
    const update = log.find((entry) => entry.query.includes("update aai_platform"));
    expect(update?.query).toContain("set doc = $3::text::jsonb, version = version + 1");
    expect(update?.query).toContain("updated_at = now()");
    expect(update?.query).toContain("where scope = $1 and project = $2 and version = $4");
    expect(update?.params).toEqual(["s", "p", JSON.stringify({ v: 2 }), 1]);
  });

  test("get/delete/list bind scope and project as parameters", async () => {
    const { sql, log } = createFakeSql();
    const store = createPgWorkspaceStore(sql);
    await store.get("sc", "pr");
    await store.delete("sc", "pr");
    await store.list("sc");
    const [get, del, list] = log.filter((entry) => !entry.query.startsWith("create"));
    expect(get).toEqual({
      query: expect.stringContaining("select doc, version"),
      params: ["sc", "pr"],
    });
    expect(del).toEqual({ query: expect.stringContaining("delete from"), params: ["sc", "pr"] });
    expect(list).toEqual({
      query: expect.stringContaining("order by project"),
      params: ["sc"],
    });
  });

  test("patch binds no document — the file map never crosses the wire", async () => {
    const { sql, log } = createFakeSql();
    const store = createPgWorkspaceStore(sql);
    const files = { "agent.ts": "x".repeat(5000) };
    await store.put("s", "p", { files, deployedSlug: "old" }, null);
    log.length = 0;

    await store.patch("s", "p", { set: { deployedSlug: "new" }, remove: ["previewError"] });

    const [statement] = log;
    // The measurable claim: recording a slug sends the slug, not the project.
    // A `doc` bind here would mean the read-modify-write came back in
    // disguise, which is exactly the regression this operation exists to
    // prevent and the one that no behavioural assertion can see.
    expect(JSON.stringify(statement?.params)).not.toContain("agent.ts");
    expect(statement?.params).toEqual([
      "s",
      "p",
      JSON.stringify({ deployedSlug: "new" }),
      ["previewError"],
    ]);
    // ...and it reads nothing first.
    expect(log.filter((entry) => entry.query.includes("select"))).toEqual([]);
  });

  test("reads accept a jsonb doc that arrives pre-parsed", async () => {
    // The `postgres` driver returns jsonb columns as objects; the fake above
    // returns strings. Both must parse identically.
    const { sql } = createRecordingSql((query) =>
      query.includes("select doc, version") ? [{ doc: { v: "object" }, version: 3 }] : [],
    );
    const store = createPgWorkspaceStore(sql);
    expect(await store.get("s", "p")).toEqual({ doc: { v: "object" }, version: 3 });
  });
});
