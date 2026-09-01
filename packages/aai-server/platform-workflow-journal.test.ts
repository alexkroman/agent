// Copyright 2026 the AAI authors. MIT license.
/**
 * What a RECORDER can see about the platform journal — and here that is more than
 * usual, because the central claim of this module is about the SHAPE of every
 * statement rather than about what the database does with it.
 *
 * `platform-workflow-journal.scenario.test.ts` drives all of this against a real
 * Postgres and is where the behaviour lives: whether `claimAttempt` really
 * increments atomically, whether a neighbour's read really comes back empty. None
 * of that is representable here — a recorder answers whatever it is told.
 *
 * Three things ARE worth pinning in the fast tier, and each was wrong at least
 * once in the self-hosted twin:
 *
 * - **Every statement carries the SLUG, as `$1`.** That is the whole tenancy
 *   design: the slug is part of every primary key and comes from the bearer, so a
 *   statement that dropped it would read across tenants. Only the scenario tier
 *   can prove the read comes back empty, but a recorder can prove the parameter
 *   is there — cheaply, over every method, which is what makes a dropped one
 *   impossible to add quietly.
 * - **Every jsonb binding is `::text::jsonb`.** postgres.js JSON-serializes a
 *   parameter bound to a jsonb position, so the codec's already-encoded text was
 *   stored as a JSON string containing the JSON. It shipped in the twin and only
 *   a real server found it.
 * - **`claimAttempt` is ONE statement**, which is the atomicity claim. A second
 *   query here would disprove it without any database at all.
 */

import { describe, expect, test } from "vitest";
import * as journal from "./platform-workflow-journal.ts";
import type { SqlExec } from "./secret-store.ts";

const SLUG = "tenant-a";

/** One statement the store issued. */
type Issued = { sql: string; params: unknown[] };

/**
 * A recording `SqlExec` that answers from a queue.
 *
 * `rows` is consumed in order, so a method that writes and then reads back —
 * `appendStep`, `claimSleep` and `claimHook` all have that shape — gets its read
 * answered by the next entry.
 */
function recorder(rows: Record<string, unknown>[][] = []) {
  const issued: Issued[] = [];
  const queue = [...rows];
  const sql: SqlExec = async (query, params = []) => {
    issued.push({ sql: query, params });
    return queue.shift() ?? [];
  };
  return { sql, issued };
}

/** A step entry with every field filled, for the methods that take one. */
const ENTRY: journal.JournalStepRow = {
  key: "fetch#0",
  name: "fetch",
  status: "ok",
  output: `"value"`,
  error: undefined,
  attempts: 1,
  finishedAt: 7,
};

/** A row shaped like each read-back, so no method throws its "vanished" error. */
const STEP_ROW = {
  key: "fetch#0",
  name: "fetch",
  status: "ok",
  output: `"value"`,
  error: null,
  attempts: 1,
  finished_at: 7,
};
const SLEEP_ROW = { wake_at: 1000, woken: false, correlation_id: null, kind: "sleep" };
const HOOK_ROW = { token: "tok", delivered: false, payload: null, closed: false };

/**
 * Every method, driven once, with whatever read-back rows it needs.
 *
 * A table rather than a test each, because the two properties below are
 * INVARIANTS over the whole surface — the interesting failure is one method
 * forgetting, and a hand-written case per method is exactly what a thirteenth
 * method would not get.
 */
const CALLS: readonly {
  name: string;
  rows: Record<string, unknown>[][];
  run: (sql: SqlExec) => Promise<unknown>;
}[] = [
  {
    name: "createRun",
    rows: [],
    run: (sql) =>
      journal.createRun(sql, SLUG, {
        runId: "wrun_1",
        workflow: "digest",
        status: "pending",
        createdAt: 1,
        input: `{"topic":"otters"}`,
      }),
  },
  { name: "getRun", rows: [[]], run: (sql) => journal.getRun(sql, SLUG, "wrun_1") },
  { name: "listRuns", rows: [[]], run: (sql) => journal.listRuns(sql, SLUG, "digest", 10) },
  {
    name: "setStatus",
    rows: [[{ run_id: "wrun_1" }]],
    run: (sql) =>
      journal.setStatus(sql, SLUG, "wrun_1", "completed", { output: `"done"` }, ["running"]),
  },
  { name: "readSteps", rows: [[]], run: (sql) => journal.readSteps(sql, SLUG, "wrun_1") },
  {
    name: "claimAttempt",
    rows: [[{ n: 1 }]],
    run: (sql) => journal.claimAttempt(sql, SLUG, "wrun_1", "a#0"),
  },
  {
    name: "claimSleep",
    rows: [[], [SLEEP_ROW]],
    run: (sql) => journal.claimSleep(sql, SLUG, "wrun_1", "sleep!0", 1000, undefined, "sleep"),
  },
  {
    name: "wakeSleeps",
    rows: [[]],
    run: (sql) => journal.wakeSleeps(sql, SLUG, "wrun_1", 5, undefined),
  },
  {
    name: "claimHook",
    rows: [[], [], [HOOK_ROW]],
    run: (sql) => journal.claimHook(sql, SLUG, "wrun_1", "hook!0", "tok"),
  },
  { name: "closeHook", rows: [[]], run: (sql) => journal.closeHook(sql, SLUG, "wrun_1", "hook!0") },
  {
    name: "deliverHook",
    rows: [[]],
    run: (sql) => journal.deliverHook(sql, SLUG, "tok", `{"ok":true}`),
  },
  {
    name: "appendStep",
    rows: [[], [STEP_ROW]],
    run: (sql) => journal.appendStep(sql, SLUG, "wrun_1", ENTRY),
  },
];

describe("tenancy is in every statement", () => {
  test.each(CALLS.map((call) => [call.name, call] as const))(
    "%s binds the slug as $1 on every statement it issues",
    async (_name, call) => {
      // The slug comes from the BEARER and is part of every primary key, so a
      // statement that dropped it would read or write across tenants. The
      // scenario tier proves the read comes back empty; this proves the parameter
      // is there, over every method, so a dropped one cannot arrive quietly.
      const { sql, issued } = recorder(call.rows);
      await call.run(sql);
      expect(issued.length).toBeGreaterThan(0);
      for (const statement of issued) {
        expect(statement.params[0], statement.sql).toBe(SLUG);
        expect(statement.sql).toContain("$1");
      }
    },
  );

  test("every statement names a table under the platform's own schema", async () => {
    // These are the platform's tables, not an app's. An unqualified name would
    // resolve through `search_path` to whatever the connection happens to have.
    for (const call of CALLS) {
      const { sql, issued } = recorder(call.rows);
      await call.run(sql);
      for (const statement of issued) {
        expect(statement.sql, call.name).toContain("aai_platform.workflow_");
      }
    }
  });
});

/** Every statement that binds a value into a `jsonb` column. */
const JSONB_BINDINGS = /\$\d+::(text::)?jsonb/g;

describe("every jsonb binding casts through text", () => {
  test("no statement anywhere binds a bare `$n::jsonb`", async () => {
    // A bare cast IS the double-encode: the driver JSON-serializes the parameter,
    // so the codec's text is stored as a JSON string containing the JSON, and a
    // run's `input` reads back as text.
    const casts: string[] = [];
    for (const call of CALLS) {
      const { sql, issued } = recorder(call.rows);
      await call.run(sql);
      for (const statement of issued) casts.push(...(statement.sql.match(JSONB_BINDINGS) ?? []));
    }
    // createRun, setStatus, deliverHook, appendStep — four writes carry an
    // encoded value, and a floor here is what stops this passing on an empty scan.
    expect(casts.length).toBeGreaterThanOrEqual(4);
    expect(casts.filter((cast) => !cast.includes("::text::jsonb"))).toEqual([]);
  });
});

describe("claimAttempt", () => {
  test("is ONE statement, which IS the atomicity claim", async () => {
    // Read-then-increment lets two concurrent deliveries read the same number,
    // after which a wedged step never reaches its ceiling. Whether the database
    // makes the single statement atomic is the scenario tier's question; whether
    // there is only one is this one's, and a second query would settle it here.
    const { sql, issued } = recorder([[{ n: 3 }]]);
    expect(await journal.claimAttempt(sql, SLUG, "wrun_1", "a#0")).toBe(3);
    expect(issued).toHaveLength(1);
    expect(issued[0]?.sql).toMatch(/on conflict .* do update set/s);
  });

  test("refuses an empty result rather than inventing an attempt number", async () => {
    const { sql } = recorder([[]]);
    await expect(journal.claimAttempt(sql, SLUG, "wrun_1", "a#0")).rejects.toThrow(
      /returned nothing/,
    );
  });
});

describe("setStatus", () => {
  test("passes its `expect` list, and answers from the ROW COUNT", async () => {
    const { sql, issued } = recorder([[{ run_id: "wrun_1" }]]);
    expect(await journal.setStatus(sql, SLUG, "wrun_1", "completed", undefined, ["running"])).toBe(
      true,
    );
    expect(issued[0]?.params).toContainEqual(["running"]);
  });

  test("answers false when the update matched no row", async () => {
    // A worker that had not noticed a cancel must not be told it moved the run.
    const { sql } = recorder([[]]);
    expect(await journal.setStatus(sql, SLUG, "wrun_1", "completed", undefined, ["running"])).toBe(
      false,
    );
  });

  test("passes null for an ABSENT expect, so the predicate matches any status", async () => {
    const { sql, issued } = recorder([[{ run_id: "wrun_1" }]]);
    await journal.setStatus(sql, SLUG, "wrun_1", "cancelled", undefined, undefined);
    expect(issued[0]?.params).toContain(null);
  });
});

describe("wakeSleeps", () => {
  test("a BARE wake is scoped to `kind = 'sleep'`, never a hook deadline", async () => {
    // Journaling a hook's timeout as an ordinary sleep meant a "send it now" tool
    // also closed every open approval window on the run.
    const { sql, issued } = recorder([[{ key: "sleep!0" }]]);
    expect(await journal.wakeSleeps(sql, SLUG, "wrun_1", 5, undefined)).toBe(1);
    expect(issued[0]?.sql).toContain("kind = 'sleep'");
  });

  test("a CORRELATED wake passes its ids and reaches any kind", async () => {
    const { sql, issued } = recorder([[]]);
    await journal.wakeSleeps(sql, SLUG, "wrun_1", 5, ["order-7"]);
    expect(issued[0]?.params).toContainEqual(["order-7"]);
  });
});

describe("claimHook", () => {
  test("refuses a token another run holds, naming the holder", async () => {
    // Two waits sharing a token means one signal resolves whichever row the
    // planner reached first and the other waits forever.
    const { sql } = recorder([[{ run_id: "wrun_other", key: "hook!0" }]]);
    await expect(journal.claimHook(sql, SLUG, "wrun_1", "hook!0", "tok")).rejects.toThrow(
      /already held by run wrun_other/,
    );
  });

  test("accepts a re-claim by the SAME run and key, which is what a replay does", async () => {
    const { sql } = recorder([[{ run_id: "wrun_1", key: "hook!0" }], [], [HOOK_ROW]]);
    await expect(journal.claimHook(sql, SLUG, "wrun_1", "hook!0", "tok")).resolves.toMatchObject({
      token: "tok",
      delivered: false,
    });
  });
});

describe("a bigint column arrives as a STRING", () => {
  test("getRun and readSteps convert it, so a timestamp is never compared as text", async () => {
    // Left alone every comparison against a deadline is lexicographic and every
    // arithmetic one is concatenation.
    const { sql } = recorder([
      [
        {
          run_id: "wrun_1",
          workflow: "digest",
          status: "completed",
          created_at: "1700000000000",
          input: `{"topic":"otters"}`,
          output: null,
          error: null,
        },
      ],
      [{ ...STEP_ROW, finished_at: "1700000000001" }],
    ]);
    expect((await journal.getRun(sql, SLUG, "wrun_1"))?.createdAt).toBe(1_700_000_000_000);
    const [step] = await journal.readSteps(sql, SLUG, "wrun_1");
    expect(step?.finishedAt).toBe(1_700_000_000_001);
  });

  test("a null column reads as absent rather than as the string 'null'", async () => {
    const { sql } = recorder([
      [
        {
          run_id: "wrun_1",
          workflow: "digest",
          status: "pending",
          created_at: 1,
          input: null,
          output: null,
          error: null,
        },
      ],
    ]);
    const run = await journal.getRun(sql, SLUG, "wrun_1");
    expect(run?.input).toBeUndefined();
    expect(run?.error).toBeUndefined();
  });
});
