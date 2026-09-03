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
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { workflowJournalDdl } from "@alexkroman1/aai-runtime/internal";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const migrationsDir = path.join(repoRoot, "supabase/migrations");

/**
 * EVERY migration, in filename order, concatenated.
 *
 * It read the ONE migration that creates these tables, and that made the gate
 * blind to exactly the change it exists to catch: a later `alter table` on
 * either side. `started_at` was the first, and against a single-file read the
 * runtime column simply had no platform counterpart to compare — the failure
 * looked like drift when the migration adding it existed and was unread.
 *
 * Filename order IS apply order here (the timestamps are the names), so
 * concatenating is a faithful replay for the two statement shapes this parses.
 * Reading them all rather than listing the relevant ones is deliberate: a list
 * is the thing that goes stale, and the parse is SCOPED by table name instead —
 * see {@link isJournalTable} — so an unrelated migration contributes nothing.
 */
const migrationSql = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(path.join(migrationsDir, name), "utf8"))
  .join("\n");

/**
 * The tables this gate compares, on either side, or `undefined` for "no scope".
 *
 * The scope that lets the parse read every migration, and it has to be a SET
 * rather than a prefix: `aai_platform.workflow_queue`,
 * `aai_platform.workflow_run_owner` and `aai_platform.workflow_uploads` are all
 * `aai_platform.workflow_*` and none of them is a journal table, so a prefix
 * reported eight tables against the runtime's five and failed the bijection.
 *
 * Filled below, once the runtime side is parsed: the runtime DDL is the
 * authority on which five tables exist, and the platform names are DERIVED from
 * it by {@link platformNameFor} — the same derivation the pairing uses, so a
 * sixth table on either side alone still fails the bijection rather than being
 * quietly uncompared.
 */
let scope: ReadonlySet<string> | undefined;

/** Is this a table the gate compares? Everything, until {@link scope} is set. */
function inScope(name: string): boolean {
  return scope === undefined || scope.has(name.replace(/"/g, ""));
}

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

/**
 * Columns the PLATFORM has and the runtime does not, one entry per
 * `<table>.<column>`, each with why it belongs to one side only.
 *
 * Distinct from {@link DECLARED_DIVERGENCES}, which is about a column both sides
 * have and declare differently. This is about a column that is genuinely not the
 * other side's business — and it exists because widening this gate to read every
 * migration surfaced one that had been invisible: the gate read only the
 * migration that CREATES these tables, so a column added by a later one was
 * uncompared, and `reconciled_at` had been there since
 * `20260901020000_workflow_reconcile_cost.sql`.
 */
const PLATFORM_ONLY_COLUMNS: Readonly<Record<string, string>> = {
  // The reconcile THROTTLE, and platform-only by construction: it stamps the
  // runs a fleet-wide sweep has re-enqueued so the next pass leaves them alone
  // (`workflow-queue-reconcile.ts`). A self-hosted engine has no such sweep —
  // it delivers from its own in-process timers and recovers a lost schedule
  // through `resumableRuns`, which reads no stamp — so a column here would be
  // one nothing writes and nothing reads, which is the dead-config shape this
  // repo keeps paying for.
  "workflow_runs.reconciled_at": "the fleet-wide reconcile throttle; no runtime sweep exists",
  // The reconcile BUDGET, and platform-only for the same reason its stamp is:
  // the count is incremented by the fleet-wide pass and spent against
  // `RECONCILE_MAX_ATTEMPTS` to abandon a run no guest can ever finish
  // (`workflow-queue-reconcile.ts`). A self-hosted engine runs no such pass, so
  // the column would be one nothing increments and nothing reads.
  "workflow_runs.reconciles": "the fleet-wide reconcile budget; no runtime sweep exists",
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
    const name = match[1] ?? "";
    if (inScope(name)) out.set(name, text.slice(bodyStart, i - 1));
  }
  return out;
}

/**
 * Apply every `alter table … add column if not exists` to what is parsed.
 *
 * The second statement shape either side may use, and the one a `create table if
 * not exists` cannot express: that create is a NO-OP once the table is there, so
 * a column added to it reaches a fresh database and no existing one. Both sides
 * therefore carry an ALTER — the runtime in `workflowJournalDdl`, the platform in
 * its own migration — and a gate that read only the creates compared two
 * different schemas from the ones that exist.
 *
 * Appended in statement order, which is what a real apply does, and the column
 * is skipped when the create already declared it: a fresh database gets it from
 * the create and an existing one from the alter, and the parse must not end up
 * with it twice.
 */
function applyAlters(sql: string, tables: Map<string, Table>): void {
  const alter = /alter table\s+([\w."]+)\s+add column if not exists\s+([\w"]+)([^;]*)/gi;
  for (const match of stripComments(sql).matchAll(alter)) {
    const name = match[1] ?? "";
    if (!inScope(name)) continue;
    const table = tables.get(name);
    if (!table) continue;
    const column = (match[2] ?? "").replace(/"/g, "");
    if (table.columns.some((existing) => existing.name === column)) continue;
    (table.columns as Column[]).push({
      name: column,
      rest: (match[3] ?? "").trim().replace(/\s+/g, " "),
    });
  }
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

/**
 * Both DDL sets, parsed into the same model — creates first, then alters.
 *
 * `columns` is declared `readonly` on {@link Table} because nothing else should
 * mutate it; {@link applyAlters} does, through one cast at its push, which is
 * the alternative to threading a mutable twin of this type through the parse.
 */
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
  applyAlters(sql, out);
  return out;
}

/**
 * Every `create index` / `create unique index` over a table in {@link scope},
 * whitespace-collapsed.
 *
 * Scoped for the reason the table parse is: reading every migration turns up 17
 * indexes across the whole platform schema, and this gate's subject is five
 * tables. The filter is on the statement TEXT naming an in-scope table, which is
 * enough because an index statement always names the table it is on.
 */
function parseIndexes(sql: string): string[] {
  return [...stripComments(sql).matchAll(/create (?:unique )?index[\s\S]*?(?=;|$)/g)]
    .map((m) => m[0].trim().replace(/\s+/g, " "))
    .filter((statement) => [...(scope ?? [])].some((table) => statement.includes(table)));
}

// The RUNTIME side first, unscoped: `workflowJournalDdl()` is exactly these five
// tables, so it is the authority on which they are. Then the scope, then the
// platform side — which is read out of every migration and needs one.
const runtimeDdl = workflowJournalDdl();
const runtime = parseTables(runtimeDdl.join(";\n"));
const TABLE_PAIRS: readonly (readonly [string, string])[] = [...runtime.keys()].map((name) => [
  name,
  platformNameFor(name),
]);
scope = new Set(TABLE_PAIRS.flat());
const platform = parseTables(migrationSql);
const runsTable = [...runtime.keys()].find((name) => name.endsWith("_runs")) ?? "";

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

  test("the platform adds `slug` first, plus only its declared own columns", () => {
    const [first, ...others] = platformTable.columns;
    expect(first?.name).toBe(TENANCY_COLUMN);
    expect(first?.rest).toBe(
      `text not null references aai_platform.agents (${TENANCY_COLUMN}) on delete cascade`,
    );
    // Compared as SETS, not in order, and the order test had to go: a column
    // added by an `alter table` lands at the END of the table it alters, so the
    // two sides diverge in position the moment either adds one — `started_at`
    // sits before `finished_at` in the runtime's `create` and after it on the
    // platform, which is a physical detail no statement here depends on. Every
    // claim that DOES matter (type, nullability, default, primary key) is
    // asserted by name below.
    const sorted = (names: readonly string[]) => [...names].sort();
    const platformOwn = new Set(
      Object.keys(PLATFORM_ONLY_COLUMNS)
        .filter((entry) => entry.startsWith(`${shortName}.`))
        .map((entry) => entry.slice(shortName.length + 1)),
    );
    expect(
      sorted(others.map((column) => column.name).filter((name) => !platformOwn.has(name))),
    ).toEqual(sorted(runtimeTable.columns.map((column) => column.name)));
    // The declared entries have to BE there, so closing one on the platform
    // fails here rather than leaving a stale exemption.
    for (const own of platformOwn) {
      expect(
        others.map((column) => column.name),
        `${shortName}.${own}`,
      ).toContain(own);
    }
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
    // A floor AND a ceiling: an index added on either side alone has to be
    // classified by one of the three cases below rather than slipping in.
    expect(platformIndexes).toHaveLength(6);
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

  test("the two RECONCILE indexes are platform-only, and that is JUSTIFIED too", () => {
    // Both arrived in `20260901020000_workflow_reconcile_cost.sql` and were
    // uncompared until this gate began reading every migration rather than the
    // one that creates the tables. Neither is drift: they serve
    // `findStalledRuns`, the fleet-wide query that re-enqueues a run whose queue
    // message went missing — the outer scan on `workflow_runs`, and the
    // open-window anti-join on `workflow_hooks` that keeps a PARKED run from
    // being read as a stalled one. A self-hosted engine issues neither: it
    // delivers from its own in-process timers and recovers through
    // `resumableRuns`, whose reads are all run-scoped.
    expect(platformIndexes).toContain(
      "create index if not exists workflow_runs_stalled_idx on aai_platform.workflow_runs (created_at) where status in ('pending', 'running')",
    );
    expect(platformIndexes).toContain(
      "create index if not exists workflow_hooks_open_idx on aai_platform.workflow_hooks (slug, run_id) where delivered = false and closed = false",
    );
  });

  test("the RETENTION index is platform-only, and that is JUSTIFIED too", () => {
    // `workflow_runs_terminal_idx`, from `20260902120000_workflow_run_
    // abandonment.sql`. It serves `sweep_terminal_workflow_runs`, which walks
    // terminal runs oldest-first across every agent to drop them past the
    // retention window — a fleet-wide scan the runtime has no equivalent of.
    // The memory backend bounds itself by COUNT instead
    // (`MAX_TERMINAL_RUNS`, `forgetOldTerminalRuns`), and the Postgres one
    // does not sweep at all: a self-hosted operator owns their database's
    // retention. Partial on the three terminal statuses, which is what makes
    // it disjoint from `workflow_runs_stalled_idx` rather than redundant with
    // it — that one is partial on the two LIVE statuses.
    expect(platformIndexes).toContain(
      "create index if not exists workflow_runs_terminal_idx on aai_platform.workflow_runs (created_at) where status in ('completed', 'failed', 'cancelled')",
    );
  });

  test("the due-sleep index is platform-only, and that is JUSTIFIED", () => {
    // The one asymmetry that is not drift, and its justification was RE-MEASURED
    // after the query it originally named was retired.
    //
    // It used to read "serves the platform's fleet-wide wake sweep, which scans
    // the earliest unwoken deadline across every agent". That sweep is GONE —
    // `agent-sweeps.ts` says so in place, the queue's delivery pass replaced it —
    // so on the face of it this was the dead-config shape this repo keeps paying
    // for: the only predicate left over `workflow_sleeps` outside the journal's
    // own `(slug, run_id, key)`-scoped statements is `findStalledRuns`'s
    // elapsed-deadline arm, which is run-scoped and leads with the primary key.
    //
    // It is NOT dead, and `explain` is the only thing that could have said so.
    // Postgres FLATTENS that correlated `exists` into a HASHED subplan over the
    // fleet-wide half of the predicate — `woken = false and wake_at < cutoff`,
    // which is exactly `(wake_at) where woken = false` — rather than probing the
    // primary key once per candidate run. So the index really is "exactly this
    // predicate", for a reason neither justification stated: not because the
    // subquery is fleet-wide, but because the PLANNER makes it so.
    //
    // Measured on PostgreSQL 16.13 against the real migration set, 200k runs /
    // 200k sleeps / 200k hooks, ~66.7k of them due and unwoken:
    //
    //   index present -> Index Scan using workflow_sleeps_due_idx
    //                    (66,666 rows, 17.4 ms), statement 110.3 ms
    //   index dropped -> Seq Scan on workflow_sleeps
    //                    (66,666 rows, 25.1 ms), statement 120.6 ms
    //
    // `findStalledRuns` runs on every idle tick of every replica
    // (`workflow-queue-sweep.ts` — NO leader lock), so what the index buys is
    // removing a sequential scan of that table from a >= 1 Hz per-replica query.
    // The index is 2,936 kB against the primary key's 15 MB.
    //
    // The runtime still has no query that can use it — its `wake_at` reads are
    // all run-scoped (`claimSleep`'s read-back and `wakeSleeps`' update both key
    // on `run_id`) and none of them is a fleet-wide `exists` a planner could
    // flatten — because a self-hosted engine delivers from its own in-process
    // timers. So the asymmetry is the platform having a reconcile pass, not the
    // runtime having lost an index.
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
