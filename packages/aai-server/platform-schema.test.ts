// Copyright 2026 the AAI authors. MIT license.
/**
 * The platform schema lives in `supabase/migrations`, not in the stores. This
 * suite is the guard that keeps it that way, because both failure directions
 * are quiet:
 *
 * - A store querying a table no migration declares works locally (memory
 *   stores) and in tests, then fails in production with "relation does not
 *   exist" on the first read.
 * - A store that reintroduces lazy DDL papers over exactly that, creating the
 *   table under whichever connection first noticed.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const migrationsDir = path.join(repoRoot, "supabase/migrations");

function migrationSql(): string {
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql"));
  if (files.length === 0) throw new Error(`no migrations found in ${migrationsDir}`);
  return files.map((name) => readFileSync(path.join(migrationsDir, name), "utf-8")).join("\n");
}

/** Drop `//` and block comments, so prose about retired tables is not a query. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Drop SQL comments (`--` to end of line, and block comments), so a migration
 * that DESCRIBES a hazard is not mistaken for committing it. The RLS
 * migration writes `grant select … to authenticated` in prose to explain what
 * it guards against.
 *
 * Does not attempt to respect string literals: no migration here contains a
 * `--` inside one, and a stripper that parsed SQL properly would be a bigger
 * thing to trust than the tests it serves.
 */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
}

/**
 * Every platform source file as `[repo-relative path, source]`, comments
 * STRIPPED: several modules discuss tables the platform used to have
 * (`slug_locks`, `slug_epochs`) as part of explaining why they are gone, and
 * prose is not a query.
 */
function platformSources(): [path: string, source: string][] {
  const dirs = ["packages/aai-server", "packages/aai-studio-server"];
  return dirs.flatMap((dir) =>
    readdirSync(path.join(repoRoot, dir))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name): [string, string] => [
        `${dir}/${name}`,
        stripComments(readFileSync(path.join(repoRoot, dir, name), "utf-8")),
      ]),
  );
}

/** Every `aai_platform.<table>` the platform's own source queries. */
function referencedTables(): Set<string> {
  const tables = new Set<string>();
  for (const [, source] of platformSources()) {
    for (const match of source.matchAll(/aai_platform\.([a-z_]+)/g)) {
      const table = match[1];
      if (table) tables.add(table);
    }
  }
  return tables;
}

describe("platform schema migrations", () => {
  test("declare every aai_platform table the code queries", () => {
    const sql = migrationSql();
    const referenced = [...referencedTables()].sort();
    expect(referenced.length).toBeGreaterThan(0);
    const missing = referenced.filter(
      (table) => !sql.includes(`create table if not exists aai_platform.${table}`),
    );
    expect(missing).toEqual([]);
  });

  test("create the schema and the extensions the platform schedules work with", () => {
    const sql = migrationSql();
    expect(sql).toContain("create schema if not exists aai_platform");
    // pg_cron runs the janitorial sweeps; pgmq backs the preview-deploy queue;
    // pg_net is how the blob GC sweep reaches the Storage API from inside a
    // pg_cron job (a Storage object's bytes cannot be deleted in SQL).
    //
    // The pg_cron line is LOAD-BEARING for boot, not just documentation of it:
    // `schedulePlatformSweeps` verifies the extension and refuses to install it
    // (see its doc), so this migration is the only thing that puts it there. Drop
    // it and every deployment boots reporting that the sweeps will not run.
    expect(sql).toContain("create extension if not exists pg_cron");
    expect(sql).toContain("create extension if not exists pgmq");
    expect(sql).toContain("create extension if not exists pg_net");
  });

  /**
   * Realtime validates a channel's filter column — and walrus gates row
   * visibility — against what the subscriber's claimed role can SELECT. The
   * app-created schema gets none of Supabase's default `public` grants, so
   * without these every filtered subscribe fails with `invalid column for
   * filter` and realtime-js retries the join forever.
   */
  test("put the watched tables in the publication and grant service_role SELECT", () => {
    const sql = migrationSql();
    for (const table of ["agents", "studio_workspaces", "studio_chats"]) {
      expect
        .soft(sql, `${table} is not in the publication`)
        .toContain(`alter publication supabase_realtime add table aai_platform.${table}`);
    }
    expect(sql).toContain("grant usage on schema aai_platform to service_role");
    expect(sql).toContain("grant select on");
  });

  /**
   * The watched tables are published WHOLE, and this exists to keep them that
   * way.
   *
   * Narrowing the publication to a column list is the obvious optimization —
   * these are signal streams, handlers re-read, so shipping
   * `studio_workspaces.doc` on every settled edit is a whole project file map
   * decoded for a payload nobody looks at. It was tried, and it does nothing:
   * a column list is honoured by `pgoutput`, and Supabase Realtime does not
   * decode with pgoutput. `realtime.list_changes` reads the publication for its
   * TABLE list alone and calls `pg_logical_slot_get_changes(…, 'add-tables', …)`
   * against **wal2json**, which has no notion of publications and emits every
   * column regardless (measured on realtime v2.112.6 / PG 17.6: a publication
   * whose `attnames` is `{id,small}` still emitted the excluded column in full).
   *
   * A no-op migration is worse than none, because the comment on it teaches the
   * next reader a mechanism that isn't there — so the guard is against the
   * column list, not for it. If the decode cost has to come down, it takes a
   * different mechanism (Broadcast from Database, or a signal table that does
   * not carry the document), which will fail this test and should: it will also
   * be deleting these `add table` lines.
   */
  test("publishes the watched tables WHOLE — a column list here is inert", () => {
    const sql = stripSqlComments(migrationSql());
    const withColumnList = [
      ...sql.matchAll(/alter publication supabase_realtime add table\s+\S+\s*\(/g),
    ];
    expect(
      withColumnList.map((match) => match[0]),
      "wal2json ignores publication column lists — see this test's comment",
    ).toEqual([]);
  });

  /**
   * Deny-all RLS on every platform table (20260807000000_platform_rls.sql).
   *
   * These three assertions exist because NO EXTERNAL TOOL WILL EVER MAKE
   * THEM. Supabase's own linter (splinter rule 0013,
   * `rls_disabled_in_public`) and the RLS-disabled email alerts both key on
   * the `public` schema; `aai_platform` is not public and is not
   * PostgREST-exposed, so a table added here without RLS is invisible to
   * every check Supabase runs on the project. `supabase db lint` is
   * plpgsql_check and inspects functions, of which this schema has none.
   *
   * What they guard is the accidental grant: today the only thing between a
   * browser and every tenant's workspace is that `anon`/`authenticated` hold
   * no privilege here. With RLS on and no policies, that mistake yields zero
   * rows instead of every row.
   */
  describe("row-level security", () => {
    /** Tables the migrations declare, derived so a new one is covered. */
    function declaredTables(sql: string): string[] {
      return [...sql.matchAll(/create table if not exists aai_platform\.([a-z_]+)/g)]
        .map(([, table]) => table)
        .filter((table): table is string => table !== undefined)
        .sort((a, b) => a.localeCompare(b));
    }

    test("every declared table has it enabled", () => {
      const sql = migrationSql();
      const tables = declaredTables(sql);
      expect(tables.length).toBeGreaterThan(0);
      // Soft, so adding several tables at once names all of them rather than
      // reporting the first and hiding the rest.
      for (const table of tables) {
        expect
          .soft(sql, `aai_platform.${table} has no RLS`)
          .toContain(`alter table aai_platform.${table} enable row level security`);
      }
    });

    test("nothing is granted to anon, authenticated, or public", () => {
      // Comments are stripped FIRST, and the RLS migration is why: it
      // explains the hazard by writing `grant select … to authenticated` in
      // prose, and prose is not a grant. (Same reasoning as
      // `referencedTables`, different comment syntax.)
      const sql = stripSqlComments(migrationSql());
      const grants = [...sql.matchAll(/grant[\s\S]*?to\s+([a-z_, ]+)/gi)].map(([, roles]) =>
        (roles ?? "").trim(),
      );
      expect(grants.length).toBeGreaterThan(0);
      const exposed = grants.filter((roles) => /\b(anon|authenticated|public)\b/.test(roles));
      // A grant to one of these is not automatically wrong — but it makes RLS
      // load-bearing rather than belt-and-braces, so it has to arrive with
      // policies and a deliberate update to this test.
      expect(exposed).toEqual([]);
    });

    test("never FORCEs it — that would lock the platform out of its own tables", () => {
      // The platform connects as the tables' OWNER, and owners bypass
      // policies; `force row level security` removes that exemption, so with
      // no policies declared every platform query would return nothing. The
      // trap is that it reads like the stricter, safer option.
      expect(stripSqlComments(migrationSql())).not.toMatch(/force\s+row\s+level\s+security/i);
    });
  });

  /**
   * Columns that are declared and deliberately no longer written — the
   * EXPAND half of an expand/contract, waiting on their `drop column`.
   *
   * The waiting is the problem this guards. A contract migration cannot ride
   * the same release as the expand: `supabase db push` runs BEFORE the
   * deploy and Modal's rolling strategy keeps the previous build serving
   * beside the new one, so a column dropped in the same step is a column the
   * still-serving old containers name in their insert — every deploy through
   * one fails for the length of the rollout. So the drop is owed to a LATER
   * release, and an owed thing recorded only in prose is an owed thing
   * forgotten: the whole reason `agents.config` reached this state is that
   * the changes retiring its consumers had no reason to revisit it.
   *
   * Each entry is checked two ways, and the second is what makes the ledger
   * self-clearing: the column must still be declared, so once the drop
   * lands, the entry has to be deleted or this fails. Removing the last
   * entry is the point — this is not a list anything should live on.
   *
   * **It is EMPTY, and that is the goal state.** `agents.config` was the one
   * entry; its contract migration
   * (`20260810030000_drop_agents_config.sql`) landed in the commit that
   * deleted the entry, exactly as the second assertion below forces. The
   * mechanism stays for the next column that needs it.
   */
  const RETIRED_COLUMNS: { table: string; column: string; why: string }[] = [];

  test("the retired-column ledger is empty — nothing is owed a drop", () => {
    // Not decoration: `describe.each` cannot take an empty array, so without
    // this the empty state would be a file with no assertion in it at all.
    expect(RETIRED_COLUMNS).toEqual([]);
  });

  describe.each(RETIRED_COLUMNS)("retired column $table.$column", ({ table, column, why }) => {
    test(`is still declared — drop it and delete this entry (${why})`, () => {
      expect(stripSqlComments(migrationSql())).toMatch(
        new RegExp(`create table if not exists aai_platform\\.${table}[^;]*\\b${column}\\b`),
      );
    });

    test("is written by no platform source file", () => {
      // A write reintroduced here is invisible until the drop finally lands,
      // at which point it fails in production rather than in CI. Scanning
      // whole files rather than parsing SQL: these modules are the platform's
      // own, comments are stripped, and a false positive is cheap to resolve
      // (rename the local) next to a missed write that breaks a deploy. Only
      // files that name the TABLE are scanned — `config` is a common word and
      // every module has a ServiceConfig somewhere.
      const offenders = platformSources()
        .filter(([, source]) => source.includes(`aai_platform.${table}`))
        .filter(([, source]) => new RegExp(`\\b${column}\\b`).test(source))
        .map(([file]) => file);
      expect(offenders).toEqual([]);
    });
  });

  test("are idempotent, so re-applying is safe", () => {
    const sql = migrationSql();
    // Every bare create must be guarded; the exceptions are inside DO blocks
    // that check for themselves (the publication, the pgmq queue).
    const creates = [...sql.matchAll(/^\s*create (table|schema|extension|index)([^;]*)/gim)];
    expect(creates.length).toBeGreaterThan(0);
    // Soft, so a migration adding several unguarded creates names them all.
    for (const [statement] of creates) {
      expect.soft(statement).toContain("if not exists");
    }
  });
});
