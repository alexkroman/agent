// Copyright 2026 the AAI authors. MIT license.
// Reading a tenant's own tables — the two queries behind the studio's Database
// pane.
//
// The assertions worth having here are about the two rules the module doc
// argues, because both are silent when they break: an identifier reaches SQL
// text only after the catalog has confirmed it (a table name arrives from a
// query string, which is the one input that must never be interpolated), and a
// page is ORDERED, since `limit`/`offset` over an unordered relation can show
// one row twice and skip another between two clicks of Next.

import { describe, expect, test, vi } from "vitest";
import { listAppTables, MAX_TABLE_ROWS, readAppTable } from "./app-db-browse.ts";
import type { SqlExec } from "./secret-store.ts";

function captureSql(respond: (query: string) => Record<string, unknown>[] = () => []) {
  const calls: { query: string; params?: unknown[] | undefined }[] = [];
  const sql: SqlExec = vi.fn(async (query, params) => {
    calls.push({ query, params });
    return respond(query);
  });
  return { sql, calls };
}

/** Answers the three reads `readAppTable` makes, in the order it makes them. */
function tableReader(over: { columns?: string[]; rows?: Record<string, unknown>[] } = {}) {
  return captureSql((query) => {
    if (query.includes("information_schema.tables")) {
      return [{ table_schema: "public", table_name: "notes" }];
    }
    if (query.includes("information_schema.columns")) {
      return (over.columns ?? ["id", "body"]).map((column_name) => ({ column_name }));
    }
    if (query.includes("count(*)")) return [{ total: "2" }];
    return over.rows ?? [{ id: 1, body: "hello" }];
  });
}

describe("listAppTables", () => {
  test("names every table in the app's own schemas, with an exact count", () => {
    const { sql, calls } = captureSql(() => [
      { table_schema: "public", table_name: "notes", rows: "2" },
    ]);
    return listAppTables(sql).then((tables) => {
      expect(tables).toEqual([{ schema: "public", name: "notes", rows: 2 }]);
      // Exact, for the same reason `appDatabaseUsage`'s counts are: `reltuples`
      // reads zero for the row somebody just wrote, which is the question the
      // pane exists to answer.
      expect(calls[0]?.query).toContain("count(*)");
      expect(calls[0]?.query).not.toContain("reltuples");
      expect(calls[0]?.query).toContain("pg_catalog");
    });
  });

  test("a database with no tables is an empty list, not a crash", async () => {
    const { sql } = captureSql(() => []);
    expect(await listAppTables(sql)).toEqual([]);
  });
});

describe("readAppTable", () => {
  test("looks the table up with BOUND parameters before naming it in SQL", async () => {
    const { sql, calls } = tableReader();
    await readAppTable(sql, { schema: "public", table: "notes", limit: 50, offset: 0 });
    const lookup = calls[0];
    expect(lookup?.params).toEqual(["public", "notes"]);
    // The caller's strings are parameters here and nowhere else.
    expect(lookup?.query).not.toContain("notes");
  });

  test("a table the catalog does not have is an answer, not a failure", async () => {
    // A migration between the list read and the click is ordinary.
    const { sql } = captureSql(() => []);
    expect(
      await readAppTable(sql, { schema: "public", table: "gone", limit: 50, offset: 0 }),
    ).toBeNull();
  });

  test("quotes the identifiers it interpolates, doubling any embedded quote", async () => {
    const { sql, calls } = captureSql((query) => {
      if (query.includes("information_schema.tables")) {
        return [{ table_schema: "public", table_name: 'we"ird' }];
      }
      return [];
    });
    await readAppTable(sql, { schema: "public", table: 'we"ird', limit: 10, offset: 0 });
    const select = calls.find((call) => call.query.includes("select * from"));
    expect(select?.query).toContain('"public"."we""ird"');
  });

  test("orders the page, so paging cannot repeat or skip a row", async () => {
    const { sql, calls } = tableReader();
    await readAppTable(sql, { schema: "public", table: "notes", limit: 50, offset: 100 });
    const select = calls.find((call) => call.query.includes("select * from"));
    expect(select?.query).toContain("order by ctid");
    expect(select?.params).toEqual([50, 100]);
  });

  test("clamps the page size and refuses a negative offset", async () => {
    const { sql, calls } = tableReader();
    await readAppTable(sql, {
      schema: "public",
      table: "notes",
      limit: MAX_TABLE_ROWS + 5000,
      offset: -10,
    });
    const select = calls.find((call) => call.query.includes("select * from"));
    expect(select?.params).toEqual([MAX_TABLE_ROWS, 0]);
  });

  test("takes its columns from the catalog, so an empty table still has a header", async () => {
    // Derived from `Object.keys(rows[0])`, the header disappears exactly when
    // the pane most needs to say "this table is empty".
    const { sql } = tableReader({ rows: [] });
    const page = await readAppTable(sql, {
      schema: "public",
      table: "notes",
      limit: 50,
      offset: 0,
    });
    expect(page?.columns).toEqual(["id", "body"]);
    expect(page?.rows).toEqual([]);
    expect(page?.total).toBe(2);
  });

  test("renders each cell as text, keeping null distinct from empty", async () => {
    // The values are whatever a tenant's columns hold, and `null` has to
    // survive as `null`: a text column may legitimately hold "".
    const { sql } = tableReader({
      columns: ["n", "when", "doc", "nothing", "blank"],
      rows: [
        {
          n: 7,
          when: new Date("2026-01-02T03:04:05.000Z"),
          doc: { a: 1 },
          nothing: null,
          blank: "",
        },
      ],
    });
    const page = await readAppTable(sql, {
      schema: "public",
      table: "notes",
      limit: 50,
      offset: 0,
    });
    expect(page?.rows[0]).toEqual(["7", "2026-01-02T03:04:05.000Z", '{"a":1}', null, ""]);
  });

  test("caps a huge cell rather than putting a document on the wire", async () => {
    const { sql } = tableReader({ columns: ["doc"], rows: [{ doc: "x".repeat(5000) }] });
    const page = await readAppTable(sql, {
      schema: "public",
      table: "notes",
      limit: 50,
      offset: 0,
    });
    const cell = page?.rows[0]?.[0] ?? "";
    expect(cell.length).toBeLessThan(1000);
    expect(cell.endsWith("…")).toBe(true);
  });
});
