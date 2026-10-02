// Copyright 2026 the AAI authors. MIT license.
/**
 * The platform SCHEMA, replayed onto a database under test.
 *
 * It reads the repo's own migration files and either verifies a CLI-built
 * database against its ledger or replays the statements itself — a THIRD
 * applier of this schema, with a sentinel that must not go true early.
 * Re-exported to `aai-studio-server` through the `aai-server/test-utils`
 * barrel, which is why the barrel, not this file, carries the subpath name.
 *
 * `ensurePlatformTables` is the door. Everything else here is what it needs.
 *
 * @module
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type CloseableDb, createPostgresDb } from "@alexkroman1/aai-runtime";
import { afterAll, beforeAll } from "vitest";
import { pgUrl } from "../_pg-test-utils.ts";
import type { SqlExec } from "../sql-exec.ts";

/**
 * A pool over the shared test database with the platform tables in place, for
 * one `describeWithPg` / `describeWithStack` suite: opened (and
 * {@link ensurePlatformTables} run) in `beforeAll`, closed in `afterAll`.
 *
 * Call it FIRST in the suite body. Hooks run in registration order and
 * `afterAll`s in reverse, so the suite's own setup sees the tables and its own
 * row cleanup runs before the pool closes. `pgUrl()` is read inside the hook,
 * never during collection. The returned `sql` forwards to the pool, so it is
 * safe to capture at describe scope.
 */
export function usePlatformDb(): SqlExec {
  let db: CloseableDb | undefined;
  beforeAll(async () => {
    db = createPostgresDb({ url: pgUrl(), max: 4 });
    await ensurePlatformTables((query, params) => db?.query(query, params) ?? Promise.resolve([]));
  });
  afterAll(async () => {
    await db?.close();
  });
  return (query, params) =>
    db ? db.query(query, params) : Promise.reject(new Error("usePlatformDb: no pool yet"));
}

/** The repo's migration files, sorted, plus their concatenated text; refuses an empty directory. */
function readMigrations(): { dir: string; files: string[]; raw: string } {
  const dir = path.resolve(import.meta.dirname, "../../../../supabase/migrations");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (files.length === 0) throw new Error(`no migrations in ${dir}`);
  return { dir, files, raw: files.map((n) => readFileSync(path.join(dir, n), "utf-8")).join("\n") };
}

/**
 * A raced duplicate means the object we wanted EXISTS, which is success.
 * `create ... if not exists` is check-then-create in Postgres rather than
 * atomic, so two workers both pass the check and one dies on a system-catalog
 * unique index (`pg_type_typname_nsp_index`, `pg_namespace_nspname_index`).
 * Anything else is a real failure and still throws.
 */
const isRacedDdl = (cause: unknown): boolean =>
  /duplicate key value|already exists|tuple concurrently (?:updated|deleted)/i.test(
    cause instanceof Error ? cause.message : String(cause),
  );

/** Every statement is `if [not] exists`, so a raced sibling is tolerated per statement. */
async function applyTolerantly(sql: SqlExec, statements: readonly string[]): Promise<void> {
  for (const statement of statements) {
    try {
      await sql(statement);
    } catch (cause) {
      if (!isRacedDdl(cause)) throw cause;
    }
  }
}

/**
 * Create the `aai_platform` tables on the database under test, if it has none.
 *
 * - **The DDL is EXTRACTED from `supabase/migrations`, never restated**, so the
 *   fixture cannot drift from the shipped shape. The extraction is partial —
 *   `create table`, column-level `alter table`, indexes and `drop table` — since
 *   `pg_cron`/`pgmq` do not exist on a stock cluster and constraint DDL lives in
 *   `do $$` blocks a statement regex cannot split.
 * - **On a CLI-built database it VERIFIES instead**: the
 *   `supabase_migrations.schema_migrations` ledger is diffed against the repo,
 *   and a stale stack fails naming the pending files rather than as a column
 *   error several suites deep.
 */
export async function ensurePlatformTables(sql: SqlExec): Promise<void> {
  const { dir, files: repoMigrations, raw } = readMigrations();

  // `SqlExec` is not generic — the row is `unknown`, which is all this needs.
  const [ledger] = await sql(
    "select to_regclass('supabase_migrations.schema_migrations') is not null as present",
  );
  if (ledger?.present) {
    await assertMigrationsApplied(sql, repoMigrations);
    return;
  }

  // The sentinel is a marker this function creates LAST, never a migrated
  // table: under the `forks` pool every file builds this schema at once, and a
  // table created early would read "ready" mid-build in another worker. A
  // transaction is not available (`SqlExec` is a POOL; postgres.js refuses a
  // bare `begin`), so every statement is `if [not] exists` and each worker
  // completes the whole list itself.
  const [existing] = await sql(
    "select to_regclass('public.aai_test_schema_ready') is not null as present",
  );
  if (existing?.present) return;

  const sqlText = raw
    // COMMENTS FIRST, or prose becomes DDL: migrations quote statements
    // (e.g. a `drop column` with no `if exists`) in their comments.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "");

  // The migrations format every table as `create table … (` … `\n);`, which is
  // what makes a regex safe despite the `primary key (a, b)` lines inside.
  const tables = sqlText.match(/create table if not exists aai_platform\.\w+ \([\s\S]*?\n\);/g);
  // Loud rather than vacuous: a reformatted migration must fail here, not
  // produce a suite that silently creates nothing and errors row by row.
  if (!tables || tables.length === 0) {
    throw new Error(`no create-table statements found in ${dir} — has the format changed?`);
  }
  const script: string[] = ["create schema if not exists aai_platform", ...tables];

  // Applied in migration order (the file sort above), so a column added and
  // later dropped ends up dropped. Every one is `if [not] exists`, so this is
  // as re-runnable as the creates.
  script.push(
    ...(sqlText.match(/alter table\s+aai_platform\.\w+\s+(?:add|drop) column[\s\S]*?;/g) ?? []),
  );

  // INDEXES, because a unique one is a CONSTRAINT: `workflow_queue`'s
  // idempotency key is a unique partial index, and without it a duplicate
  // `on conflict do nothing` is silently accepted. All `if not exists`.
  script.push(...(sqlText.match(/create\s+(?:unique\s+)?index if not exists[\s\S]*?;/g) ?? []));

  // DROPPED TABLES, last: a retired table left standing fails
  // `schema-drift.scenario.test.ts`. Grouped rather than ordered because no
  // migration re-creates a table it dropped; if one ever does, this must
  // become ordered. All `if exists`.
  script.push(...(sqlText.match(/drop table if exists aai_platform\.\w+[\s\S]*?;/g) ?? []));

  await applyTolerantly(sql, script);
  // LAST — see the sentinel above. In `public`, not `aai_platform`: it is test
  // scaffolding, and `schema-drift` fails any undeclared `aai_platform` table.
  await applyTolerantly(sql, ["create table if not exists public.aai_test_schema_ready ()"]);

  const [created] = await sql(
    "select to_regclass('aai_platform.studio_workspaces') is not null as present",
  );
  if (!created?.present) throw new Error("aai_platform tables were not created");
}

/**
 * The migrations as they ship, minus `create extension pg_cron` — with the
 * omission COUNTED. pg_cron is single-database (`cron.database_name`), so it
 * cannot be created in a throwaway database; everything else runs verbatim.
 *
 * No migration creates `supabase_vault` (Supabase pre-installs it), so a caller
 * touching `vault.secrets` must create it itself.
 */
export function platformMigrationSql(): { sql: string; skipped: number } {
  const { raw } = readMigrations();
  let skipped = 0;
  const sql = raw.replace(/^create extension if not exists pg_cron;$/gm, () => {
    skipped += 1;
    return "-- pg_cron omitted: single-database extension, pinned to cron.database_name";
  });
  return { sql, skipped };
}

/**
 * A migration filename's version — the digits the Supabase CLI records.
 *
 * `20260810020000_preview_slug_column.sql` → `20260810020000`. Exported because
 * `store-conformance.ts` reports the same set and must agree on the reading.
 */
export function migrationVersion(filename: string): string {
  return /^(\d+)/.exec(filename)?.[1] ?? filename;
}

/**
 * Fail naming the pending migrations when the CLI's ledger is behind the repo.
 * Deliberately does NOT apply them: that would migrate a developer's own stack,
 * which may hold data.
 */
async function assertMigrationsApplied(sql: SqlExec, repoMigrations: string[]): Promise<void> {
  const rows = await sql("select version from supabase_migrations.schema_migrations");
  const applied = new Set(rows.map((row) => String(row.version)));
  const pending = repoMigrations.filter((name) => !applied.has(migrationVersion(name)));
  if (pending.length === 0) return;
  throw new Error(
    `This database was built by the Supabase CLI and is ${pending.length} migration(s) ` +
      `behind supabase/migrations:\n\n${pending.map((n) => `  ${n}`).join("\n")}\n\n` +
      "Apply them, then re-run:\n\n  supabase migration up      # keeps the data in it\n" +
      "  supabase db reset          # rebuilds from every migration, discarding it\n\n" +
      "(Nothing here applies them for you: a fixture that migrated your own stack " +
      "would be a fourth thing that applies this schema, to a database you may have " +
      "data in.)",
  );
}
