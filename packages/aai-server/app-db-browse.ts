// Copyright 2026 the AAI authors. MIT license.
/**
 * Reading a tenant's own tables — the table list and one page of rows behind
 * the studio's Database pane.
 *
 * Beside `app-db-usage.ts` and split from it on the same seam that separates
 * both from `app-database.ts`: those provision, these only READ. The
 * difference between the two readers is what they answer for — usage is three
 * numbers about the whole database, this is the contents of one table.
 *
 * Both run on a connection INTO the app's database (`AppDatabases.withAppDb`),
 * because `information_schema` is per-database and the tenant's tables are not
 * reachable from the admin connection at all.
 *
 * ## Two rules, and neither is optional
 *
 * **An identifier is never interpolated before it has been FOUND in the
 * catalog.** A table name arrives from a query string, and a query string is
 * the one input that must never reach SQL text. So `readAppTable` looks the
 * pair up in `information_schema.tables` with bound parameters first and reads
 * the schema and table names back OUT of that answer — the strings that get
 * quoted are Postgres's own, not the caller's — and quoting still doubles any
 * embedded `"`, because a defence that rests on one step being correct is one
 * refactor from being no defence.
 *
 * **The page is ORDERED, or it is not a page.** Postgres makes no promise
 * about the order of a bare `select *`, so `limit`/`offset` over an unordered
 * relation can show one row twice and skip another between two clicks of Next
 * with nothing having changed. `ctid` is the physical location and is the one
 * ordering every table has — no primary key required — so it is what this
 * paginates on. It is not stable across a rewrite (a `VACUUM FULL`, an
 * `UPDATE` moving a row), which is the honest limit of a viewer over arbitrary
 * tenant tables and is a different thing from having no order at all.
 */

import type { SqlExec } from "./secret-store.ts";

/** One of the app's tables, with the exact number of rows in it. */
export type AppTable = { schema: string; name: string; rows: number };

/** One page of one table: its columns, and the rows as display strings. */
export type AppTablePage = {
  columns: string[];
  /** Cells, already rendered — see {@link cell} for why the server does it. */
  rows: (string | null)[][];
  /** Rows in the whole table, so a pager can say where it is. */
  total: number;
};

/** Rows one read may return. A viewer is for looking, not for exporting. */
export const MAX_TABLE_ROWS = 200;

/** Longest cell the wire carries — a JSONB blob must not become the payload. */
const MAX_CELL_CHARS = 500;

/** Schemas that are Postgres's, not the app's. */
const SYSTEM_SCHEMAS = "('pg_catalog', 'information_schema')";

/** Postgres returns int8 as a string in most drivers; a NaN would be a lie. */
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Quote an identifier for interpolation. Only ever called with a name read
 * back out of `information_schema` — see the module doc.
 */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * One cell, as the pane will show it.
 *
 * Rendered HERE rather than shipped as JSON and formatted in the browser,
 * because the values are whatever the tenant's columns hold: `bytea` arrives as
 * a Buffer, `timestamptz` as a Date, `numeric` and `int8` as strings, `jsonb` as
 * a parsed object. A client formatting that lot would need a type map it has no
 * way to obtain, and `JSON.stringify` of a Buffer is a page of byte numbers.
 * `null` survives as `null` so the pane can render it as a value rather than as
 * the empty string a column legitimately holds.
 */
function cell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return cap(render(value));
}

/** One value as text, by the four shapes a Postgres driver hands back. */
function render(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Trim a cell to the wire cap, marking that it was trimmed. */
function cap(text: string): string {
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : text;
}

/**
 * Every table in the app's own schemas, with an exact row count.
 *
 * Counts are exact for the same reason `appDatabaseUsage`'s are — `reltuples`
 * is `-1` before the first ANALYZE and stale after every write, so a row just
 * written reads as zero, which is the question this pane exists to answer. The
 * `query_to_xml` trick runs every count inside the one round trip.
 */
export async function listAppTables(sql: SqlExec): Promise<AppTable[]> {
  const rows = await sql(
    `select table_schema, table_name,
       (xpath('/row/c/text()',
         query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name),
                      false, true, '')))[1]::text::int8 as rows
     from information_schema.tables
     where table_type = 'BASE TABLE'
       and table_schema not in ${SYSTEM_SCHEMAS}
     order by table_schema, table_name`,
  );
  return rows.map((row) => ({
    schema: String(row.table_schema),
    name: String(row.table_name),
    rows: num(row.rows),
  }));
}

export type ReadAppTableParams = {
  schema: string;
  table: string;
  /** Clamped to {@link MAX_TABLE_ROWS}. */
  limit: number;
  offset: number;
};

/**
 * One page of one table, or `null` when the app has no such table.
 *
 * `null` rather than a throw: the caller asked about a name that may simply be
 * gone (a migration between the list read and the click), which is an answer
 * and not a failure.
 */
export async function readAppTable(
  sql: SqlExec,
  params: ReadAppTableParams,
): Promise<AppTablePage | null> {
  // The lookup that makes interpolation safe below: bound parameters, and the
  // names that get quoted are the ones Postgres answers with.
  const found = await sql(
    `select table_schema, table_name
     from information_schema.tables
     where table_schema = $1 and table_name = $2
       and table_type = 'BASE TABLE'
       and table_schema not in ${SYSTEM_SCHEMAS}`,
    [params.schema, params.table],
  );
  const target = found[0];
  if (!target) return null;
  const qualified = `${quoteIdent(String(target.table_schema))}.${quoteIdent(String(target.table_name))}`;

  // Columns come from the catalog rather than from the page's own rows: an
  // empty table, or a page past the end, still has to render its header — and
  // a header derived from `Object.keys(rows[0])` disappears exactly when the
  // pane most needs to say "this table is empty" rather than "no columns".
  const columnRows = await sql(
    `select column_name from information_schema.columns
     where table_schema = $1 and table_name = $2
     order by ordinal_position`,
    [params.schema, params.table],
  );
  const columns = columnRows.map((row) => String(row.column_name));

  const limit = Math.min(Math.max(Math.trunc(params.limit), 1), MAX_TABLE_ROWS);
  const offset = Math.max(Math.trunc(params.offset), 0);
  const [totals, page] = await Promise.all([
    sql(`select count(*)::int8 as total from ${qualified}`),
    sql(`select * from ${qualified} order by ctid limit $1 offset $2`, [limit, offset]),
  ]);

  return {
    columns,
    rows: page.map((row) => columns.map((column) => cell(row[column]))),
    total: num(totals[0]?.total),
  };
}
