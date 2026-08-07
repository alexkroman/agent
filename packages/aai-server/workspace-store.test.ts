// Copyright 2026 the AAI authors. MIT license.
// WorkspaceStore: SQL shapes of the Postgres implementation (via a fake
// SqlExec backed by a Map), and behavioral parity between the pg and memory
// stores — versions included, so dev/tests cannot drift from production.

import { describe, expect, test } from "vitest";
import type { SqlExec } from "./secret-store.ts";
import {
  createMemoryWorkspaceStore,
  createPgWorkspaceStore,
  WorkspaceConflictError,
  type WorkspaceStore,
} from "./workspace-store.ts";

/**
 * Fake SqlExec implementing the store's five statements over a Map, keeping
 * a log of every statement for shape assertions. Documents are stored (and
 * returned) as the bound JSON string, which also exercises the store's
 * string-doc parse branch.
 */
function createFakeSql(opts: { failEnsures?: number } = {}) {
  type Handler = (params: unknown[]) => Record<string, unknown>[];
  const rows = new Map<string, { doc: string; version: number }>();
  const log: { query: string; params: unknown[] }[] = [];
  let ensureFailures = opts.failEnsures ?? 0;
  const key = (scope: unknown, project: unknown) => `${scope} ${project}`;

  const ddl: Handler = () => {
    if (ensureFailures > 0) {
      ensureFailures -= 1;
      throw new Error("ddl refused");
    }
    return [];
  };
  const selectRow: Handler = ([scope, project]) => {
    const row = rows.get(key(scope, project));
    return row ? [{ doc: row.doc, version: row.version }] : [];
  };
  const insertRow: Handler = ([scope, project, doc]) => {
    const k = key(scope, project);
    if (rows.has(k)) return [];
    rows.set(k, { doc: String(doc), version: 1 });
    return [{ version: 1 }];
  };
  const updateRow: Handler = ([scope, project, doc, expected]) => {
    const k = key(scope, project);
    const row = rows.get(k);
    if (!row || row.version !== expected) return [];
    const version = row.version + 1;
    rows.set(k, { doc: String(doc), version });
    return [{ version }];
  };
  // `(doc - $4::text[]) || $3::jsonb` — removals, then the merge, matching
  // the statement's own evaluation order. Distinguished from the versioned
  // update by a longer prefix (both statements begin `update <table> set doc
  // =`), and listed FIRST so that longer prefix is the one that matches.
  const patchRow: Handler = ([scope, project, set, remove]) => {
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
  const deleteRow: Handler = ([scope, project]) => {
    rows.delete(key(scope, project));
    return [];
  };
  const listRows: Handler = ([scope]) => {
    const prefix = `${scope} `;
    return [...rows.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => ({ project: k.slice(prefix.length) }))
      .sort((a, b) => a.project.localeCompare(b.project));
  };
  const handlers: [string, Handler][] = [
    ["create schema", ddl],
    ["create table", ddl],
    ["select doc, version", selectRow],
    ["insert into", insertRow],
    ["update aai_platform.studio_workspaces set doc = (doc -", patchRow],
    ["update", updateRow],
    ["delete", deleteRow],
    ["select project", listRows],
  ];

  const sql: SqlExec = (query, params = []) => {
    log.push({ query, params });
    const q = query.replace(/\s+/g, " ").trim().toLowerCase();
    const handler = handlers.find(([prefix]) => q.startsWith(prefix))?.[1];
    if (!handler) return Promise.reject(new Error(`Unexpected query: ${query}`));
    try {
      return Promise.resolve(handler(params));
    } catch (err) {
      return Promise.reject(err);
    }
  };

  return { sql, log };
}

// ── Behavioral parity: both implementations must agree ─────────────────────

const implementations: [string, () => WorkspaceStore][] = [
  ["memory", () => createMemoryWorkspaceStore()],
  ["postgres (fake SqlExec)", () => createPgWorkspaceStore(createFakeSql().sql)],
];

describe.each(implementations)("WorkspaceStore parity: %s", (_name, make) => {
  test("get returns null for a missing row", async () => {
    expect(await make().get("s", "ghost")).toBeNull();
  });

  test("create + get round-trips the doc at version 1", async () => {
    const store = make();
    expect(await store.put("s", "p", { files: { "a.ts": "1" } }, null)).toBe(1);
    expect(await store.get("s", "p")).toEqual({ doc: { files: { "a.ts": "1" } }, version: 1 });
  });

  test("creating an existing row conflicts and leaves it untouched", async () => {
    const store = make();
    await store.put("s", "p", { v: "winner" }, null);
    await expect(store.put("s", "p", { v: "loser" }, null)).rejects.toThrow(WorkspaceConflictError);
    expect(await store.get("s", "p")).toEqual({ doc: { v: "winner" }, version: 1 });
  });

  test("a versioned update bumps the version", async () => {
    const store = make();
    await store.put("s", "p", { v: 1 }, null);
    expect(await store.put("s", "p", { v: 2 }, 1)).toBe(2);
    expect(await store.get("s", "p")).toEqual({ doc: { v: 2 }, version: 2 });
  });

  test("an update against a stale version conflicts without writing", async () => {
    const store = make();
    await store.put("s", "p", { v: 1 }, null);
    await store.put("s", "p", { v: 2 }, 1);
    await expect(store.put("s", "p", { v: "stale" }, 1)).rejects.toThrow(WorkspaceConflictError);
    expect(await store.get("s", "p")).toEqual({ doc: { v: 2 }, version: 2 });
  });

  test("an update against a missing row conflicts (never creates)", async () => {
    const store = make();
    await expect(store.put("s", "ghost", { v: 1 }, 1)).rejects.toThrow(WorkspaceConflictError);
    expect(await store.get("s", "ghost")).toBeNull();
  });

  test("delete removes the row and is idempotent", async () => {
    const store = make();
    await store.put("s", "p", { v: 1 }, null);
    await store.delete("s", "p");
    expect(await store.get("s", "p")).toBeNull();
    await store.delete("s", "p"); // no throw
  });

  test("patch merges named keys and leaves every other one alone", async () => {
    const store = make();
    await store.put("s", "p", { files: { "a.ts": "1" }, deployedSlug: "old" }, null);
    const patched = await store.patch("s", "p", { set: { deployedSlug: "new" } });
    // The file map is untouched WITHOUT having been read or rewritten — the
    // whole reason this operation exists.
    expect(patched).toEqual({
      doc: { files: { "a.ts": "1" }, deployedSlug: "new" },
      version: 2,
    });
  });

  test("patch removes keys, and a key in both set and remove is set", async () => {
    const store = make();
    await store.put("s", "p", { files: {}, previewHash: "h", previewError: "boom" }, null);
    const patched = await store.patch("s", "p", {
      set: { previewHash: "fresh" },
      remove: ["previewError", "previewHash"],
    });
    // Removals apply first, then the merge — so naming a key in both is a
    // SET in either implementation, never an accidental delete.
    expect(patched?.doc).toEqual({ files: {}, previewHash: "fresh" });
  });

  test("patch bumps the version — it is what drives the change stream", async () => {
    const store = make();
    await store.put("s", "p", { files: {} }, null);
    expect((await store.patch("s", "p", { set: { a: 1 } }))?.version).toBe(2);
    expect((await store.patch("s", "p", { set: { b: 2 } }))?.version).toBe(3);
    // And it takes no expected version, so two stamps of different fields
    // both land — where the versioned put made one of them retry.
    expect((await store.get("s", "p"))?.doc).toEqual({ files: {}, a: 1, b: 2 });
  });

  test("patch of a missing row resolves null and never creates one", async () => {
    const store = make();
    expect(await store.patch("s", "ghost", { set: { a: 1 } })).toBeNull();
    expect(await store.get("s", "ghost")).toBeNull();
  });

  test("patch cannot clobber a write that landed after it was composed", async () => {
    // The concurrency property the versioned read-modify-write could only get
    // by DETECTING the race and retrying: a patch carries no files, so a file
    // write landing between composing the stamp and applying it survives.
    const store = make();
    await store.put("s", "p", { files: { "a.ts": "before" } }, null);
    const stamp = { set: { deployedSlug: "x" } };
    await store.put("s", "p", { files: { "a.ts": "after" } }, 1);
    const patched = await store.patch("s", "p", stamp);
    expect(patched?.doc).toEqual({ files: { "a.ts": "after" }, deployedSlug: "x" });
  });

  test("list is scoped and sorted", async () => {
    const store = make();
    await store.put("s1", "beta", {}, null);
    await store.put("s1", "alpha", {}, null);
    await store.put("s2", "other", {}, null);
    expect(await store.list("s1")).toEqual(["alpha", "beta"]);
    expect(await store.list("s2")).toEqual(["other"]);
    expect(await store.list("s3")).toEqual([]);
  });
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
    expect(insert?.query).toContain("$3::jsonb");
    expect(insert?.query).toContain("on conflict do nothing returning version");
    expect(insert?.params).toEqual(["s", "p", JSON.stringify({ v: 1 })]);
  });

  test("update is version-guarded and bumps version + updated_at", async () => {
    const { sql, log } = createFakeSql();
    const store = createPgWorkspaceStore(sql);
    await store.put("s", "p", { v: 1 }, null);
    await store.put("s", "p", { v: 2 }, 1);
    const update = log.find((entry) => entry.query.includes("update aai_platform"));
    expect(update?.query).toContain("set doc = $3::jsonb, version = version + 1");
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
    const sql: SqlExec = (query) =>
      Promise.resolve(
        query.includes("select doc, version") ? [{ doc: { v: "object" }, version: 3 }] : [],
      );
    const store = createPgWorkspaceStore(sql);
    expect(await store.get("s", "p")).toEqual({ doc: { v: "object" }, version: 3 });
  });
});
