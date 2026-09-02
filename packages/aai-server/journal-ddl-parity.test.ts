// Copyright 2026 the AAI authors. MIT license.
/**
 * The two workflow-journal DDL sets are ONE contract, and nothing compared
 * them.
 *
 * `aai_platform.workflow_*` (this package's migration) and `aai_workflow_*`
 * (`aai-runtime/workflow-journal-schema.ts`) are hand-maintained copies of the
 * same five tables, and the migration says so out loud: "Everything else
 * mirrors `workflow-journal-schema.ts`, deliberately, so the two stores are the
 * same contract and a scenario test over one is evidence about the other." The
 * runtime side makes the reciprocal claim on `CREATE_RUNS` — "`input` is
 * NULLABLE, matching `aai_platform.workflow_runs`" — a claim about a file in a
 * different package, checked by nothing. The nullability claim is TRUE; the
 * `workflow_sleeps.kind` default is not (see `DECLARED_DIVERGENCES`), and it
 * took reading both files side by side to know which was which.
 *
 * This is a STATIC, model-based comparison: it parses both DDL sets and
 * compares them column by column, so it needs no Postgres and runs in the unit
 * tier. `journal-conformance-platform.scenario.test.ts` is the behavioural arm
 * and cannot replace this one — it answers "do both stores behave the same",
 * where the drift this catches is a column that only ONE store's statements
 * happen to bind, which is invisible until the statement that does not.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { workflowJournalDdl } from "@alexkroman1/aai-runtime/internal";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const migrationPath = path.join(
  repoRoot,
  "supabase/migrations/20260901000000_platform_workflow_journal.sql",
);

/** The one column the platform adds, and the whole of what tenancy costs. */
const TENANCY_COLUMN = "slug";

/**
 * The platform table a runtime one corresponds to: `aai_workflow_runs` <->
 * `aai_platform.workflow_runs`, i.e. the `aai_` prefix the runtime carries
 * because its tables sit in an author's own schema becomes the platform's
 * schema qualifier.
 *
 * DERIVED rather than listed, so a sixth table added on either side alone
 * fails the bijection test below instead of being quietly uncompared — which
 * is the failure a hand-kept pairing has. (The runtime's five
 * `WORKFLOW_*_TABLE` constants are not reachable from here: its schema
 * module's doc says `aai-server` "needs the table names", and
 * `@alexkroman1/aai-runtime/internal` publishes only the DDL and the applier.
 * Parsing the DDL for them is stronger anyway — a name that moved in the
 * statement is what matters, not one that moved in a constant.)
 */
function platformNameFor(runtimeTable: string): string {
  return `aai_platform.${runtimeTable.replace(/^aai_/, "")}`;
}

/**
 * Column-level differences that are DECIDED rather than drift, one entry per
 * `<table>.<column>`, each recording both sides and which one is wrong.
 *
 * Two entries. The first is declared by the migration's own header; the second
 * is not declared anywhere, and this is the first thing to say it exists.
 */
const DECLARED_DIVERGENCES: Readonly<Record<string, { platform: string; runtime: string }>> = {
  // DECLARED by the migration: a token is what a third party dials and the URL
  // it dials carries the slug, so uniqueness is `(slug, token)` — a separate
  // unique index, below — rather than the runtime's global `unique`. Making it
  // globally unique here would let one agent's token collide with another's.
  "workflow_hooks.token": { platform: "text not null", runtime: "text not null unique" },
  // NOT declared anywhere, and a real drift: the platform gives `kind` a
  // DEFAULT and the runtime does not. Latent today — both stores bind the
  // column explicitly (`platform-workflow-journal.ts` and
  // `workflow-journal-postgres.ts` both list it in the insert) — but the
  // PLATFORM is the side to change, and the migration's own comment on this
  // column is the argument: journaling a hook's deadline as an ordinary sleep
  // once meant a bare `wakeUp()` closed every open approval window on the run.
  // A `default 'sleep'` is exactly that bug's re-entry point for any future
  // statement that omits the column — it makes a hook deadline silently become
  // an ordinary sleep, where no default makes it a `23502` naming the column.
  "workflow_sleeps.kind": { platform: "text not null default 'sleep'", runtime: "text not null" },
};

/** One parsed column, or a table-level `primary key (…)` clause. */
interface Column {
  readonly name: string;
  /** Everything after the name, whitespace-collapsed. */
  readonly rest: string;
}

interface Table {
  readonly columns: readonly Column[];
  readonly primaryKey: readonly string[];
}

/** SQL with `--` comments removed — the migration is mostly comments. */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/** Split a table body on its top-level commas, ignoring those inside `(…)`. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim().replace(/\s+/g, " ")).filter(Boolean);
}

/**
 * The body of every `create table` in `sql`, by table name.
 *
 * Paren-BALANCED rather than a `[\s\S]*?\)` regex: the platform's every column
 * carries `references aai_platform.agents (slug) on delete cascade`, so a
 * non-greedy match ends at that inner paren and reports a five-table schema as
 * five one-column ones — which would then agree with nothing and, depending on
 * the assertion, pass.
 */
function tableBodies(sql: string): Map<string, string> {
  const text = stripComments(sql);
  const out = new Map<string, string>();
  const opener = /create table if not exists\s+([\w."]+)\s*\(/g;
  for (const match of text.matchAll(opener)) {
    const bodyStart = match.index + match[0].length;
    let depth = 1;
    let i = bodyStart;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    out.set(match[1] ?? "", text.slice(bodyStart, i - 1));
  }
  return out;
}

/**
 * One column entry, with an INLINE `primary key` normalized to the table-level
 * clause plus `not null` — the same declaration, and the runtime's `runs` table
 * is the only place either schema spells it the short way.
 */
function parseColumn(entry: string): { column: Column; primaryKey?: readonly string[] } {
  const [name = "", ...rest] = entry.split(" ");
  const restText = rest.join(" ");
  if (!/ primary key$/.test(` ${restText}`)) return { column: { name, rest: restText } };
  return {
    column: { name, rest: restText.replace(/ ?primary key$/, " not null").trim() },
    primaryKey: [name],
  };
}

/** Both DDL sets, parsed into the same model. */
function parseTables(sql: string): Map<string, Table> {
  const out = new Map<string, Table>();
  for (const [name, body] of tableBodies(sql)) {
    const columns: Column[] = [];
    let primaryKey: readonly string[] = [];
    for (const entry of splitTopLevel(body)) {
      const tableLevel = /^primary key \(([^)]*)\)$/i.exec(entry);
      if (tableLevel) {
        primaryKey = (tableLevel[1] ?? "").split(",").map((column) => column.trim());
        continue;
      }
      const parsed = parseColumn(entry);
      columns.push(parsed.column);
      if (parsed.primaryKey) primaryKey = parsed.primaryKey;
    }
    out.set(name, { columns, primaryKey });
  }
  return out;
}

/** Every `create index` / `create unique index` statement, whitespace-collapsed. */
function parseIndexes(sql: string): string[] {
  return [...stripComments(sql).matchAll(/create (?:unique )?index[\s\S]*?(?=;|$)/g)].map((m) =>
    m[0].trim().replace(/\s+/g, " "),
  );
}

const migrationSql = readFileSync(migrationPath, "utf8");
const platform = parseTables(migrationSql);
const runtimeDdl = workflowJournalDdl();
const runtime = parseTables(runtimeDdl.join(";\n"));
const runsTable = [...runtime.keys()].find((name) => name.endsWith("_runs")) ?? "";
const TABLE_PAIRS: readonly (readonly [string, string])[] = [...runtime.keys()].map((name) => [
  name,
  platformNameFor(name),
]);

describe("the journal DDL parser sees both schemas", () => {
  // A floor, for the reason every counting gate in this repo has one: the whole
  // output below is a comparison, and a parser that stopped matching would
  // compare two empty maps and report perfect parity.
  test("parses five tables on each side, and the pairing is a bijection", () => {
    expect(runtime.size).toBe(5);
    expect(platform.size).toBe(5);
    expect([...platform.keys()].sort()).toEqual(
      TABLE_PAIRS.map(([, name]) => name).sort((a, b) => (a < b ? -1 : 1)),
    );
    for (const table of [...platform.values(), ...runtime.values()]) {
      expect(table.columns.length).toBeGreaterThanOrEqual(3);
      expect(table.primaryKey.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe.each(TABLE_PAIRS)("%s mirrors %s", (runtimeName, platformName) => {
  const shortName = platformName.replace("aai_platform.", "");
  const runtimeTable = runtime.get(runtimeName);
  const platformTable = platform.get(platformName);
  if (!(runtimeTable && platformTable)) throw new Error(`unparsed pair ${runtimeName}`);

  test("the platform adds `slug` first, and nothing else", () => {
    const [first, ...others] = platformTable.columns;
    expect(first?.name).toBe(TENANCY_COLUMN);
    expect(first?.rest).toBe(
      `text not null references aai_platform.agents (${TENANCY_COLUMN}) on delete cascade`,
    );
    expect(others.map((column) => column.name)).toEqual(
      runtimeTable.columns.map((column) => column.name),
    );
  });

  test("every shared column has the same type, nullability and default", () => {
    const platformRest = new Map(platformTable.columns.map((c) => [c.name, c.rest]));
    for (const column of runtimeTable.columns) {
      const declared = DECLARED_DIVERGENCES[`${shortName}.${column.name}`];
      if (declared) {
        // Pinned in BOTH directions, so closing the divergence on either side
        // fails here and has to move this entry rather than leave it stale.
        expect(platformRest.get(column.name)).toBe(declared.platform);
        expect(column.rest).toBe(declared.runtime);
        continue;
      }
      expect(platformRest.get(column.name), `${shortName}.${column.name}`).toBe(column.rest);
    }
  });

  test("the primary key is the runtime's, prefixed with `slug`", () => {
    expect(platformTable.primaryKey).toEqual([TENANCY_COLUMN, ...runtimeTable.primaryKey]);
  });
});

describe("the INDEXES are where the two schemas really differ", () => {
  const platformIndexes = parseIndexes(migrationSql);
  const runtimeIndexes = parseIndexes(runtimeDdl.join(";\n"));

  test("both sides declare the indexes they declare", () => {
    expect(platformIndexes).toHaveLength(3);
    expect(runtimeIndexes).toHaveLength(1);
  });

  test("the runs listing index is missing the runtime's own tiebreaker", () => {
    // A DIVERGENCE, and the runtime is the side to change: both `listRuns`
    // implementations order by `created_at desc, run_id desc` (two runs can
    // share a millisecond, and a `limit` over an untied order pages
    // nondeterministically), and only the platform's index covers the
    // tiebreaker. Correctness is equal — the ORDER BYs agree — so this costs a
    // sort step rather than a wrong answer, which is why it is pinned here
    // instead of being called a bug.
    expect(platformIndexes).toContain(
      "create index if not exists workflow_runs_listing_idx on aai_platform.workflow_runs (slug, workflow, created_at desc, run_id desc)",
    );
    expect(runtimeIndexes).toEqual([
      `create index if not exists ${runsTable}_recent on ${runsTable} (workflow, created_at desc)`,
    ]);
  });

  test("the due-sleep index is platform-only, and that is JUSTIFIED", () => {
    // The one asymmetry that is not drift: `workflow_sleeps_due_idx` serves the
    // platform's fleet-wide wake sweep, which scans the earliest unwoken
    // deadline across every agent. The runtime has no such query — its
    // `wake_at` reads are all run-scoped (`claimSleep`'s read-back and
    // `wakeSleeps`' update both key on `run_id`), because a self-hosted engine
    // delivers from its own in-process timers. An index for a query nobody
    // issues is the dead-config shape this repo keeps paying for.
    expect(platformIndexes).toContain(
      "create index if not exists workflow_sleeps_due_idx on aai_platform.workflow_sleeps (wake_at) where woken = false",
    );
    expect(runtimeIndexes.join(" ")).not.toContain("wake_at");
  });

  test("the hook token's uniqueness is slug-scoped on the platform", () => {
    // The other half of the `workflow_hooks.token` entry above: the runtime
    // spells uniqueness inline and the platform spells it as an index, so the
    // column comparison alone would report the platform as having LOST a
    // constraint.
    expect(platformIndexes).toContain(
      "create unique index if not exists workflow_hooks_token_idx on aai_platform.workflow_hooks (slug, token)",
    );
  });
});
