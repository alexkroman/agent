// Copyright 2026 the AAI authors. MIT license.
/**
 * What a RECORDER can see about the reconcile pass.
 *
 * `workflow-queue-reconcile.scenario.test.ts` owns the PREDICATE — four
 * correlated subqueries across the queue and two journal tables, against a grace
 * window compared in SQL — and nothing here can stand in for it.
 *
 * What this tier is for is the pass's DECISION, which is a branch over a number
 * the predicate returned and needs no database at all: repair the run, or stop
 * repairing it. That branch was missing entirely — nothing on the platform side
 * ever wrote a terminal status, so a run whose guest could never finish it was
 * re-enqueued every `STALL_GRACE_MS` forever, at a sandbox boot each. The scenario
 * tier would have to wait out real windows to see any of it.
 */

import { describe, expect, test } from "vitest";
import { ABANDONED_RUN_ERROR, RECONCILE_MAX_ATTEMPTS } from "./_reconcile-abandon.ts";
import type { SqlExec } from "./secret-store.ts";
import { captureLogs } from "./test-utils.ts";
import { findStalledRuns, reconcileStalledRuns } from "./workflow-queue-reconcile.ts";

/** One statement the pass issued. */
type Issued = { sql: string; params: unknown[] };

/**
 * A recording `SqlExec` that answers by STATEMENT SHAPE rather than from a queue.
 *
 * A pass issues a different number of statements per run depending on which arm
 * it takes — that is the thing under test — so a positional queue would encode
 * the answer into the fixture. Three shapes matter and everything else answers
 * empty, which is what `enqueue` and `pg_notify` both expect.
 */
function recorder(stalled: { slug: string; runId: string; reconciles: number }[]) {
  const issued: Issued[] = [];
  const sql: SqlExec = async (query, params = []) => {
    issued.push({ sql: query, params });
    if (query.includes("select r.slug, r.run_id, r.reconciles")) {
      return stalled.map((run) => ({
        slug: run.slug,
        run_id: run.runId,
        reconciles: run.reconciles,
      }));
    }
    // The journal's `setStatus`: a row means the compare-and-set moved the run.
    if (query.includes("with moved as")) return [{ run_id: "moved" }];
    // `enqueue`'s insert reports the row it wrote.
    if (query.includes("insert into aai_platform.workflow_queue")) return [{ id: "queued" }];
    return [];
  };
  const of = (needle: string) => issued.filter((statement) => statement.sql.includes(needle));
  return { sql, issued, of };
}

/**
 * Abandonment is a `warn`, which is the one line here an operator is meant to act
 * on — so it is captured rather than left to stderr, and asserted once below.
 */
const logs = captureLogs();

const UNDER = { slug: "tenant-a", runId: "wrun_young", reconciles: RECONCILE_MAX_ATTEMPTS - 1 };
const OVER = { slug: "tenant-a", runId: "wrun_wedged", reconciles: RECONCILE_MAX_ATTEMPTS };

describe("the predicate carries the strike count", () => {
  test("findStalledRuns selects `reconciles`, which is what the budget is read from", async () => {
    // Without it the pass has no way to tell a first repair from a fiftieth: the
    // stamp overwrites `reconciled_at` every time, so the row cannot say how many
    // there have been.
    const { sql, issued } = recorder([UNDER]);
    expect(await findStalledRuns(sql)).toEqual([UNDER]);
    expect(issued[0]?.sql).toContain("r.reconciles");
  });

  test("the status filter is still the partial index's literal list", async () => {
    // `workflow_runs_stalled_idx` is partial on `status in ('pending', 'running')`
    // and a partial index is matched by IMPLICATION, so binding the list as a
    // parameter would silently stop using the index that serves the filter, the
    // ordering and the bound in one walk.
    const { sql, issued } = recorder([]);
    await findStalledRuns(sql);
    expect(issued[0]?.sql).toContain("r.status in ('pending', 'running')");
  });
});

describe("a run under the budget is REPAIRED", () => {
  test("it gets a message, and the stamp counts the attempt", async () => {
    const { sql, of } = recorder([UNDER]);
    const pass = await reconcileStalledRuns(sql);
    expect(pass).toEqual({ stalled: 1, skipped: 0, abandoned: 0 });
    expect(of("insert into aai_platform.workflow_queue")).toHaveLength(1);
    expect(of("reconciles = r.reconciles + 1")).toHaveLength(1);
  });

  test("nothing writes a status, so a repair cannot fail a run by accident", async () => {
    const { sql, of } = recorder([UNDER]);
    await reconcileStalledRuns(sql);
    expect(of("with moved as")).toEqual([]);
  });
});

describe("a run OUT of budget is abandoned", () => {
  test("it is failed rather than given a sixth message", async () => {
    // The whole point: nothing else on the platform writes a terminal status, so
    // this is the only thing that ends a run the queue keeps losing.
    const { sql, of } = recorder([OVER]);
    const pass = await reconcileStalledRuns(sql);
    expect(pass).toEqual({ stalled: 0, skipped: 0, abandoned: 1 });
    expect(of("insert into aai_platform.workflow_queue")).toEqual([]);
    const [moved] = of("with moved as");
    expect(moved?.params).toContain("failed");
  });

  test("the failure carries a reason the author can read", async () => {
    const { sql, of } = recorder([OVER]);
    await reconcileStalledRuns(sql);
    expect(of("with moved as")[0]?.params).toContain(ABANDONED_RUN_ERROR);
  });

  test("and it is ANNOUNCED, because the platform has stopped trying", async () => {
    // Every other line in this module is `debug`. This one is the end of a run.
    const { sql } = recorder([OVER]);
    await reconcileStalledRuns(sql);
    expect(logs.warns().join("\n")).toContain("gave up re-walking");
  });

  test("it is a COMPARE-AND-SET on the live statuses, not a bare update", async () => {
    // The predicate and this write are two autocommit statements, so a guest can
    // complete the run in between — and `failed` written over `completed` destroys
    // an author's real output on the strength of a stale read.
    const { sql, of } = recorder([OVER]);
    await reconcileStalledRuns(sql);
    expect(of("with moved as")[0]?.params).toContainEqual(["pending", "running"]);
  });

  test("an abandoned run is NOT stamped, there being no throttle left to buy", async () => {
    // It is terminal now, so the predicate cannot select it again.
    const { sql, of } = recorder([OVER]);
    await reconcileStalledRuns(sql);
    expect(of("reconciles = r.reconciles + 1")).toEqual([]);
  });

  test("a run that settled on its own is not reported as abandoned", async () => {
    // The compare-and-set matched nothing, which is the ordinary outcome of a
    // guest finishing the run between the predicate and the write.
    const { issued, of } = recorder([OVER]);
    const sql: SqlExec = async (query, params = []) => {
      issued.push({ sql: query, params });
      if (query.includes("select r.slug, r.run_id, r.reconciles")) {
        return [{ slug: OVER.slug, run_id: OVER.runId, reconciles: OVER.reconciles }];
      }
      return [];
    };
    expect(await reconcileStalledRuns(sql)).toEqual({ stalled: 0, skipped: 0, abandoned: 0 });
    expect(of("with moved as")).toHaveLength(1);
  });
});

describe("one run's outcome costs the others nothing", () => {
  test("a repair and an abandonment in one pass are both carried out", async () => {
    const { sql, of } = recorder([UNDER, OVER]);
    expect(await reconcileStalledRuns(sql)).toEqual({ stalled: 1, skipped: 0, abandoned: 1 });
    expect(of("insert into aai_platform.workflow_queue")).toHaveLength(1);
    expect(of("with moved as")).toHaveLength(1);
  });

  test("an abandonment that THROWS leaves the rest of the pass alone", async () => {
    // Abandonment is the last thing this pass does for a run, and the pass is a
    // repair across tenants: a failure it cannot write must not cost another
    // tenant its repair.
    const seen: string[] = [];
    const sql: SqlExec = async (query) => {
      seen.push(query);
      if (query.includes("select r.slug, r.run_id, r.reconciles")) {
        return [
          { slug: OVER.slug, run_id: OVER.runId, reconciles: OVER.reconciles },
          { slug: UNDER.slug, run_id: UNDER.runId, reconciles: UNDER.reconciles },
        ];
      }
      if (query.includes("with moved as")) throw new Error("connection reset");
      if (query.includes("insert into aai_platform.workflow_queue")) return [{ id: "queued" }];
      return [];
    };
    expect(await reconcileStalledRuns(sql)).toEqual({ stalled: 1, skipped: 0, abandoned: 0 });
    expect(
      seen.filter((query) => query.includes("insert into aai_platform.workflow_queue")),
    ).toHaveLength(1);
  });
});
