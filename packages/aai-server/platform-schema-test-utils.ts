// Copyright 2026 the AAI authors. MIT license.
/**
 * The platform SCHEMA, replayed onto a database under test.
 *
 * Extracted from `test-utils.ts` at the 700-line cap, and the seam is what each
 * half is a fact about. What is left there is test DOUBLES and request builders
 * — a fake sandbox, an SQL recorder, an authenticated `fetch` — every one of
 * them a thing a spec calls. This is the SCHEMA: it reads the repo's own
 * migration files and either verifies a CLI-built database against its ledger
 * or replays the statements itself, which is a subject with its own hazards
 * (a THIRD applier of this schema, a sentinel that must not go true early, a
 * regex over prose that once executed a `drop` out of a sentence) and its own
 * failure modes.
 *
 * `ensurePlatformTables` is the door. Everything else here is what it needs.
 *
 * @module
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { SqlExec } from "./secret-store.ts";

/**
 * Create the `aai_platform` tables on the database under test, if it has none.
 *
 * The integration tier's Postgres is the CI runner's own cluster
 * (`.github/workflows/check.yml` starts it), which carries no `aai_platform`
 * schema. That was fine while the only suites needing a database were
 * `platform-lock` (advisory locks need no schema) and `schema-drift` (it reads
 * `pg_class`, and an empty schema satisfies "every table present is declared"
 * vacuously). A suite that reads and writes real rows needs the tables.
 *
 * **The DDL is EXTRACTED from `supabase/migrations`, never restated here.** A
 * hand-copy of a schema in a test util is the same class of bug as the one
 * these suites exist to catch: it passes forever against a shape production
 * does not have. The extraction is deliberately partial — `create table` plus
 * column-level `alter table` — because the migrations also install `pg_cron`
 * and `pgmq`, and neither extension exists on a stock cluster. Nothing here
 * needs them.
 *
 * **The `alter table` half is what keeps a create-table-only replay from
 * drifting into fiction.** A column added or dropped after its table's
 * migration exists only in an `alter`, so replaying the creates alone builds
 * the schema as it stood on day one: `agents.config` back from the dead (NOT
 * NULL, and no store writes it any more) and no `studio_workspaces.
 * preview_slug` for the orphan-preview sweep to join on. Only `add column` /
 * `drop column` are replayed — constraint and index DDL lives inside `do $$`
 * blocks that a statement-level regex cannot safely split, and no suite here
 * depends on one.
 *
 * **On a CLI-built database it VERIFIES instead of assuming.** This used to
 * return early whenever `aai_platform` existed at all, so pointing the suite at
 * the local Supabase stack or at staging ran no DDL — and asserted nothing about
 * the schema being CURRENT, only that *some* `aai_platform` was there. That is
 * not hypothetical: the stack on this machine held three of nine migrations
 * (`supabase start` applies them on INIT and nothing since had run
 * `migration up`), so a suite died on `column w.preview_slug does not exist` —
 * a `PostgresError` naming a column, whose first reading is "the code is
 * broken". `supabase_migrations.schema_migrations` is an exact oracle for it,
 * and cheaper than a column comparison: when the CLI built this database its own
 * ledger says what it applied, so the check is a set difference against
 * `readdirSync(supabase/migrations)` and the failure names the pending files and
 * the command that applies them. When there is no ledger the database was built
 * by this helper's own DDL, and the replay below is right — which also makes
 * that replay (a THIRD thing that applies this schema, after `supabase db push`
 * and `supabase start`) honest about which of the three it is looking at.
 *
 * CI is unaffected either way: a fresh container per run cannot drift.
 */
/**
 * The repo's migration files, sorted, plus their concatenated text.
 *
 * Both readers below (the DDL replay and {@link platformMigrationSql}) had
 * written the same listing, the same `.sql` filter, the same sort and the same
 * join — and only one of them refused an empty directory, which is the one
 * outcome that makes either of them silently do nothing.
 */
function readMigrations(): { dir: string; files: string[]; raw: string } {
  const dir = path.resolve(import.meta.dirname, "../../supabase/migrations");
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

  // The sentinel is a marker this function creates LAST — never one of the
  // migrated tables. Under the `forks` pool every test FILE builds this schema
  // against the same database at once, and `aai_platform.studio_workspaces` is
  // created EARLY, so it went true partway through another worker's build: the
  // second worker returned and started inserting into a schema whose remaining
  // statements had not run. Measured on a fresh database — a seed insert failed
  // with `null value in column "config" of relation "agents"` because
  // `alter table ... drop column config` was still pending in the other worker,
  // and a sibling suite read `aai_platform.session_slots does not exist`. A
  // marker written after the last statement cannot be true early.
  //
  // A transaction would be the other way to get atomicity and is NOT available:
  // `SqlExec` is a POOL, so postgres.js refuses a bare `begin` outright
  // (`UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1`) — it
  // cannot promise the next statement lands on the same connection. Every
  // statement below is `if [not] exists`, so each worker completing the whole
  // list itself is the cheaper equivalent.
  const [existing] = await sql(
    "select to_regclass('public.aai_test_schema_ready') is not null as present",
  );
  if (existing?.present) return;

  const sqlText = raw
    // COMMENTS FIRST, or prose becomes DDL. These migrations explain
    // themselves at length and quote statements while doing it — the expand
    // half of the `agents.config` retirement names its own contract half
    // (`alter table … drop column config;`) in a comment, which this happily
    // executed: a `drop` with no `if exists`, extracted from a sentence.
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

  // INDEXES, and a unique one is a CONSTRAINT rather than an optimization —
  // which is why they cannot be skipped here. `workflow_queue`'s idempotency key
  // is enforced by a unique partial index, so a database built without it accepts
  // a duplicate `on conflict do nothing` silently: the fixture then behaves
  // DIFFERENTLY from production, which is the one thing this replay must not do.
  // Found by running the queue suite against a bare Postgres, where the
  // duplicate-collapse case was the only failure.
  //
  // Every one is `if not exists`, so this is as re-runnable as the creates.
  script.push(...(sqlText.match(/create\s+(?:unique\s+)?index if not exists[\s\S]*?;/g) ?? []));

  // DROPPED TABLES, last. A fixture that ignores a drop builds a schema
  // production does not have, which is the trap every comment above is about:
  // `schema-drift.scenario.test.ts` rightly fails any `aai_platform` table no
  // migration declares, so a retired table left standing here fails it over a
  // database that is only wrong because this replay is.
  //
  // **No migration drops a table today, so this currently applies nothing** —
  // said out loud, because unexercised replay logic is exactly the shape this
  // repo keeps getting bitten by. It is here rather than owed because the
  // obligation is already committed: `RETIRED_OBJECTS` in
  // `platform-schema.test.ts` holds `workflow_attempts` and fails the release
  // that drops it unless the entry goes too, so the drop this serves is
  // scheduled rather than hypothetical — and without the line, that release
  // fails `schema-drift` for a reason that has nothing to do with it.
  //
  // Last rather than in migration order, which is a stated assumption rather
  // than a subtlety nobody noticed: no migration re-creates a table it dropped,
  // and if one ever does, this list has to become ordered instead of grouped.
  // Every statement is `if exists`, so this is as re-runnable as the creates.
  script.push(...(sqlText.match(/drop table if exists aai_platform\.\w+[\s\S]*?;/g) ?? []));

  await applyTolerantly(sql, script);
  // LAST, and that is the whole point of it — see the sentinel above. It lives
  // in `public` rather than `aai_platform` deliberately: this marker is test
  // scaffolding, not platform schema, and `schema-drift.scenario.test.ts`
  // rightly fails any `aai_platform` table no migration declares. Putting it
  // there traded one red suite for another.
  await applyTolerantly(sql, ["create table if not exists public.aai_test_schema_ready ()"]);

  const [created] = await sql(
    "select to_regclass('aai_platform.studio_workspaces') is not null as present",
  );
  if (!created?.present) throw new Error("aai_platform tables were not created");
}

/**
 * The migrations as they ship, minus the one line a throwaway database cannot
 * run — with the omission COUNTED.
 *
 * pg_cron is single-database by design: its background worker reads job
 * descriptions from `cron.database_name` (`postgres`), so `create extension
 * pg_cron` anywhere else raises `can only create extension in database
 * postgres`. Everything else executes verbatim against the real extensions.
 *
 * This is not the `create extension`-stripping regex that used to live in
 * `platform-schema.scenario.test.ts`. That one removed THREE lines, because the
 * arm was a stock server on which none of the Supabase extensions could be
 * installed, and it came with a hand-written plpgsql `pgmq.create` stub — a
 * fourth implementation of a contract, in SQL. Both are gone; the stack has the
 * real extensions, and what is left is one structural property of pg_cron.
 *
 * Note `supabase_vault` is created by NO migration (Supabase pre-installs it), so
 * a database built from these files alone has no Vault. A caller that needs it —
 * anything touching `vault.secrets`, which includes the orphan-preview sweep —
 * must create it itself.
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
 * Fail naming the pending migrations, when the CLI's ledger is behind the repo.
 *
 * The failure a stale database actually produces is a `PostgresError` about a
 * column, several suites deep, which reads as a code bug — so this trades it for
 * one sentence naming the files and the command. Deliberately does NOT apply
 * them: a fixture that migrates the developer's stack would be a FOURTH thing
 * that applies this schema, and it would do it to a database the developer may
 * have data in. Fail with the exact command; that is the only outcome that
 * cannot surprise anybody.
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
