// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import type { Db } from "../sdk/db.ts";
import { createPostgresWorkflowStore } from "./workflow-store.ts";

type Call = { sql: string; params: unknown[] };

/**
 * A `Db` that records every statement and replays queued result sets.
 *
 * The SQL is what this module IS, so the assertions are about the statements
 * and their parameters — the shapes a real Postgres would reject (a missing
 * `::jsonb` cast, an interval built from milliseconds) rather than a
 * re-implementation of Postgres semantics, which the engine specs cover
 * against the in-memory store instead.
 *
 * Reads go through `sql(i)` / `params(i)` rather than indexing `calls`: they
 * fail by NAME when a statement is missing, where an index would need a
 * non-null assertion (banned here) or fail as a `TypeError` one line later.
 * `sql()` also collapses whitespace, so an assertion names a clause without
 * matching the statement's layout.
 */
function recordingDb(results: unknown[][] = []): {
  db: Db;
  count(): number;
  sql(index: number): string;
  params(index: number): unknown[];
} {
  const calls: Call[] = [];
  const queued = [...results];
  const at = (index: number): Call => {
    const call = calls[index];
    if (!call) throw new Error(`no statement at index ${index}; ${calls.length} were run`);
    return call;
  };
  return {
    db: {
      query: <T>(sql: string, params?: unknown[]): Promise<T[]> => {
        calls.push({ sql, params: params ?? [] });
        return Promise.resolve((queued.shift() ?? []) as T[]);
      },
    },
    count: () => calls.length,
    sql: (index) => at(index).sql.replace(/\s+/g, " ").trim(),
    params: (index) => at(index).params,
  };
}

describe("init", () => {
  test("creates every table and index, runs before steps", async () => {
    const q = recordingDb();
    await createPostgresWorkflowStore(q.db).init();

    expect(q.count()).toBe(5);
    expect(q.sql(0)).toContain("create table if not exists aai_workflow_runs");
    expect(q.sql(1)).toContain("create table if not exists aai_workflow_steps");
    expect(q.sql(2)).toContain("create index if not exists aai_workflow_runs_due");
    // The steps table's foreign key cannot be created before its target.
    expect(q.sql(1)).toContain("references aai_workflow_runs(run_id)");
    // Blobs are NOT a child of the runs table: one is written before the run
    // that names it exists, so a foreign key would reject every upload.
    expect(q.sql(3)).toContain("create table if not exists aai_workflow_blobs");
    expect(q.sql(3)).not.toContain("references");
    expect(q.sql(4)).toContain("create index if not exists aai_workflow_blobs_created");
  });
});

describe("create", () => {
  test("inserts the input as jsonb", async () => {
    const q = recordingDb();
    await createPostgresWorkflowStore(q.db).create("r1", "digest", { topic: "ai" });

    expect(q.sql(0)).toContain("insert into aai_workflow_runs");
    expect(q.sql(0)).toContain("$3::jsonb");
    expect(q.params(0)).toEqual(["r1", "digest", '{"topic":"ai"}']);
  });

  test("serializes an absent input as SQL-safe null, never the string undefined", async () => {
    const q = recordingDb();
    await createPostgresWorkflowStore(q.db).create("r1", "digest", undefined);
    expect(q.params(0)[2]).toBe("null");
  });
});

describe("claim", () => {
  test("passes the lease in SECONDS and returns the claimed run", async () => {
    const q = recordingDb([[{ workflow: "digest", input: { topic: "ai" } }]]);
    const claimed = await createPostgresWorkflowStore(q.db).claim("r1", 120_000);

    expect(claimed).toEqual({ runId: "r1", workflow: "digest", input: { topic: "ai" } });
    // make_interval takes seconds; passing milliseconds would lease for 33 hours.
    expect(q.params(0)).toEqual(["r1", 120]);
    expect(q.sql(0)).toContain("make_interval(secs => $2::float8)");
  });

  test("only claims a due run whose lease is not live", async () => {
    const q = recordingDb([[]]);
    const claimed = await createPostgresWorkflowStore(q.db).claim("r1", 1000);

    expect(claimed).toBeUndefined();
    const text = q.sql(0);
    expect(text).toContain("status in ('pending', 'sleeping', 'running')");
    expect(text).toContain("(wake_at is null or wake_at <= now())");
    expect(text).toContain("(status <> 'running' or lease_until is null or lease_until < now())");
  });
});

describe("due", () => {
  test("selects waiting and abandoned runs, oldest first, bounded by the limit", async () => {
    const q = recordingDb([[{ run_id: "a" }, { run_id: "b" }]]);
    const ids = await createPostgresWorkflowStore(q.db).due(20);

    expect(ids).toEqual(["a", "b"]);
    const text = q.sql(0);
    expect(text).toContain("status in ('pending', 'sleeping')");
    expect(text).toContain(
      "status = 'running' and lease_until is not null and lease_until < now()",
    );
    expect(text).toContain("order by created_at");
    expect(q.params(0)).toEqual([20]);
  });
});

describe("completedSteps", () => {
  test("maps step ids to outputs in journal order", async () => {
    const q = recordingDb([
      [
        { step_id: "s:a#0", output: 1 },
        { step_id: "s:b#0", output: { ok: true } },
      ],
    ]);
    const steps = await createPostgresWorkflowStore(q.db).completedSteps("r1");

    expect([...steps]).toEqual([
      ["s:a#0", 1],
      ["s:b#0", { ok: true }],
    ]);
    // Ordering is what makes the map's iteration order meaningful.
    expect(q.sql(0)).toContain("order by seq");
  });
});

describe("recordStep", () => {
  test("upserts the step then resolves the run's recounted total", async () => {
    const q = recordingDb([[], [{ steps_completed: 4 }]]);
    const count = await createPostgresWorkflowStore(q.db).recordStep("r1", "s:a#0", "out");

    expect(count).toBe(4);
    expect(q.sql(0)).toContain("on conflict (run_id, step_id) do update");
    expect(q.params(0)).toEqual(["r1", "s:a#0", '"out"']);
    // Recounted from the steps table rather than incremented, so a retried
    // upsert cannot inflate the total.
    expect(q.sql(1)).toContain("count(*)::int from aai_workflow_steps");
  });

  test("resolves 0 when the run row is gone", async () => {
    const q = recordingDb([[], []]);
    await expect(createPostgresWorkflowStore(q.db).recordStep("r1", "s:a#0", null)).resolves.toBe(
      0,
    );
  });
});

describe("terminal transitions", () => {
  test("suspend converts epoch ms to a timestamp and clears the lease", async () => {
    const q = recordingDb();
    await createPostgresWorkflowStore(q.db).suspend("r1", 1_700_000_000_000);

    const text = q.sql(0);
    expect(text).toContain("status = 'sleeping'");
    expect(text).toContain("to_timestamp($2::float8 / 1000.0)");
    expect(text).toContain("lease_until = null");
    expect(q.params(0)).toEqual(["r1", 1_700_000_000_000]);
  });

  test("complete stores the output as jsonb and clears the wake time", async () => {
    const q = recordingDb();
    await createPostgresWorkflowStore(q.db).complete("r1", { ok: 1 });

    expect(q.sql(0)).toContain("status = 'completed'");
    expect(q.sql(0)).toContain("wake_at = null");
    expect(q.params(0)).toEqual(["r1", '{"ok":1}']);
  });

  test("fail stores the message as text", async () => {
    const q = recordingDb();
    await createPostgresWorkflowStore(q.db).fail("r1", "boom");

    expect(q.sql(0)).toContain("status = 'failed'");
    expect(q.params(0)).toEqual(["r1", "boom"]);
  });
});

describe("get", () => {
  const row = {
    workflow: "digest",
    status: "completed",
    output: { ok: 1 },
    error: null,
    wake_at_ms: null,
    steps_completed: 3,
  };

  test("reads wake_at back as epoch ms", async () => {
    const q = recordingDb([
      [{ ...row, status: "sleeping", output: null, wake_at_ms: 1_700_000_000_000 }],
    ]);
    const snapshot = await createPostgresWorkflowStore(q.db).get("r1");

    expect(snapshot).toEqual({
      runId: "r1",
      workflow: "digest",
      status: "sleeping",
      stepsCompleted: 3,
      wakeAt: 1_700_000_000_000,
    });
    // numeric would arrive as a string; the cast is what keeps it a number.
    expect(q.sql(0)).toContain("(extract(epoch from wake_at) * 1000)::float8");
  });

  test("resolves undefined for an unknown run", async () => {
    const q = recordingDb([[]]);
    await expect(createPostgresWorkflowStore(q.db).get("nope")).resolves.toBeUndefined();
  });

  test.each([
    ["completed", { output: { ok: 1 } }],
    ["failed", { error: "boom" }],
  ])("reports the field that %s defines, and only that one", async (status, expected) => {
    const q = recordingDb([[{ ...row, status, error: "boom" }]]);
    const snapshot = await createPostgresWorkflowStore(q.db).get("r1");

    expect(snapshot).toEqual({
      runId: "r1",
      workflow: "digest",
      status,
      stepsCompleted: 3,
      ...expected,
    });
  });

  test("omits output on a run that is still running", async () => {
    const q = recordingDb([[{ ...row, status: "running" }]]);
    const snapshot = await createPostgresWorkflowStore(q.db).get("r1");

    expect(snapshot).not.toHaveProperty("output");
    expect(snapshot?.status).toBe("running");
  });
});
