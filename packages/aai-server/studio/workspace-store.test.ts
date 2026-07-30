// Copyright 2026 the AAI authors. MIT license.
// WorkspaceStore: SQL shapes of the Postgres implementation (via a fake
// SqlExec backed by a Map), and behavioral parity between the pg and memory
// stores — versions included, so dev/tests cannot drift from production.

import { describe, expect, test } from "vitest";
import type { SqlExec } from "../secret-store.ts";
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
  test("lazily creates the aai_platform schema and table exactly once", async () => {
    const { sql, log } = createFakeSql();
    const store = createPgWorkspaceStore(sql);
    await store.put("s", "p", { v: 1 }, null);
    await store.get("s", "p");
    await store.list("s");
    const ddl = log.filter((entry) => entry.query.startsWith("create"));
    expect(ddl.map((entry) => entry.query)).toEqual([
      "create schema if not exists aai_platform",
      expect.stringContaining("create table if not exists aai_platform.studio_workspaces"),
    ]);
    // Deliberately NOT the public schema.
    expect(ddl[1]?.query).toContain("version integer not null default 1");
    expect(ddl[1]?.query).toContain("primary key (scope, project)");
  });

  test("a failed ensure is retried on the next call, not memoized", async () => {
    const { sql } = createFakeSql({ failEnsures: 1 });
    const store = createPgWorkspaceStore(sql);
    await expect(store.get("s", "p")).rejects.toThrow("ddl refused");
    expect(await store.get("s", "p")).toBeNull();
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
