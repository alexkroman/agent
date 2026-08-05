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

/** Every `aai_platform.<table>` the platform's own source queries. */
function referencedTables(): Set<string> {
  const dirs = [
    path.join(repoRoot, "packages/aai-server"),
    path.join(repoRoot, "packages/aai-studio-server"),
  ];
  const tables = new Set<string>();
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      // Comments are stripped first: several modules discuss tables the
      // platform used to have (`slug_locks`, `slug_epochs`) as part of
      // explaining why they are gone, and prose is not a query.
      const source = stripComments(readFileSync(path.join(dir, name), "utf-8"));
      for (const match of source.matchAll(/aai_platform\.([a-z_]+)/g)) {
        const table = match[1];
        if (table) tables.add(table);
      }
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
    // pg_cron runs the janitorial sweeps; pgmq backs the preview-deploy queue.
    expect(sql).toContain("create extension if not exists pg_cron");
    expect(sql).toContain("create extension if not exists pgmq");
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
      expect(sql).toContain(`alter publication supabase_realtime add table aai_platform.${table}`);
    }
    expect(sql).toContain("grant usage on schema aai_platform to service_role");
    expect(sql).toContain("grant select on");
  });

  test("are idempotent, so re-applying is safe", () => {
    const sql = migrationSql();
    // Every bare create must be guarded; the exceptions are inside DO blocks
    // that check for themselves (the publication, the pgmq queue).
    const creates = [...sql.matchAll(/^\s*create (table|schema|extension|index)([^;]*)/gim)];
    expect(creates.length).toBeGreaterThan(0);
    for (const [statement] of creates) {
      expect(statement).toContain("if not exists");
    }
  });
});
