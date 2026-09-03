// Copyright 2026 the AAI authors. MIT license.
/**
 * Which platform tables are pruned on a timeframe, and which are NOT.
 *
 * The claim this exists to settle is "every table outside `auth` gets pruned on
 * some timeframe". It is FALSE as stated, and the useful form of that answer is
 * not prose: it is a verdict per table, derived from the migrations rather than
 * listed, so a new table cannot arrive without one and a sweep cannot be deleted
 * without the verdict that names it failing.
 *
 * ## Why the existing guards cannot answer it
 *
 * `platform-schema.test.ts` asserts a table is DECLARED and has RLS;
 * `pg-cron.test.ts` asserts a sweep body says what its own comment says. Neither
 * pairs the two, so a table with no retention at all is invisible to both — and
 * `20260901020000_workflow_reconcile_cost.sql` records paying for exactly that
 * once already: nothing had ever deleted a terminal `workflow_runs` row, and the
 * cost surfaced as a query getting slower rather than as a disk graph.
 *
 * The same gap re-opened one table later. `workflow_attempt_leases` replaced
 * `workflow_attempts`, and the retention sweep is a hand-written CTE per child
 * table with no cascade under it (every child references `agents`, not
 * `workflow_runs`) — so a new child of a run is a leak per retired run until
 * somebody remembers the CTE. It was remembered; nothing would have said so.
 *
 * ## What a verdict has to earn
 *
 * A `sweep` verdict names a job in {@link platformCronJobs} and the window
 * literal in its body, so deleting either fails here. A `run-sweep` verdict is
 * checked against the LATEST `sweep_terminal_workflow_runs` body in the
 * migrations — that function is re-issued whole by each migration that touches
 * it, so reading the last one is reading what production runs.
 *
 * An `unpruned` verdict is the interesting one: it is not an exemption to be
 * waved through but a recorded FACT with evidence, either a delete path in a
 * named source file or an `on delete cascade` in the schema. That keeps the list
 * honest in both directions — it cannot become a place to park a table nobody
 * wanted to sweep, and it is the answer to "prove it" for the five tables where
 * the honest answer is "this is not pruned by time".
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { RECONCILE_MAX_ATTEMPTS } from "./_reconcile-abandon.ts";
import { platformCronJobs } from "./pg-cron.ts";
import { SESSION_STATE_RETENTION } from "./platform-session-state.ts";
import { UPLOAD_RECORD_RETENTION } from "./platform-uploads.ts";
import { STALL_GRACE_MS } from "./workflow-queue-reconcile.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const migrationsDir = path.join(repoRoot, "supabase/migrations");

/**
 * The migrations in apply order, concatenated, COMMENTS STRIPPED.
 *
 * Stripping is load-bearing rather than tidy: `20260828010000_workflow_schema_
 * rls.sql` writes `create table if not exists aai_platform.<name>` in prose to
 * explain what its `do` block covers, so an unstripped scan derives a table named
 * `<name>` and this whole suite fails on a sentence.
 */
function migrationSql(): string {
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (files.length === 0) throw new Error(`no migrations in ${migrationsDir}`);
  return files
    .map((name) => readFileSync(path.join(migrationsDir, name), "utf-8"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "");
}

/**
 * Every `aai_platform` table that EXISTS — created by some migration and dropped
 * by none.
 *
 * Derived, never listed, which is the property the whole suite rests on: a table
 * added without a verdict below fails, and that is the only way this cannot go
 * stale. The drop half matters even though no migration drops a table today —
 * `RETIRED_OBJECTS` in `platform-schema.test.ts` holds three that are owed one,
 * and the release that lands a drop must not then have to argue about retention
 * for a table that is gone.
 */
function declaredTables(): string[] {
  const sql = migrationSql();
  const names = (re: RegExp): string[] =>
    [...sql.matchAll(re)]
      .map(([, table]) => table)
      .filter((table): table is string => table !== undefined);
  const created = new Set(names(/create table if not exists aai_platform\.([a-z_]+)/g));
  for (const table of names(/drop table if exists aai_platform\.([a-z_]+)/g)) {
    created.delete(table);
  }
  // Code-unit order, never `localeCompare`: with no explicit locale that answers
  // to the runtime's ICU default, so the same input could order differently on
  // another machine.
  return [...created].sort();
}

/** The body of the LAST `sweep_terminal_workflow_runs` definition in apply order. */
function terminalRunSweepBody(): string {
  const definitions = [
    ...migrationSql().matchAll(
      /create or replace function aai_platform\.sweep_terminal_workflow_runs[\s\S]*?\$fn\$;/g,
    ),
  ].map(([body]) => body);
  const latest = definitions.at(-1);
  // THROWS rather than asserts: a helper that cannot find its target has
  // established no fact about the code, so the honest outcome is a failed run
  // naming the retarget.
  if (latest === undefined) {
    throw new Error("no aai_platform.sweep_terminal_workflow_runs definition found");
  }
  return latest;
}

/** Every sweep the platform schedules, with object storage configured. */
const sweeps = () =>
  platformCronJobs({ storage: { url: "https://proj.supabase.co", bucket: "aai-blobs" } });

const sweepBody = (job: string): string => sweeps().find((j) => j.name === job)?.command ?? "";

/**
 * How a table's rows stop existing.
 *
 * - `sweep` — a pg_cron job in {@link platformCronJobs} deletes from it by age.
 *   `window` is a literal that must appear in the body, so the policy and the
 *   assertion cannot drift.
 * - `run-sweep` — deleted by `aai_platform.sweep_terminal_workflow_runs` as a
 *   child of the run it belongs to, 30 days after that run started.
 * - `unpruned` — NOTHING deletes it on a timeframe. `evidence` says what does
 *   delete it, and is checked, so this is a recorded fact rather than a pass.
 */
type Verdict =
  | { pruned: "sweep"; job: string; window: string; why: string }
  | { pruned: "run-sweep"; why: string }
  | {
      pruned: "unpruned";
      /** A delete path in a platform source file, or a cascading parent table. */
      evidence: { source: string; literal: string } | { cascadeFrom: string };
      why: string;
    };

/**
 * The verdict for every `aai_platform` table.
 *
 * Twelve of seventeen are pruned on a timeframe. The five that are not are the
 * answer to the question this file is named for, and each is a deliberate
 * position rather than an oversight:
 *
 * `agents`, `studio_workspaces` and `studio_chats` are the author's own product —
 * a deployed agent, a studio project, its chat history. Expiring those on a timer
 * would delete somebody's working agent while they were away from it, so they go
 * when the author says so and not before. `workflow_queue` is transient by
 * construction but NOT by clock: a parked `sleep()` message is a live row that may
 * legitimately outlive any window, so retention here would cancel workflows.
 * `workflow_run_owner` is retired — written by nothing, owed a `drop` — so its
 * rows are frozen rather than growing.
 */
const RETENTION: Record<string, Verdict> = {
  agents: {
    pruned: "unpruned",
    evidence: { source: "bundle-store.ts", literal: "async deleteAgent(slug) {" },
    why: "a deployed agent is the author's product; only they retire it (`aai delete`). The orphan-preview sweep reaches ONLY `%-preview` slugs, so it is not retention for this table",
  },
  session_events: {
    pruned: "sweep",
    job: "aai-sweep-session-state",
    window: SESSION_STATE_RETENTION,
    why: "a session's event log, expired with its slot — events without slots is a log describing state that is gone",
  },
  session_slots: {
    pruned: "sweep",
    job: "aai-sweep-session-state",
    window: SESSION_STATE_RETENTION,
    why: "durable session state a dead guest left behind",
  },
  studio_chats: {
    pruned: "unpruned",
    evidence: { cascadeFrom: "studio_workspaces" },
    why: "the author's chat history with the coding agent; it goes when the workspace does",
  },
  studio_rate_limits: {
    pruned: "sweep",
    job: "aai-sweep-rate-limits",
    window: "reset_at <= now()",
    why: "an expired window is only read again to be overwritten",
  },
  studio_sessions: {
    pruned: "sweep",
    job: "aai-sweep-studio-sessions",
    window: "expires_at <= now()",
    why: "these rows carry guest credentials, so they must not outlive their lease",
  },
  studio_workspaces: {
    pruned: "unpruned",
    evidence: { source: "workspace-store.ts", literal: "aai_platform.studio_workspaces" },
    why: "the author's project source. A timer that deleted this would delete the work itself",
  },
  workflow_attempt_leases: {
    pruned: "run-sweep",
    why: "outstanding attempt charges for a run's steps",
  },
  workflow_attempts: {
    pruned: "run-sweep",
    why: "the retired scalar-counter table, still swept while old containers write it",
  },
  workflow_hooks: { pruned: "run-sweep", why: "a run's `waitFor` windows and their tokens" },
  workflow_queue: {
    pruned: "unpruned",
    evidence: {
      source: "workflow-queue-store.ts",
      literal: "delete from aai_platform.workflow_queue where id = $1",
    },
    why: "a message is removed when it is delivered or its retry budget runs out. NOT time-bounded on purpose: a parked `sleep()` may be due months out, and expiring it would cancel the run",
  },
  workflow_run_keys: {
    pruned: "sweep",
    job: "aai-sweep-workflow-run-keys",
    window: "30 days",
    why: "the caller's `(workflow, key) -> runId` pointer, collected once its run is gone",
  },
  workflow_run_owner: {
    pruned: "unpruned",
    evidence: { cascadeFrom: "agents" },
    why: "retired: written and read by nothing, kept only so the DevKit schema rename stays reversible, and owed a `drop` (see RETIRED_OBJECTS in platform-schema.test.ts)",
  },
  workflow_runs: {
    pruned: "sweep",
    job: "aai-sweep-workflow-runs",
    window: "sweep_terminal_workflow_runs",
    why: "terminal runs, 30 days after they started — the function's own default",
  },
  workflow_sleeps: { pruned: "run-sweep", why: "a run's parked `sleep()` journal entries" },
  workflow_steps: { pruned: "run-sweep", why: "a run's step journal" },
  workflow_uploads: {
    pruned: "sweep",
    job: "aai-sweep-upload-records",
    window: UPLOAD_RECORD_RETENTION,
    why: "an upload record, and the blob GC reclaims its bytes once the record is gone",
  },
};

describe("every aai_platform table has a retention verdict", () => {
  test("the verdicts and the schema are a bijection", () => {
    // Both directions. A table with no verdict is the leak this file exists to
    // catch; a verdict naming no table is a rule guarding something that moved,
    // which is how a list like this rots into decoration.
    expect(declaredTables()).toEqual(Object.keys(RETENTION).sort());
  });

  test("the schema is really being read", () => {
    // The whole output of the assertion above is a set comparison, so an empty
    // corpus would compare `[]` against `[]` and pass. Floored at the count when
    // this landed.
    expect(declaredTables().length).toBeGreaterThanOrEqual(17);
  });
});

const entries = Object.entries(RETENTION);

describe.each(entries.filter(([, v]) => v.pruned === "sweep"))(
  "%s is swept by age",
  (table, verdict) => {
    if (verdict.pruned !== "sweep") throw new Error("filtered above");

    test(`${verdict.job} exists and names the table (${verdict.why})`, () => {
      expect(sweeps().map((j) => j.name)).toContain(verdict.job);
      const body = sweepBody(verdict.job);
      // `workflow_runs` is swept THROUGH a function, so the table's own name is
      // not in the command — the window literal below is what identifies it, and
      // the CTE assertions in the run-sweep block are what prove the delete.
      if (table !== "workflow_runs") expect(body).toContain(`aai_platform.${table}`);
      expect(body).toMatch(/delete from|select aai_platform\./);
    });

    test("the body carries the window this verdict claims", () => {
      // A window recorded here and not in the body is a retention policy that
      // exists only in a test — which is the same defect as one that exists only
      // in a comment.
      expect(sweepBody(verdict.job)).toContain(verdict.window);
    });

    test("runs on a schedule, so the window is a bound and not an intention", () => {
      const job = sweeps().find((j) => j.name === verdict.job);
      expect(job?.schedule).toMatch(/^\S+ \S+ \S+ \S+ \S+$/);
    });
  },
);

describe("runs and their children are collected together", () => {
  const children = entries
    .filter(([, v]) => v.pruned === "run-sweep")
    .map(([table]) => table)
    .sort();

  test("the sweep job calls the function the migrations define", () => {
    expect(sweepBody("aai-sweep-workflow-runs")).toContain(
      "select aai_platform.sweep_terminal_workflow_runs()",
    );
  });

  test.each(children)("%s is deleted by the terminal-run sweep", (table) => {
    // The assertion `workflow_attempt_leases` needed and did not have. Every one
    // of these references `agents` rather than `workflow_runs`, so there is no
    // cascade under them: a child added without its own CTE leaks a row for every
    // run the sweep retires, forever, and nothing else in the repo would say so.
    expect(terminalRunSweepBody()).toContain(`delete from aai_platform.${table}`);
  });

  test("the run row itself goes too, and last", () => {
    const body = terminalRunSweepBody();
    expect(body).toContain("delete from aai_platform.workflow_runs r");
    for (const table of children) {
      expect
        .soft(
          body.indexOf(`delete from aai_platform.${table}`),
          `${table} is deleted after the run it belongs to`,
        )
        .toBeLessThan(body.indexOf("delete from aai_platform.workflow_runs r"));
    }
  });

  test("the window is bounded, and the loop can drain a backlog", () => {
    const body = terminalRunSweepBody();
    // 30 days, spelled as arithmetic in the function's own default.
    expect(body).toContain("retain_ms bigint default 30::bigint * 24 * 60 * 60 * 1000");
    // Without the loop the ceiling is one batch per call, which is what made a
    // daily pass unable to keep up with measured throughput.
    expect(body).toContain("max_total integer := 10 * batch");
  });

  /**
   * The predicate is TERMINAL runs, so the window only bounds the table if every
   * run reaches a terminal status. That is a two-part claim spanning SQL and
   * TypeScript, and neither half's own tests can see the other.
   */
  test("a run whose guest never finishes it still reaches a status the sweep collects", () => {
    const body = terminalRunSweepBody();
    expect(body).toContain("r.status in ('completed', 'failed', 'cancelled')");
    const abandon = readFileSync(path.join(import.meta.dirname, "_reconcile-abandon.ts"), "utf-8");
    // `abandonStalledRun` is the only writer of a terminal status on the platform
    // side — the guest's engine writes the others — so this is the link that makes
    // the retention window apply to a run nobody can complete.
    expect(abandon).toContain('"failed"');
    // And the giving-up is bounded, which is what turns "eventually terminal" into
    // a number: five re-walks, each a full stall window apart.
    expect(RECONCILE_MAX_ATTEMPTS).toBeGreaterThan(0);
    expect(Number.isFinite(RECONCILE_MAX_ATTEMPTS * STALL_GRACE_MS)).toBe(true);
  });
});

describe.each(entries.filter(([, v]) => v.pruned === "unpruned"))(
  "%s is NOT pruned on a timeframe",
  (table, verdict) => {
    if (verdict.pruned !== "unpruned") throw new Error("filtered above");

    test(`no sweep deletes from it (${verdict.why})`, () => {
      // The other direction of the verdict, and the half that makes this list
      // self-clearing: give this table a sweep and the entry has to move to
      // `sweep`, which is the only way the two halves cannot disagree.
      //
      // DELETES, not mentions. The orphan-preview reap READS
      // `studio_workspaces` — its anti-join is what makes a preview an orphan —
      // and reading a table is not retention for it.
      const deleting = [
        ...sweeps().map((job) => [job.name, job.command] as const),
        ["sweep_terminal_workflow_runs", terminalRunSweepBody()] as const,
      ]
        .filter(([, body]) => body.includes(`delete from aai_platform.${table}`))
        .map(([name]) => name);
      // The reap really does delete an `agents` row, and it is still not
      // retention for the table: its predicate is a `%-preview` suffix, so it
      // can never reach an agent an author deployed.
      const expected = table === "agents" ? ["aai-sweep-orphan-previews"] : [];
      expect(deleting).toEqual(expected);
    });

    test("what DOES delete it is real", () => {
      if ("cascadeFrom" in verdict.evidence) {
        // A cascade is the schema's own promise, so it is checked against the
        // schema rather than against a source file.
        // `\s*` between the clauses: the workspace foreign keys are written
        // across three lines, so a single-line pattern here would report every
        // one of them as missing.
        expect(migrationSql()).toMatch(
          new RegExp(
            `references\\s+aai_platform\\.${verdict.evidence.cascadeFrom}\\s*\\([^)]*\\)\\s*on delete cascade`,
          ),
        );
        return;
      }
      // Reading the source, for the reason `pg-cron-delete-parity.test.ts` does:
      // the delete is a call on a collaborator, so nothing behavioural can see
      // that the path was removed — only that some other path still works.
      const source = readFileSync(path.join(import.meta.dirname, verdict.evidence.source), "utf-8");
      expect(source).toContain(verdict.evidence.literal);
    });
  },
);

/**
 * The tables the platform grows OUTSIDE its own schema, which a scan of
 * `aai_platform` structurally cannot see — and which is where a Supabase
 * project's largest table usually turns out to be.
 */
describe("the tables the sweeps themselves grow", () => {
  test("pg_cron's run log is pruned", () => {
    const body = sweepBody("aai-sweep-cron-history");
    expect(body).toContain("delete from cron.job_run_details");
    expect(body).toContain("interval '7 days'");
  });

  test("the preview queue's archive is pruned", () => {
    const body = sweepBody("aai-sweep-preview-archive");
    expect(body).toContain("delete from pgmq.a_aai_studio_preview");
    expect(body).toContain("interval '7 days'");
  });

  test("unreferenced blobs and upload bytes are collected", () => {
    // The row and the BYTES are two reclaims: `workflow_uploads` above is the
    // record, this is the object it pointed at.
    const body = sweepBody("aai-sweep-blob-gc");
    expect(body).toContain("like 'blobs/%'");
    expect(body).toContain("like 'uploads/%'");
  });

  test("every sweep this suite reasons about is really scheduled", () => {
    // A floor on the corpus, for the reason the table floor above exists: every
    // `sweepBody` lookup answers `""` for a job that does not exist, and `""`
    // contains nothing — so a renamed job would fail loudly here rather than
    // making some other assertion vacuous.
    const names = sweeps().map((j) => j.name);
    for (const job of [
      "aai-sweep-blob-gc",
      "aai-sweep-cron-history",
      "aai-sweep-preview-archive",
      "aai-sweep-orphan-previews",
    ]) {
      expect.soft(names, `${job} is not scheduled`).toContain(job);
    }
  });
});
