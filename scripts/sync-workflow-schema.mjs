#!/usr/bin/env node

/**
 * The CREATOR for the DevKit's `workflow` schema, vendored as a Supabase
 * migration — and the gate that keeps it level with the package.
 *
 * ## The gap this closes
 *
 * The durable-run journal lives on the PLATFORM's database now
 * (`20260827000000_workflow_world.sql`), in the DevKit's own `workflow` schema.
 * Three migrations say that schema is "created by `@workflow/world-postgres`'s
 * own migration" — and after the world moved, nothing in this repository ran
 * it. It used to be the GUEST's job: `workflow-world.ts` called
 * `@workflow/world-postgres/cli`'s `setupDatabase()` against the agent's own
 * `DATABASE_URL`, with a whole documented `process.exit` stand-in around it
 * (that half survives, in `aai-runtime/workflow-world-migrate.ts`, for a guest
 * that still supplies a database of its own). The platform path replaced it
 * with a comment — "the schema is the platform's" — and no creator.
 *
 * What that costs is not subtle. On a database nobody bootstrapped by hand,
 * every durable run fails on the way in:
 *
 *     workflow.storage storage call failed  method=events.create
 *       error='relation "workflow.workflow_runs" does not exist'
 *     http 503 on /<slug>/workflow-storage
 *
 * and the caller sees `{"error":"Internal server error"}` from
 * `POST /<slug>/workflows/runs`. Reproduced against a fresh local stack with
 * the `link-digest` template; a fresh production project is the same database.
 *
 * ## Why a migration and not boot-time DDL
 *
 * Because that decision is already made, and written down: `service-config.ts`
 * records that boot "used to also create the platform tables, the Realtime
 * publication, and the `service_role` grants", and that "all of that is
 * declared in `supabase/migrations/*_platform_schema.sql` now and applied
 * before any code runs; only the SCHEDULING stays here". Platform schema is a
 * migration. A creator at boot would reverse that for one schema, and would
 * additionally have to solve a problem the bundle makes real: the studio server
 * ships as one rolldown bundle with `@workflow/world-postgres` INLINED
 * (`import("./dist-BaCUbDSQ.mjs")`, verified), so at runtime the package is not
 * resolvable from the bundle's directory and its `.sql` files — data, which no
 * bundler inlines — are not there to read.
 *
 * Their `setupDatabase` is not reusable either: it is a CLI entry point that
 * calls `process.exit`, reads `dotenv`, takes its connection string from
 * `WORKFLOW_POSTGRES_URL`/`DATABASE_URL` (the platform's is `SUPABASE_DB_URL`),
 * and also bootstraps a `graphile_worker` schema this platform never uses —
 * `world.start()` is deliberately never called, the queue being
 * `workflow-queue-store.ts`. An unused schema of unprotected tables on the
 * platform's database is the thing `20260828010000_workflow_schema_rls.sql`
 * exists to argue against.
 *
 * ## What is generated, and why it stays honest
 *
 * A vendored copy of somebody else's schema goes stale the first time they add
 * a table — which is the exact failure the RLS migration names. So the copy is
 * GENERATED from the installed package and GATED: `--check` re-reads
 * `@workflow/world-postgres`'s journal and fails when an entry is not covered
 * by a committed migration, or when a covered entry's SQL has changed under us.
 * Same shape as `check:scaffold` and `check:guest-toolchain` — a committed copy
 * with a gate, rather than a copy and a hope.
 *
 * A generated file APPENDS rather than rewrites: a migration that has been
 * applied is immutable, so new journal entries become a NEW migration and the
 * gate reads the whole set. Coverage is recorded in each file's own
 * `-- devkit-entry:` header lines, so there is no second manifest to drift.
 *
 * The emitted SQL is drizzle's own algorithm, statement for statement: create
 * `workflow_drizzle.workflow_migrations`, compare each entry's `when` against
 * the greatest `created_at` recorded there, apply and record the ones that are
 * newer (`pg-core/dialect.cjs`'s `migrate`). That is what makes it idempotent
 * AND interoperable in both directions — an operator who has already run their
 * `bootstrap` gets a no-op here, and anyone who runs `bootstrap` after this
 * migration gets a no-op there.
 *
 * ## Usage
 *
 *   node scripts/sync-workflow-schema.mjs           # write a migration for uncovered entries
 *   node scripts/sync-workflow-schema.mjs --check   # report drift, exit 1, write nothing
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { parseScriptArgs } from "./_args.mjs";
import { readJson, repoRoot } from "./_fs.mjs";

const { values: flags } = parseScriptArgs({
  script: import.meta.url,
  options: { check: { type: "boolean" } },
});
const checkOnly = flags.check === true;
const root = repoRoot(import.meta.url);
const migrationsDir = join(root, "supabase/migrations");

/** The package whose schema this vendors. */
const DEVKIT = "@workflow/world-postgres";

/**
 * The exports key whose TARGET names the migrations folder.
 *
 * Read out of their manifest rather than assumed, because the two obvious
 * spellings are both guesses about a layout they never promised: their own CLI
 * hard-codes `dist/../src/drizzle/migrations`, and `import.meta.resolve` of the
 * bare name lands in `dist/`. This key is a published contract
 * (`"./migrations/*.sql": "./src/drizzle/migrations/*.sql"`), so a reorganised
 * package fails here by name instead of silently resolving to nothing.
 */
const MIGRATIONS_EXPORT = "./migrations/*.sql";

/** Their bookkeeping, exactly as `setupDatabase` passes it to drizzle. */
const BOOKKEEPING_SCHEMA = "workflow_drizzle";
const BOOKKEEPING_TABLE = "workflow_migrations";

/** The dollar-quote tags the generated SQL uses. Refused if the DDL contains one. */
const BLOCK_TAG = "aai_devkit";
const DDL_TAG = "aai_devkit_ddl";

/** Marks a journal entry as covered by a committed migration. */
const ENTRY_MARKER = "-- devkit-entry:";

/**
 * Floor on the journal, because this gate's whole success output is a COUNT.
 *
 * A read that stopped finding entries would report "all 0 migration(s) are
 * vendored ✓" against a committed nothing and pass — the same shape as every
 * other floored gate here. Measured at 12 (`@workflow/world-postgres@4.3.3`);
 * their journal only grows, and a version that genuinely shipped fewer is a
 * downgrade worth failing on.
 */
const MIN_JOURNAL_ENTRIES = 10;

/**
 * The installed package's root, by the node_modules WALK-UP.
 *
 * The same resolution `harness-sdk-version.ts` uses and for the same reason:
 * their `exports` map does not publish `./package.json`, so neither
 * `require.resolve` nor `import.meta.resolve` can reach the manifest this needs
 * to read. Started from `packages/aai-server`, which is the package that
 * declares the dependency.
 */
function devkitRoot() {
  let dir = join(root, "packages/aai-server");
  for (;;) {
    const candidate = join(dir, "node_modules", ...DEVKIT.split("/"));
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`${DEVKIT} is not installed under packages/aai-server — run pnpm install`);
}

/** Their migrations folder, derived from the exports target. */
function devkitMigrationsDir(pkgRoot) {
  const target = readJson(join(pkgRoot, "package.json")).exports?.[MIGRATIONS_EXPORT];
  if (typeof target !== "string") {
    throw new Error(
      `${DEVKIT} no longer exports ${MIGRATIONS_EXPORT} — its migrations folder has moved, ` +
        "and this generator's assumption about where to read the journal is stale.",
    );
  }
  return join(pkgRoot, dirname(target));
}

/**
 * The journal, in apply order, with each entry's SQL and drizzle's own hash.
 *
 * `sha256` over the WHOLE file, which is what `readMigrationFiles` records — so
 * a row this generator writes is byte-identical to one their migrator would
 * write, which is the whole basis of the two being interchangeable.
 */
function readJournal(dir) {
  const journalPath = join(dir, "meta/_journal.json");
  if (!existsSync(journalPath)) throw new Error(`no journal at ${journalPath}`);
  const journal = readJson(journalPath);
  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  if (entries.length < MIN_JOURNAL_ENTRIES) {
    throw new Error(
      `${journalPath} declares ${entries.length} entries, under the floor of ` +
        `${MIN_JOURNAL_ENTRIES} — either the journal moved or this reader stopped ` +
        "finding it, and both make every count this gate prints meaningless.",
    );
  }
  return entries.map((entry) => {
    const sql = readFileSync(join(dir, `${entry.tag}.sql`), "utf-8");
    return {
      tag: String(entry.tag),
      when: Number(entry.when),
      hash: createHash("sha256").update(sql).digest("hex"),
      sql,
    };
  });
}

/** Every entry any committed migration already covers, tag → hash. */
function committedEntries() {
  const covered = new Map();
  if (!existsSync(migrationsDir)) return covered;
  for (const file of readdirSync(migrationsDir).sort()) {
    if (!file.endsWith(".sql")) continue;
    for (const line of readFileSync(join(migrationsDir, file), "utf-8").split("\n")) {
      if (!line.startsWith(ENTRY_MARKER)) continue;
      const [tag, , hash] = line.slice(ENTRY_MARKER.length).trim().split(/\s+/);
      covered.set(tag, { hash, file });
    }
  }
  return covered;
}

/** A UTC `YYYYMMDDHHMMSS` version that sorts after everything already committed. */
function nextVersion() {
  const now = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const last = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .at(-1);
  const lastVersion = last?.slice(0, 14) ?? "0";
  return now > lastVersion ? now : String(BigInt(lastVersion) + 1n);
}

/** One entry's guarded apply-and-record, in drizzle's own terms. */
function entryBlock(entry) {
  if (entry.sql.includes(`$${DDL_TAG}$`)) {
    throw new Error(`${entry.tag}.sql contains the dollar-quote tag $${DDL_TAG}$`);
  }
  return `  if last_applied is null or last_applied < ${entry.when} then
    raise notice 'applying ${DEVKIT} ${entry.tag}';
    execute $${DDL_TAG}$
${entry.sql.trimEnd()}
$${DDL_TAG}$;
    insert into ${BOOKKEEPING_SCHEMA}.${BOOKKEEPING_TABLE} ("hash", "created_at")
      values ('${entry.hash}', ${entry.when});
    last_applied := ${entry.when};
  end if;
`;
}

/** The whole generated migration for a set of uncovered entries. */
function render(entries) {
  const header = [
    `-- The DevKit's own \`workflow\` schema, vendored from ${DEVKIT}.`,
    "--",
    "-- GENERATED by scripts/sync-workflow-schema.mjs — do not edit by hand. That",
    "-- script's module doc carries the argument: why the platform's journal needs a",
    "-- creator at all, why it is a migration rather than boot-time DDL, and why the",
    "-- copy is gated (`pnpm check:workflow-schema`) rather than trusted.",
    "--",
    "-- This is drizzle's own migrate algorithm (`pg-core/dialect.cjs`): compare each",
    "-- journal entry's `when` against the greatest `created_at` in their bookkeeping",
    "-- table, apply and record what is newer. So it is idempotent, and it is a no-op",
    "-- in both directions against `@workflow/world-postgres`'s own `bootstrap` —",
    "-- whichever runs second finds nothing to do.",
    "--",
    "-- The `-- devkit-entry:` lines below are how the gate knows what is covered;",
    "-- they are read back out of every committed migration, so there is no second",
    "-- manifest to go stale. New entries in a later package version become a NEW",
    "-- migration, never an edit to this one.",
    "",
    ...entries.map((e) => `${ENTRY_MARKER} ${e.tag} ${e.when} ${e.hash}`),
    "",
    `do $${BLOCK_TAG}$`,
    "declare",
    "  last_applied bigint;",
    "begin",
    `  create schema if not exists ${BOOKKEEPING_SCHEMA};`,
    `  create table if not exists ${BOOKKEEPING_SCHEMA}.${BOOKKEEPING_TABLE} (`,
    "    id serial primary key,",
    "    hash text not null,",
    "    created_at bigint",
    "  );",
    "  select max(created_at) into last_applied",
    `    from ${BOOKKEEPING_SCHEMA}.${BOOKKEEPING_TABLE};`,
    "",
  ].join("\n");

  const body = entries.map(entryBlock).join("\n");

  // Deny-all RLS over whatever the block above created, in the same words as
  // `20260828010000_workflow_schema_rls.sql` — which is the migration that
  // cannot cover these tables on a fresh project, because it runs BEFORE they
  // exist and says so ("re-apply after the DevKit migration"). Running it here,
  // in the same file that creates them, is what retires that ordering note:
  // the tables are never present and unprotected, not even for one migration.
  const rls = `end
$${BLOCK_TAG}$;

do $${BLOCK_TAG}_rls$
declare
  t record;
begin
  for t in select tablename from pg_tables where schemaname = 'workflow'
  loop
    execute format('alter table workflow.%I enable row level security', t.tablename);
  end loop;
  execute 'revoke all on schema workflow from public, anon, authenticated';
  execute 'revoke all on all tables in schema workflow from public, anon, authenticated';
end
$${BLOCK_TAG}_rls$;
`;

  return `${header}${body}${rls}`;
}

const pkgRoot = devkitRoot();
const journal = readJournal(devkitMigrationsDir(pkgRoot));
const covered = committedEntries();

const changed = journal.filter((e) => covered.has(e.tag) && covered.get(e.tag).hash !== e.hash);
if (changed.length > 0) {
  const names = changed.map((e) => `${e.tag} (in ${covered.get(e.tag).file})`).join(", ");
  console.error(
    `workflow-schema: ${changed.length} vendored entr${changed.length === 1 ? "y" : "ies"} ` +
      `no longer match ${DEVKIT}: ${names}.\n` +
      "A published migration changed content under us — that is upstream rewriting history, " +
      "not a sync. Do not regenerate: work out what they changed and whether an applied " +
      "database needs repairing.",
  );
  process.exit(1);
}

const uncovered = journal.filter((e) => !covered.has(e.tag));
if (uncovered.length === 0) {
  console.log(
    `workflow-schema: all ${journal.length} ${DEVKIT} migration(s) are vendored ✓ ` +
      `(${covered.size} covered by supabase/migrations)`,
  );
  process.exit(0);
}

if (checkOnly) {
  console.error(
    `workflow-schema: ${uncovered.length} ${DEVKIT} migration(s) are NOT vendored: ` +
      `${uncovered.map((e) => e.tag).join(", ")}.\n` +
      "The platform's durable-run journal is created by supabase/migrations, so an entry " +
      "that is not there does not exist on the platform's database — and every run that " +
      'needs it fails with `relation "workflow.<table>" does not exist`.\n' +
      "Run `node scripts/sync-workflow-schema.mjs` to write the migration.",
  );
  process.exit(1);
}

const file = join(migrationsDir, `${nextVersion()}_workflow_devkit_schema.sql`);
writeFileSync(file, render(uncovered));
console.log(
  `workflow-schema: wrote ${relative(root, file)} covering ` +
    `${uncovered.map((e) => e.tag).join(", ")}`,
);
