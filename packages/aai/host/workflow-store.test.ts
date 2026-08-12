// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import type { Db } from "../sdk/db.ts";
import { MIGRATIONS } from "./workflow-schema.ts";
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
  test("creates the ledger, then runs every migration once, recording each", async () => {
    // Two rows per migration — the statement and its record — after the ledger's
    // own create and the read of what is already applied.
    const q = recordingDb();
    await createPostgresWorkflowStore(q.db).init();

    expect(q.sql(0)).toContain("create table if not exists aai_workflow_migrations");
    expect(q.sql(1)).toContain("select id from aai_workflow_migrations");
    expect(q.sql(2)).toContain("create table if not exists aai_workflow_runs");
    expect(q.sql(3)).toContain("insert into aai_workflow_migrations");
    expect(q.params(3)).toEqual(["0001-runs"]);
    expect(q.count()).toBe(2 + MIGRATIONS.length * 2);
  });

  test("runs NOTHING a second time", async () => {
    // The whole point: `create … if not exists` on every boot is idempotent and
    // not free — Postgres raises a NOTICE per no-op, and the guest relays its log
    // to the platform. Nothing re-running is what removes them.
    const applied = MIGRATIONS.map((m) => ({ id: m.id }));
    const q = recordingDb([[], applied]);
    await createPostgresWorkflowStore(q.db).init();

    // The ledger create and the read, and not one statement more.
    expect(q.count()).toBe(2);
  });

  test("applies only the migrations a partially-migrated schema is missing", async () => {
    const q = recordingDb([[], [{ id: "0001-runs" }, { id: "0002-correlation-key" }]]);
    await createPostgresWorkflowStore(q.db).init();

    // Two known, six to go — each with its record.
    expect(q.count()).toBe(2 + (MIGRATIONS.length - 2) * 2);
    expect(q.sql(2)).toContain("create table if not exists aai_workflow_steps");
  });

  test("every migration statement is idempotent, for schemas that predate the ledger", () => {
    // Apps deployed before the ledger have the tables and no record of them, so
    // `0001` and `0002` WILL run against a populated schema exactly once. A
    // statement that errored there would fail every such app's first boot.
    for (const migration of MIGRATIONS) {
      expect(migration.sql, migration.id).toMatch(/if not exists/);
    }
  });

  test("the steps table's foreign key cannot precede its target", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    const runs = ids.indexOf("0001-runs");
    const steps = ids.indexOf("0003-steps");
    expect(runs).toBeLessThan(steps);
    // And the correlation-key index needs the column the earlier migration adds.
    expect(ids.indexOf("0002-correlation-key")).toBeLessThan(ids.indexOf("0006-key-index"));
  });

  test("indexes correlation keys partially, so unkeyed runs cost nothing", () => {
    // Most runs carry no key — they are started by a page holding its own runId —
    // and indexing those nulls would tax every insert for a lookup that cannot
    // match them. Its keyless neighbour must NOT be partial: `recent` answers for
    // exactly the rows that predicate excludes.
    const byId = new Map(MIGRATIONS.map((m) => [m.id, m.sql]));
    expect(byId.get("0006-key-index")).toContain("where correlation_key is not null");
    expect(byId.get("0005-workflow-index")).not.toContain("where correlation_key");
  });
});

describe("create", () => {
  test("inserts the input as jsonb", async () => {
    const q = recordingDb();
    await createPostgresWorkflowStore(q.db).create("r1", "digest", { topic: "ai" });

    expect(q.sql(0)).toContain("insert into aai_workflow_runs");
    // `::text::jsonb`, never `::jsonb` — see the jsonb-encoding block on
    // `createPostgresWorkflowStore` and the sweep at the bottom of this file.
    expect(q.sql(0)).toContain("$3::text::jsonb");
    // The absent correlation key binds SQL null, not `undefined`: the driver would
    // send the latter as the string "undefined", which is a key nothing can match
    // and which is indistinguishable from a real one in the index.
    // The absent owner scope binds SQL null for the same reason, and that null is
    // load-bearing: a scoped read deliberately does not match it, so a run created
    // before an app declared `identify` belongs to nobody rather than to whichever
    // user asks first.
    expect(q.params(0)).toEqual(["r1", "digest", '{"topic":"ai"}', null, 0, null]);
  });

  test("stores a correlation key when one is given", async () => {
    const q = recordingDb();
    await createPostgresWorkflowStore(q.db).create("r1", "digest", null, "session-7");

    expect(q.sql(0)).toContain("correlation_key");
    expect(q.params(0)).toEqual(["r1", "digest", "null", "session-7", 0, null]);
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
    expect(q.sql(0)).toContain("$3::text::jsonb");
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
    expect(q.sql(0)).toContain("output = $2::text::jsonb");
    expect(q.params(0)).toEqual(["r1", '{"ok":1}']);
  });

  test("fail stores the message as text", async () => {
    const q = recordingDb();
    await createPostgresWorkflowStore(q.db).fail("r1", "boom");

    expect(q.sql(0)).toContain("status = 'failed'");
    expect(q.params(0)).toEqual(["r1", "boom"]);
  });
});

describe("the live guard", () => {
  // Every settling write carries `status in ('pending','sleeping','running')`, and
  // it is what makes a cancel stick: a run cancelled while another replica was
  // executing it must not be resurrected when that replica's `complete` lands.
  test.each([
    ["suspend", (s: ReturnType<typeof createPostgresWorkflowStore>) => s.suspend("r1", 1)],
    ["complete", (s: ReturnType<typeof createPostgresWorkflowStore>) => s.complete("r1", null)],
    ["fail", (s: ReturnType<typeof createPostgresWorkflowStore>) => s.fail("r1", "boom")],
    ["cancel", (s: ReturnType<typeof createPostgresWorkflowStore>) => s.cancel("r1")],
  ])("%s only writes a run that is still live", async (_name, call) => {
    const q = recordingDb();
    await call(createPostgresWorkflowStore(q.db));

    expect(q.sql(0)).toContain("status in ('pending', 'sleeping', 'running')");
  });
});

describe("cancel", () => {
  test("marks the run cancelled, clearing its lease and wake time", async () => {
    const q = recordingDb([[{ run_id: "r1" }]]);
    const cancelled = await createPostgresWorkflowStore(q.db).cancel("r1");

    expect(cancelled).toBe(true);
    expect(q.sql(0)).toContain("set status = 'cancelled'");
    // Both cleared, or the due sweep would keep offering a terminal run.
    expect(q.sql(0)).toContain("lease_until = null");
    expect(q.sql(0)).toContain("wake_at = null");
  });

  test("resolves false when no live run matched", async () => {
    // An already-terminal run, or one that never existed — the statement's own
    // `returning` is what distinguishes them, and neither is an error.
    const q = recordingDb([[]]);
    await expect(createPostgresWorkflowStore(q.db).cancel("r1")).resolves.toBe(false);
  });
});

describe("continuationDepth", () => {
  test("create carries the depth, and defaults it to 0", async () => {
    const q = recordingDb();
    const store = createPostgresWorkflowStore(q.db);
    await store.create("r1", "w", null);
    await store.create("r2", "w", null, "k", 7);

    expect(q.params(0)?.[4]).toBe(0);
    expect(q.params(1)?.[4]).toBe(7);
    expect(q.sql(0)).toContain("continuation_depth");
  });

  test("reads it back, answering 0 for a run that does not exist", async () => {
    const q = recordingDb([[{ continuation_depth: 3 }], []]);
    const store = createPostgresWorkflowStore(q.db);
    await expect(store.continuationDepth("r1")).resolves.toBe(3);
    await expect(store.continuationDepth("gone")).resolves.toBe(0);
  });
});

describe("retry", () => {
  test("revives only a terminal run, and KEEPS the journal", async () => {
    const q = recordingDb([[{ run_id: "r1" }]]);
    await expect(createPostgresWorkflowStore(q.db).retry("r1")).resolves.toBe(true);

    // Terminal only: resetting a LIVE run would give it two claimants, which is
    // the one thing the lease exists to prevent.
    expect(q.sql(0)).toContain("status in ('failed', 'cancelled')");
    // A resume, not a restart — nothing touches aai_workflow_steps, so replay
    // short-circuits every step that already succeeded.
    expect(q.sql(0)).not.toContain("aai_workflow_steps");
    // And the failure text goes, or the revived run would still read as failed.
    expect(q.sql(0)).toContain("error = null");
    expect(q.sql(0)).toContain("lease_until = null");
    expect(q.params(0)).toEqual(["r1"]);
  });

  test("answers false for a run it could not revive", async () => {
    const q = recordingDb([[]]);
    await expect(createPostgresWorkflowStore(q.db).retry("live")).resolves.toBe(false);
  });
});

describe("recent", () => {
  test("filters by workflow ALONE, newest first, bounded by the limit", async () => {
    const q = recordingDb([[]]);
    await createPostgresWorkflowStore(q.db).recent("digest", 5);

    // No `correlation_key` predicate at all — this read exists for runs that
    // carry no key, which is most of them. A `correlation_key = null` would match
    // none of the keyed ones and read as "no runs" on a busy voice agent.
    expect(q.sql(0)).toContain("where workflow = $1");
    expect(q.sql(0)).not.toContain("correlation_key =");
    expect(q.sql(0)).toContain("order by created_at desc");
    expect(q.sql(0)).toContain("limit $2");
    expect(q.params(0)).toEqual(["digest", 5]);
  });

  test("maps rows through the same snapshot shape, key or no key", async () => {
    const q = recordingDb([
      [
        {
          run_id: "r9",
          workflow: "digest",
          status: "running",
          output: null,
          error: null,
          correlation_key: null,
          wake_at_ms: null,
          steps_completed: 3,
        },
      ],
    ]);
    const runs = await createPostgresWorkflowStore(q.db).recent("digest", 5);

    // `key` is ABSENT rather than null — the snapshot only carries it when the
    // run has one, which is what a console renders as "no key".
    expect(runs).toEqual([
      { runId: "r9", workflow: "digest", status: "running", stepsCompleted: 3 },
    ]);
  });
});

describe("findByKey", () => {
  test("filters by workflow and key, newest first, bounded by the limit", async () => {
    const q = recordingDb([[]]);
    await createPostgresWorkflowStore(q.db).findByKey("digest", "session-7", 5);

    expect(q.sql(0)).toContain("where workflow = $1 and correlation_key = $2");
    // Newest first: "is my thing ready?" is about the most recent run.
    expect(q.sql(0)).toContain("order by created_at desc");
    expect(q.sql(0)).toContain("limit $3");
    expect(q.params(0)).toEqual(["digest", "session-7", 5]);
  });

  test("maps every row through the same snapshot shape `get` uses", async () => {
    const q = recordingDb([
      [
        {
          run_id: "r2",
          workflow: "digest",
          status: "completed",
          output: { ok: 2 },
          error: null,
          correlation_key: "session-7",
          wake_at_ms: null,
          steps_completed: 4,
        },
      ],
    ]);
    const runs = await createPostgresWorkflowStore(q.db).findByKey("digest", "session-7", 5);

    expect(runs).toEqual([
      {
        runId: "r2",
        workflow: "digest",
        status: "completed",
        output: { ok: 2 },
        key: "session-7",
        stepsCompleted: 4,
      },
    ]);
  });
});

describe("get", () => {
  const row = {
    run_id: "r1",
    workflow: "digest",
    status: "completed",
    output: { ok: 1 },
    error: null,
    correlation_key: null,
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

/**
 * The one rule that holds for every write in this module, asserted over all of
 * them rather than per statement — a fourth jsonb column added with a plain
 * `::jsonb` cast is the bug this file exists to catch, and three spot checks
 * would not see it.
 *
 * Why the text step matters is argued on `createPostgresWorkflowStore`: bound
 * straight to `$n::jsonb`, the driver JSON-encodes the string this module
 * already stringified, so everything in the journal comes back double-encoded.
 * The engine's own suite runs on the in-memory store and cannot reach it.
 */
describe("every jsonb parameter is bound through ::text", () => {
  test("no write binds a parameter directly to ::jsonb", async () => {
    const q = recordingDb([[], [{ steps_completed: 1 }]]);
    const store = createPostgresWorkflowStore(q.db);

    // Every method that writes a jsonb column.
    await store.create("r1", "digest", { topic: "ai" });
    await store.recordStep("r1", "s:a#0", "out");
    await store.complete("r1", { ok: 1 });

    const offenders: string[] = [];
    for (let i = 0; i < q.count(); i++) {
      const sql = q.sql(i);
      // `$3::jsonb` with no `::text` in front of it. A cast that is not on a
      // parameter (`count(*)::int`) is not what this looks for.
      if (/\$\d+::jsonb/.test(sql)) offenders.push(sql);
    }
    expect(offenders).toEqual([]);
  });

  test("a stringified value is what gets bound, for every JSON type", async () => {
    // The pairing the cast exists to make correct: this module encodes ONCE,
    // and the text cast is what stops the driver encoding a second time.
    const cases: [unknown, string][] = [
      [{ a: 1 }, '{"a":1}'],
      ["text", '"text"'],
      [42, "42"],
      [true, "true"],
      [[1, 2], "[1,2]"],
      [null, "null"],
      [undefined, "null"],
    ];
    for (const [value, encoded] of cases) {
      const q = recordingDb([[], [{ steps_completed: 1 }]]);
      await createPostgresWorkflowStore(q.db).recordStep("r1", "s:a#0", value);
      expect(q.params(0)[2], `step output ${JSON.stringify(value)}`).toBe(encoded);
      expect(q.sql(0)).toContain("$3::text::jsonb");
    }
  });
});

describe("base64ByteLength", () => {
  test("accounts for padding, which `length * 3 / 4` does not", async () => {
    const { base64ByteLength } = await import("./workflow-blob-store.ts");
    // `length * 3 / 4` is the UNPADDED length, so every payload whose byte count
    // is not a multiple of 3 was overstated by one or two — the figure `putBlob`
    // stores and the upload response reports, against the real bytes
    // `ctx.blob(id)` hands the run. A 3-byte-aligned fixture cannot see it.
    for (const bytes of [0, 1, 2, 3, 4, 5, 6, 7, 100, 1024, 1_048_576]) {
      const base64 = Buffer.from(new Uint8Array(bytes)).toString("base64");
      expect(base64ByteLength(base64), `${bytes} bytes`).toBe(bytes);
    }
  });

  test("tolerates trailing whitespace, which a wire payload can carry", async () => {
    const { base64ByteLength } = await import("./workflow-blob-store.ts");
    expect(base64ByteLength(`${Buffer.from("hello").toString("base64")}\n`)).toBe(5);
    expect(base64ByteLength("   ")).toBe(0);
  });
});
