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
  createMemoryAnalyticsStore,
  createPostgresAnalyticsStore,
  type ReservedConnection,
} from "./analytics-store.ts";
import type { SqlExec } from "./secret-store.ts";

/** A reserved connection that records every statement it is handed. */
function fakeConnection() {
  const statements: { sql: string; params?: unknown[] }[] = [];
  const release = vi.fn();
  const conn: ReservedConnection = {
    query: (sql, params) => {
      statements.push({ sql, ...(params && { params }) });
      return Promise.resolve(sql.startsWith("select *") ? [{ n: 1 }] : []);
    },
    release,
  };
  return { conn, statements, release, sqlText: () => statements.map((s) => s.sql) };
}

function storeWith(conn: ReservedConnection) {
  const pooled = vi.fn(() => Promise.resolve([])) as unknown as SqlExec;
  return {
    pooled,
    store: createPostgresAnalyticsStore(pooled, () => Promise.resolve(conn)),
  };
}

const REQUEST = { sql: "select * from x", params: ["p"], slugs: ["a", "a-preview"] };

describe("ad-hoc queries run as the reader role", () => {
  test("sets the scope BEFORE switching role, so the reader cannot widen it", async () => {
    const { conn, sqlText, statements } = fakeConnection();
    await storeWith(conn).store.runScoped(REQUEST);

    const text = sqlText();
    const scopeAt = text.findIndex((s) => s.includes("aai.analytics_slugs"));
    const roleAt = text.findIndex((s) => s.includes("set local role"));
    expect(scopeAt).toBeGreaterThanOrEqual(0);
    expect(roleAt).toBeGreaterThan(scopeAt);
    // Bound, never interpolated.
    expect(statements[scopeAt]?.params).toEqual(["a,a-preview"]);
  });

  test("switches to the reader role — without it the owner bypasses RLS", async () => {
    const { conn, sqlText } = fakeConnection();
    await storeWith(conn).store.runScoped(REQUEST);
    expect(sqlText()).toContain("set local role aai_analytics_reader");
  });

  test("marks the transaction read only and bounds the statement", async () => {
    const { conn, sqlText } = fakeConnection();
    await storeWith(conn).store.runScoped(REQUEST);
    expect(sqlText()).toContain("set local transaction read only");
    expect(sqlText().some((s) => s.startsWith("set local statement_timeout"))).toBe(true);
  });

  test("runs everything inside ONE transaction on ONE reserved connection", async () => {
    // `set local` is transaction-scoped: over a pool the settings and the
    // statement could land on different connections, and every guarantee
    // above would be applied to a connection the query never used.
    const { conn, sqlText, release } = fakeConnection();
    const { store } = storeWith(conn);
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
    const conn: ReservedConnection = {
      query: (sql) => {
        statements.push(sql);
        return sql === "boom" ? Promise.reject(new Error("syntax error")) : Promise.resolve([]);
      },
      release,
    };
    const { store } = storeWith(conn);
    await expect(store.runScoped({ ...REQUEST, sql: "boom" })).rejects.toThrow("syntax error");
    expect(statements).toContain("rollback");
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("does not use the pooled executor at all", async () => {
    const { conn } = fakeConnection();
    const { store, pooled } = storeWith(conn);
    await store.runScoped(REQUEST);
    expect(pooled).not.toHaveBeenCalled();
  });
});

describe("reads are bounded for partition pruning", () => {
  test("summaryRows and logs both filter on received_at, the partition key", async () => {
    // Filtering only on `ts` is correct and scans every partition in the
    // window — the table is partitioned on `received_at`.
    const queries: string[] = [];
    const pooled = ((sql: string) => {
      queries.push(sql);
      return Promise.resolve([]);
    }) as unknown as SqlExec;
    const store = createPostgresAnalyticsStore(pooled, () =>
      Promise.reject(new Error("not used here")),
    );
    await store.summaryRows({ slugs: ["a"], sinceMs: 0 });
    await store.logs({ slugs: ["a"], sinceMs: 0, limit: 10 });
    expect(queries).toHaveLength(2);
    for (const query of queries) expect(query).toContain("received_at >= $2");
  });

  test("an empty slug list reads nothing rather than everything", async () => {
    const pooled = vi.fn(() => Promise.resolve([])) as unknown as SqlExec;
    const store = createPostgresAnalyticsStore(pooled, () =>
      Promise.reject(new Error("not used here")),
    );
    await expect(store.summaryRows({ slugs: [], sinceMs: 0 })).resolves.toEqual([]);
    await expect(store.logs({ slugs: [], sinceMs: 0, limit: 10 })).resolves.toEqual([]);
    expect(pooled).not.toHaveBeenCalled();
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
