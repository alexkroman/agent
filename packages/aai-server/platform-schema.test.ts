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

function migrationFiles(): string[] {
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql"));
  if (files.length === 0) throw new Error(`no migrations found in ${migrationsDir}`);
  return files;
}

function migrationSql(): string {
  return migrationFiles()
    .map((name) => readFileSync(path.join(migrationsDir, name), "utf-8"))
    .join("\n");
}

/**
 * A migration's VERSION is its leading timestamp, and two files may not share one.
 *
 * `supabase_migrations.schema_migrations` is keyed on that number alone — the
 * filename's descriptive tail is not part of the key — so two migrations stamped
 * the same minute abort the whole `supabase start` with
 * `duplicate key value violates unique constraint "schema_migrations_pkey"` and no
 * indication of which pair collided.
 *
 * It is a MERGE hazard rather than an authoring one: each branch picks a
 * plausible next timestamp against the main it can see, both apply cleanly in
 * isolation, and the collision exists only in the merge. So it cannot be caught
 * by running the stack on either branch, which is exactly why it belongs in a
 * test — this fired for real when `20260828000000_platform_uploads.sql` and
 * `20260828000000_workflow_schema_rls.sql` landed within an hour of each other,
 * green on both branches and red on main.
 */
test("no two migrations share a version", () => {
  const byVersion = new Map<string, string[]>();
  for (const name of migrationFiles()) {
    const version = name.split("_")[0] ?? name;
    byVersion.set(version, [...(byVersion.get(version) ?? []), name]);
  }
  const collisions = [...byVersion.entries()].filter(([, names]) => names.length > 1);
  expect(collisions.map(([version, names]) => `${version}: ${names.join(", ")}`)).toEqual([]);
});

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

/**
 * `aai_platform` FUNCTIONS, which are `aai_platform.<name>` in a source file and
 * are not tables.
 *
 * DECLARED rather than inferred, and the inference is worth ruling out in
 * writing because it looks like a two-character fix. A trailing `(` does mark a
 * call — and it equally marks an INSERT column list, `insert into
 * aai_platform.agents (slug, …)`, so a `(?!\s*\()` lookahead skips real table
 * references. Measured over this corpus: the extracted set went 15 → 20, because
 * `[a-z_]+` BACKTRACKS when the lookahead fails and matches a shorter name — it
 * dropped `sweep_terminal_workflow_runs` as intended and invented `agent`,
 * `workflow_queu`, `session_slot`, `session_event`, `workflow_upload` and
 * `sweep_terminal_workflow_run`, every one of which then reports as an
 * undeclared table. Declaration fails loudly on a new function; inference failed
 * quietly in the direction that makes this assertion easier to pass.
 *
 * Add a new function here, and note the entry is CHECKED below — a name that no
 * migration declares as a function fails, so this cannot become a place to park
 * a table somebody did not want to declare.
 */
const PLATFORM_FUNCTIONS = new Set(["sweep_terminal_workflow_runs"]);

/**
 * Every `aai_platform.<table>` one source file queries.
 *
 * Split from {@link referencedTables} so the rule can be exercised on a literal:
 * the corpus version answers a question about the tree and cannot pin what the
 * scanner CONSIDERS a table.
 */
function referencedTablesIn(source: string): Set<string> {
  const tables = new Set<string>();
  for (const match of source.matchAll(/aai_platform\.([a-z_]+)/g)) {
    const table = match[1];
    if (table && !PLATFORM_FUNCTIONS.has(table)) tables.add(table);
  }
  return tables;
}

/** Every `aai_platform.<table>` the platform's own source queries. */
function referencedTables(): Set<string> {
  const tables = new Set<string>();
  for (const [, source] of platformSources()) {
    for (const table of referencedTablesIn(source)) tables.add(table);
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

  test("reads a FUNCTION call as a function and an INSERT column list as a table", () => {
    // The two shapes a `(`-based heuristic cannot tell apart, pinned together
    // because the fix for one is the bug for the other — see PLATFORM_FUNCTIONS.
    expect([...referencedTablesIn("select aai_platform.sweep_terminal_workflow_runs()")]).toEqual(
      [],
    );
    expect([
      ...referencedTablesIn("insert into aai_platform.workflow_runs (slug, run_id) values ($1,$2)"),
    ]).toEqual(["workflow_runs"]);
    // No space before the paren either, which is how `agents(slug)` is written
    // in a few places and is where the backtracking produced `agent`.
    expect([...referencedTablesIn("insert into aai_platform.agents(slug) values ($1)")]).toEqual([
      "agents",
    ]);
  });

  test("every exempted name is really a FUNCTION some migration declares", () => {
    // The other half of the exemption: without this, PLATFORM_FUNCTIONS is a way
    // to silence the gate for a table nobody wanted to declare.
    const sql = stripSqlComments(migrationSql());
    for (const name of PLATFORM_FUNCTIONS) {
      expect
        .soft(sql, `no migration declares aai_platform.${name} as a function`)
        .toContain(`create or replace function aai_platform.${name}`);
      expect
        .soft(sql, `aai_platform.${name} is also declared as a TABLE`)
        .not.toContain(`create table if not exists aai_platform.${name}`);
    }
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

    /**
     * The rule covers `aai_platform` because that is the schema this repo
     * DECLARES — and for a while that was the whole of the check, which is how the
     * DevKit's `workflow` schema came to hold every tenant's run journal on this
     * database with RLS off.
     *
     * It is created out-of-band by `@workflow/world-postgres`'s own drizzle
     * migrations, which issue no `enable row level security` anywhere, so no
     * `create table` statement for it exists in this repo for `declaredTables` to
     * find. The pattern above is therefore structurally incapable of seeing it,
     * and so are the other two guards (`realtime-rls.scenario.test.ts` matches
     * `aai_platform` literally; Supabase's own splinter rules key on `public`).
     *
     * `20260828010000_workflow_schema_rls.sql` closes it with a `do` block over
     * `pg_tables`, and this asserts the block is still there and still
     * SELF-EXTENDING. A fixed table list is what must not come back: it would go
     * stale the first time that dependency adds a table, which is this same bug
     * one version later.
     */
    test("the DevKit's own schema is covered too, by a self-extending block", () => {
      const sql = stripSqlComments(migrationSql());
      expect(sql).toContain("to_regnamespace('workflow')");
      // Enumerated at apply time rather than listed.
      expect(sql).toMatch(/select tablename from pg_tables where schemaname = 'workflow'/);
      expect(sql).toMatch(/alter table workflow\.%I enable row level security/);
      // ENABLE, never FORCE — the platform connects as the owner of these tables.
      expect(sql).not.toMatch(/alter table workflow\.[^\n]*force row level security/);
      // A hardcoded list is the regression to refuse.
      expect(sql).not.toMatch(/alter table workflow\.workflow_runs enable row level security/);
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

  /**
   * The same ledger, one granularity up: whole SQL OBJECTS that are retired —
   * present, read and written by nothing — and owed a `drop` in a later
   * release. The argument is `RETIRED_COLUMNS`' above, unchanged; only the
   * granularity differs, so this is a sibling rather than a second convention.
   *
   * A `drop schema … cascade` beside its own expand is the column case with the
   * consequence turned up: it destroys the rows at the START of the
   * push→deploy window, before one new container is up, and a rollback of the
   * release has nothing left to roll back TO.
   * `20260901010000_drop_workflow_devkit_schema.sql` therefore RENAMES the
   * Workflow DevKit's two schemas and leaves its ownership table alone; these
   * three are what that migration deferred.
   *
   * Each entry is checked the same two ways, and `droppedBy` is what makes the
   * ledger self-clearing: it must NOT appear in the migrations, so the contract
   * release fails this test until its entry is deleted.
   */
  const RETIRED_OBJECTS: {
    name: string;
    /** A literal from the migration that put the object in its retired state. */
    declaredBy: string;
    /** The contract statement that retires it. Present ⇒ delete this entry. */
    droppedBy: string;
    why: string;
  }[] = [
    {
      name: "workflow_retired",
      declaredBy: "alter schema workflow rename to workflow_retired",
      droppedBy: "drop schema if exists workflow_retired cascade",
      why: "the DevKit's six cross-tenant run tables, kept so the rename is reversible",
    },
    {
      name: "workflow_drizzle_retired",
      declaredBy: "alter schema workflow_drizzle rename to workflow_drizzle_retired",
      droppedBy: "drop schema if exists workflow_drizzle_retired cascade",
      why: "the DevKit's own migration bookkeeping, which nothing applies now",
    },
    {
      name: "workflow_run_owner",
      declaredBy: "create table if not exists aai_platform.workflow_run_owner",
      droppedBy: "drop table if exists aai_platform.workflow_run_owner",
      why: "the run→slug mapping; a rollback of the schema rename needs it to say whose runs those are",
    },
    {
      name: "workflow_attempts",
      declaredBy: "create table if not exists aai_platform.workflow_attempts",
      droppedBy: "drop table if exists aai_platform.workflow_attempts",
      why: "the attempt CHARGE's old scalar-counter table, replaced by workflow_attempt_leases; still written by old containers for the length of a rollout",
    },
  ];

  describe.each(RETIRED_OBJECTS)("retired $name", ({ name, declaredBy, droppedBy, why }) => {
    test(`is still present — drop it and delete this entry (${why})`, () => {
      const sql = stripSqlComments(migrationSql());
      // Both halves matter: the first refuses an entry naming an object no
      // migration ever put here, the second is what the contract release trips.
      expect(sql, `no migration declares ${name}`).toContain(declaredBy);
      expect(sql, `${name} is dropped — delete this ledger entry`).not.toContain(droppedBy);
    });

    test("is named by no platform source file", () => {
      // Same reasoning as the retired COLUMNS above: a read reintroduced here
      // is invisible until the drop lands, at which point it fails in
      // production rather than in CI. Comments are stripped by
      // `platformSources`, so the modules that explain why this object is gone
      // do not count as users of it.
      const offenders = platformSources()
        .filter(([, source]) => source.includes(name))
        .map(([file]) => file);
      expect(offenders).toEqual([]);
    });
  });

  test("are idempotent, so re-applying is safe", () => {
    // The VENDORED DevKit schema is excluded, and it is the one file whose
    // idempotency is not per-statement. Its DDL is `@workflow/world-postgres`'s
    // own, copied verbatim — rewriting the statements is exactly what vendoring
    // exists not to do — and it is wrapped in drizzle's own guard: a `do` block
    // that compares each journal entry's `when` against the greatest
    // `created_at` in `workflow_drizzle.workflow_migrations` and executes
    // nothing that is already recorded. That is the "inside a DO block that
    // checks for itself" exception this test's comment already names, and it is
    // verified both ways against a real stack — re-applying over a bootstrapped
    // database wrote no second row, and the DevKit's own `bootstrap` after this
    // migration applied nothing.
    //
    // The copier (`scripts/sync-workflow-schema.mjs`) and the gate that held it
    // honest (`pnpm check:workflow-schema`, `workflow-schema-gate.test.ts`) are
    // DELETED with the package they tracked, and the exclusion outlives them:
    // the file is applied, so its statements are frozen either way.
    const sql = migrationFiles()
      .filter((name) => !name.includes("workflow_devkit_schema"))
      .map((name) => readFileSync(path.join(migrationsDir, name), "utf-8"))
      .join("\n");
    // Every bare create must be guarded; the exceptions are inside DO blocks
    // that check for themselves (the publication, the pgmq queue).
    const creates = [...sql.matchAll(/^\s*create (table|schema|extension|index)([^;]*)/gim)];
    expect(creates.length).toBeGreaterThan(0);
    // Soft, so a migration adding several unguarded creates names them all.
    // Compared case-INSENSITIVELY because the scan above is: a migration written
    // in SQL's own uppercase would otherwise fail this while being perfectly
    // guarded, which is a gate rejecting correct work rather than catching bad.
    for (const [statement] of creates) {
      expect.soft(statement.toLowerCase()).toContain("if not exists");
    }
  });
});
