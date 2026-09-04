// Copyright 2026 the AAI authors. MIT license.
/**
 * Does the database under test contain anything `supabase/migrations` does not
 * declare?
 *
 * This is the REVERSE of `platform-schema.test.ts`, and the direction nothing
 * checked. That suite greps the source for `aai_platform.<table>` and asserts a
 * migration declares each one, which catches a table the code needs and the
 * schema lacks. A table that is queried NOWHERE and declared NOWHERE satisfies
 * it trivially — and three of those were sitting in production:
 * `sandbox_registry`, `slug_epochs`, and `slug_locks`, created at runtime by the
 * retired lazy-DDL path (`pg-ensure.ts`) and never dropped, because a declared
 * schema has no `drop` for a table it never declared.
 *
 * They were not harmless. `20260807000000_platform_rls.sql` enables RLS on the
 * five tables it knows about, so undeclared leftovers would have been the only
 * tables in the schema without it — and Supabase reports nothing, since
 * splinter's `rls_disabled_in_public` and the RLS-disabled alerts both key on
 * the `public` schema. `20260807120000_drop_orphan_platform_tables.sql` drops
 * them; this test is what keeps them gone.
 *
 * **This check cannot be static.** Drift is by definition a fact about a
 * database, not about the repo, so it needs one to look at — which is why it
 * lives in the integration tier and not in `pnpm check`. Point it at whichever
 * database you want the claim to hold for:
 *
 * ```sh
 * # the local stack — proves the migrations are self-consistent
 * AAI_TEST_PG_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
 *   pnpm --filter aai-server test:scenario
 *
 * # a staging or production connection — proves THAT database has not drifted
 * AAI_TEST_PG_URL="$SUPABASE_DB_URL" pnpm --filter aai-server test:scenario
 * ```
 *
 * Read-only: it queries `pg_class` and writes nothing, so it is safe to point
 * at a real database. `supabase db diff --linked --schema aai_platform` is the
 * ad-hoc equivalent and reports column-level drift too; this is the version
 * that fails a test run.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CloseableDb } from "@alexkroman1/aai-runtime";
import { createPostgresDb } from "@alexkroman1/aai-runtime";
import { afterAll, beforeAll, expect, test } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";

const migrationsDir = path.resolve(import.meta.dirname, "../../../supabase/migrations");

function migrationSql(): string {
  const files = readdirSync(migrationsDir)
    .filter((n) => n.endsWith(".sql"))
    .sort();
  if (files.length === 0) throw new Error(`no migrations in ${migrationsDir}`);
  return files.map((n) => readFileSync(path.join(migrationsDir, n), "utf-8")).join("\n");
}

/**
 * Drop `--` and block comments before matching, so a migration that DISCUSSES a
 * table is not mistaken for declaring one. Load-bearing here: the drop
 * migration names all three orphans in prose, and this file's own subject
 * matter means that prose will keep being written.
 */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
}

/**
 * Every `aai_platform` table the given SQL CREATEs, minus any it later drops.
 *
 * Takes the SQL rather than reading the directory so the parser can be
 * exercised on a synthetic input. The real migrations cannot exercise the drop
 * half: the tables `20260807120000` drops were created by the retired lazy-DDL
 * path, never by a migration, so there is no `create` for a `drop` to cancel
 * and that branch would otherwise be asserted by nothing.
 */
function declaredTables(sql: string): Set<string> {
  const clean = stripSqlComments(sql);
  const declared = new Set<string>();
  for (const m of clean.matchAll(/create table (?:if not exists )?aai_platform\.(\w+)/gi)) {
    declared.add(m[1] as string);
  }
  // A dropped table is not declared, however it was created. Without this, a
  // future migration that retires a table this schema DID declare would have to
  // delete the original `create` too, and the directory would stop being
  // readable as a history.
  for (const m of clean.matchAll(/drop table (?:if exists )?aai_platform\.(\w+)/gi)) {
    declared.delete(m[1] as string);
  }
  return declared;
}

describeWithPg("the platform schema has not drifted from its migrations", () => {
  let db: CloseableDb;

  beforeAll(() => {
    db = createPostgresDb({ url: pgUrl(), max: 2 });
  });

  afterAll(async () => {
    await db?.close();
  });

  test("the migrations declare at least the tables we know about", () => {
    // Guards the parser, not the database: a regex that silently stopped
    // matching would make the drift test below pass by finding nothing to
    // compare, which is the one way it could go quietly useless.
    const declared = declaredTables(migrationSql());
    expect(declared).toContain("agents");
    expect(declared).toContain("studio_workspaces");
    expect(declared).toContain("studio_chats");
    // No migration ever declared these — that IS the bug 20260807120000 cleans
    // up. They are named in that migration's prose, so this also pins the
    // comment stripping: without it they would read as declarations.
    expect(declared).not.toContain("sandbox_registry");
    expect(declared).not.toContain("slug_epochs");
    expect(declared).not.toContain("slug_locks");
  });

  test("a later drop cancels an earlier create", () => {
    // The branch the real migrations cannot reach today (see `declaredTables`),
    // so it is asserted directly rather than left to the first person who
    // retires a declared table.
    const declared = declaredTables(
      `create table if not exists aai_platform.keeper (id text primary key);
       create table aai_platform.retired (id text primary key);
       drop table if exists aai_platform.retired;`,
    );
    expect([...declared]).toEqual(["keeper"]);
  });

  test("every table in aai_platform is declared by a migration", async () => {
    const rows = await db.query<{ relname: string }>(
      `select c.relname
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'aai_platform' and c.relkind = 'r'
        order by c.relname`,
    );
    const declared = declaredTables(migrationSql());
    const undeclared = rows.map((r) => r.relname).filter((name) => !declared.has(name));
    expect(
      undeclared,
      `aai_platform tables that no migration declares: ${undeclared.join(", ")}. ` +
        "Either declare them or add a drop migration — an undeclared table gets " +
        "none of the RLS the declared ones do, and nothing else reports it.",
    ).toEqual([]);
  });
});
