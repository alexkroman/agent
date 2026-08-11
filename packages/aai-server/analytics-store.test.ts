// Copyright 2026 the AAI authors. MIT license.
/**
 * The Postgres store's SQL, at the level a unit test can hold it: what
 * statements it issues and in what order.
 *
 * The ad-hoc query path is the reason this file exists. Its guarantees are
 * transaction-local settings applied in a specific order on a specific
 * connection, and every one of them is silently inert if it moves — the
 * statement still runs and still returns rows, just without the protection.
 * A live-database test would be better and is `schema-drift`-tier work; this
 * pins the shape so a reordering is a failing test rather than a quiet
 * regression.
 */

import { describe, expect, test, vi } from "vitest";
import {
  ANALYTICS_QUERY_ROW_CAP,
  createMemoryAnalyticsStore,
  createPostgresAnalyticsStore,
} from "./analytics-store.ts";
import type { AdminDb } from "./platform-lock.ts";
import type { SqlExec } from "./secret-store.ts";

type Reserved = Awaited<ReturnType<AdminDb["reserve"]>>;

/** An `AdminDb` whose one connection records every statement it is handed. */
function fakeDb() {
  const statements: { sql: string; params?: unknown[] }[] = [];
  const release = vi.fn();
  const reserved: Reserved = {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      statements.push({ sql, ...(params && { params }) });
      return Promise.resolve((sql.startsWith("select *") ? [{ n: 1 }] : []) as T[]);
    },
    release,
  };
  const db: AdminDb = { reserve: () => Promise.resolve(reserved) };
  return { db, statements, release, sqlText: () => statements.map((s) => s.sql) };
}

/** A pooled executor that records queries and returns nothing. */
function fakeExec(): SqlExec & { queries: string[] } {
  const queries: string[] = [];
  const exec = (sql: string): Promise<Record<string, unknown>[]> => {
    queries.push(sql);
    return Promise.resolve([]);
  };
  return Object.assign(exec, { queries });
}

/** An `AdminDb` that fails if reserved — for the pooled read paths. */
const unusedDb: AdminDb = { reserve: () => Promise.reject(new Error("not used here")) };

function storeWith(db: AdminDb) {
  const pooled = fakeExec();
  return { pooled, store: createPostgresAnalyticsStore(pooled, db) };
}

const REQUEST = {
  sql: "select * from x",
  params: ["p"],
  slugs: ["a", "a-preview"],
  limit: ANALYTICS_QUERY_ROW_CAP,
};

describe("ad-hoc queries run as the reader role", () => {
  test("sets the scope BEFORE switching role, so the reader cannot widen it", async () => {
    const { db, sqlText, statements } = fakeDb();
    await storeWith(db).store.runScoped(REQUEST);

    const text = sqlText();
    const scopeAt = text.findIndex((s) => s.includes("aai.analytics_slugs"));
    const roleAt = text.findIndex((s) => s.includes("set local role"));
    expect(scopeAt).toBeGreaterThanOrEqual(0);
    expect(roleAt).toBeGreaterThan(scopeAt);
    // Bound, never interpolated.
    expect(statements[scopeAt]?.params).toEqual(["a,a-preview"]);
  });

  test("switches to the reader role — without it the owner bypasses RLS", async () => {
    const { db, sqlText } = fakeDb();
    await storeWith(db).store.runScoped(REQUEST);
    expect(sqlText()).toContain("set local role aai_analytics_reader");
  });

  test("marks the transaction read only and bounds the statement", async () => {
    const { db, sqlText } = fakeDb();
    await storeWith(db).store.runScoped(REQUEST);
    expect(sqlText()).toContain("set local transaction read only");
    expect(sqlText().some((s) => s.startsWith("set local statement_timeout"))).toBe(true);
  });

  test("runs everything inside ONE transaction on ONE reserved connection", async () => {
    // `set local` is transaction-scoped: over a pool the settings and the
    // statement could land on different connections, and every guarantee
    // above would be applied to a connection the query never used.
    const { db, sqlText, release } = fakeDb();
    const { store } = storeWith(db);
    await store.runScoped(REQUEST);
    const text = sqlText();
    expect(text[0]).toBe("begin");
    expect(text).toContain("commit");
    expect(text.indexOf(REQUEST.sql)).toBeGreaterThan(text.indexOf("set local role"));
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("rolls back and releases when the query fails", async () => {
    const statements: string[] = [];
    const release = vi.fn();
    const reserved: Reserved = {
      query: <T = Record<string, unknown>>(sql: string) => {
        statements.push(sql);
        return sql === "boom"
          ? Promise.reject(new Error("syntax error"))
          : Promise.resolve([] as T[]);
      },
      release,
    };
    const { store } = storeWith({ reserve: () => Promise.resolve(reserved) });
    await expect(store.runScoped({ ...REQUEST, sql: "boom" })).rejects.toThrow("syntax error");
    expect(statements).toContain("rollback");
    expect(release).toHaveBeenCalledTimes(1);
  });

  // `truncated` is the model's only signal that its result was cut, and it
  // was permanently false: the store compared against the MODULE cap while the
  // statement carried the caller's own. `query_analytics` always sends
  // `limit: 100`, so 101 rows came back and 101 > 1000 is never true.
  test.each([
    [3, 4, true],
    [3, 3, false],
  ])("reports truncation against the statement's own limit (%i)", async (limit, rows, cut) => {
    const reserved: Reserved = {
      query: <T = Record<string, unknown>>(sql: string) =>
        Promise.resolve(
          (sql === "select * from x"
            ? Array.from({ length: rows }, (_, i) => ({ n: i }))
            : []) as T[],
        ),
      release: vi.fn(),
    };
    const { store } = storeWith({ reserve: () => Promise.resolve(reserved) });
    const result = await store.runScoped({ ...REQUEST, limit });
    expect(result.truncated).toBe(cut);
    // And the probe row never reaches the caller.
    expect(result.rows.length).toBe(Math.min(rows, limit));
  });

  test("does not use the pooled executor at all", async () => {
    const { db } = fakeDb();
    const { store, pooled } = storeWith(db);
    await store.runScoped(REQUEST);
    expect(pooled.queries).toEqual([]);
  });
});

describe("reads are bounded for partition pruning", () => {
  test("summaryRows and logs both filter on received_at, the partition key", async () => {
    // Filtering only on `ts` is correct and scans every partition in the
    // window — the table is partitioned on `received_at`.
    const pooled = fakeExec();
    const store = createPostgresAnalyticsStore(pooled, unusedDb);
    await store.summaryRows({ slugs: ["a"], sinceMs: 0 });
    await store.logs({ slugs: ["a"], sinceMs: 0, limit: 10 });
    expect(pooled.queries).toHaveLength(2);
    for (const query of pooled.queries) expect(query).toContain("received_at >= $2");
  });

  test("an empty slug list reads nothing rather than everything", async () => {
    const pooled = fakeExec();
    const store = createPostgresAnalyticsStore(pooled, unusedDb);
    await expect(store.summaryRows({ slugs: [], sinceMs: 0 })).resolves.toEqual([]);
    await expect(store.logs({ slugs: [], sinceMs: 0, limit: 10 })).resolves.toEqual([]);
    expect(pooled.queries).toEqual([]);
  });
});

describe("the memory store", () => {
  test("refuses ad-hoc SQL instead of answering empty", async () => {
    // Dev and tests have no database to evaluate it — and "no rows" would read
    // as a real empty result.
    await expect(createMemoryAnalyticsStore().runScoped(REQUEST)).rejects.toThrow(
      /requires the platform database/i,
    );
  });

  test("scopes summary rows by slug and window", async () => {
    const store = createMemoryAnalyticsStore();
    await store.append([
      { slug: "a", sessionId: "s", ts: 1000, kind: "user_turn", turn: 1 },
      { slug: "b", sessionId: "s", ts: 1000, kind: "user_turn", turn: 1 },
      { slug: "a", sessionId: "s", ts: 10, kind: "user_turn", turn: 1 },
    ]);
    const rows = await store.summaryRows({ slugs: ["a"], sinceMs: 100 });
    expect(rows).toHaveLength(1);
  });
});
