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
 * `rows` is consumed in order. Every method here issues exactly ONE statement, so
 * one entry is the ordinary case; a second entry is what a RE-RUN reads, which is
 * how the first-write-wins retry is driven below.
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
  startedAt: undefined,
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
    // The row the insert reports — see `createRun`'s own describe block: an empty
    // result is the store's DUPLICATE refusal, not a successful write.
    name: "createRun",
    rows: [[{ run_id: "wrun_1" }]],
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
    name: "readStep",
    rows: [[]],
    run: (sql) => journal.readStep(sql, SLUG, "wrun_1", "a#0"),
  },
  {
    name: "claimAttempt",
    rows: [[{ n: 1 }]],
    run: (sql) => journal.claimAttempt(sql, SLUG, "wrun_1", "a#0", "walk-1", 60_000),
  },
  {
    name: "releaseAttempt",
    rows: [[]],
    run: (sql) => journal.releaseAttempt(sql, SLUG, "wrun_1", "a#0", "walk-1"),
  },
  {
    name: "readSleeps",
    rows: [[]],
    run: (sql) => journal.readSleeps(sql, SLUG, "wrun_1"),
  },
  {
    name: "claimSleep",
    rows: [[SLEEP_ROW]],
    run: (sql) => journal.claimSleep(sql, SLUG, "wrun_1", "sleep!0", 1000, undefined, "sleep"),
  },
  {
    name: "wakeSleeps",
    rows: [[]],
    run: (sql) => journal.wakeSleeps(sql, SLUG, "wrun_1", 5, undefined),
  },
  {
    name: "claimHook",
    rows: [[{ ...HOOK_ROW, run_id: "wrun_1", key: "hook!0" }]],
    run: (sql) => journal.claimHook(sql, SLUG, "wrun_1", "hook!0", "tok"),
  },
  {
    name: "closeHook",
    rows: [[{ closed: "1", existing: "1" }]],
    run: (sql) => journal.closeHook(sql, SLUG, "wrun_1", "hook!0"),
  },
  {
    name: "deliverHook",
    rows: [[]],
    run: (sql) => journal.deliverHook(sql, SLUG, "tok", `{"ok":true}`),
  },
  {
    name: "appendStep",
    rows: [[STEP_ROW]],
    run: (sql) => journal.appendStep(sql, SLUG, "wrun_1", ENTRY),
  },
];

describe("tenancy is in every statement", () => {
  test("the table names every journal method, so a fourteenth cannot arrive untested", () => {
    // A hand-written case per method is exactly what a NEW method does not get,
    // and this is not hypothetical: `readStep` was added and this table did not
    // notice, while the guide beside it argued that a thirteenth method would be
    // missed. So the roster is checked against the NAMESPACE rather than against
    // a count in a comment — the same reason every counting gate in this repo
    // carries a floor.
    const methods = Object.entries(journal)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      // The two typed refusals are classes on the same namespace, not methods.
      .filter((name) => !name.endsWith("Error"))
      .sort();
    expect(methods).toEqual(CALLS.map((call) => call.name).sort());
  });

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

describe("a first-write-wins claim is ONE statement", () => {
  // `claimSleep`, `appendStep` and `claimHook` each insert the row and, if
  // somebody already wrote it, adopt theirs. That was an insert and then a
  // separate select: two round trips on a route that holds one of
  // `ADMIN_POOL_MAX` reservations for the whole request, and `appendStep` fires
  // once per settled step. The scenario tier proves the answer is right; whether
  // there is only one statement is this tier's question.
  const CLAIMS = [
    {
      name: "claimSleep",
      row: SLEEP_ROW,
      run: (sql: SqlExec) => journal.claimSleep(sql, SLUG, "wrun_1", "sleep!0", 1000, "c", "sleep"),
    },
    {
      name: "appendStep",
      row: STEP_ROW,
      run: (sql: SqlExec) => journal.appendStep(sql, SLUG, "wrun_1", ENTRY),
    },
    {
      name: "claimHook",
      row: { ...HOOK_ROW, run_id: "wrun_1", key: "hook!0" },
      run: (sql: SqlExec) => journal.claimHook(sql, SLUG, "wrun_1", "hook!0", "tok"),
    },
  ] as const;

  test.each(CLAIMS.map((claim) => [claim.name, claim] as const))(
    "%s writes and reads in one statement",
    async (_name, claim) => {
      const { sql, issued } = recorder([[claim.row]]);
      await claim.run(sql);
      expect(issued).toHaveLength(1);
    },
  );

  test.each(CLAIMS.map((claim) => [claim.name, claim] as const))(
    "%s reads the row back through a `union all` off the insert's CTE",
    async (_name, claim) => {
      // The outer select reads the statement's snapshot, taken BEFORE the CTE's
      // insert, so exactly one arm can produce a row — which is the whole reason
      // the two halves are unioned rather than selected afterwards.
      const { sql, issued } = recorder([[claim.row]]);
      await claim.run(sql);
      expect(issued[0]?.sql).toContain("union all");
      expect(issued[0]?.sql).toMatch(/on conflict.*do nothing/s);
    },
  );

  test.each(CLAIMS.map((claim) => [claim.name, claim] as const))(
    "%s RE-RUNS the statement when both arms came back empty",
    async (_name, claim) => {
      // `on conflict do nothing` does not wait for a concurrent inserter —
      // Postgres declines — and the union's second arm reads the very snapshot
      // the insert conflicted against, so a rival's UNCOMMITTED row leaves both
      // arms empty. Answering that as a failure is a 503 telling the guest to
      // retry a race whose winner it could simply have read; for `claimHook` it
      // was worse, a 409 that makes a saga compensate. By the next attempt the
      // rival has committed or aborted.
      const { sql, issued } = recorder([[], [claim.row]]);
      await expect(claim.run(sql)).resolves.toBeDefined();
      expect(issued).toHaveLength(2);
    },
  );

  test.each(CLAIMS.map((claim) => [claim.name, claim] as const))(
    "%s gives up rather than re-running forever",
    async (_name, claim) => {
      // Exhausted is a plain `Error`, i.e. a 503, and that is the right answer:
      // the store genuinely cannot say what the row holds, and the call is
      // idempotent. What it may NOT do is spin.
      const { sql, issued } = recorder([]);
      await expect(claim.run(sql)).rejects.toThrow();
      expect(issued.length).toBeLessThanOrEqual(3);
    },
  );

  test("claimHook still refuses a VISIBLE owner on the first answer", async () => {
    // The retry is scoped to the empty answer. An owner the statement can see is
    // a decision, so it must not be re-run and must not be softened into one.
    const { sql, issued } = recorder([[{ ...HOOK_ROW, run_id: "wrun_other", key: "hook!0" }]]);
    await expect(journal.claimHook(sql, SLUG, "wrun_1", "hook!0", "tok")).rejects.toBeInstanceOf(
      journal.PlatformWorkflowHookTokenError,
    );
    expect(issued).toHaveLength(1);
  });
});

describe("claimAttempt", () => {
  test("is ONE statement, which IS the atomicity claim", async () => {
    // Read-then-increment lets two concurrent deliveries read the same number,
    // after which a wedged step never reaches its ceiling. Whether the database
    // makes the single statement atomic is the scenario tier's question; whether
    // there is only one is this one's, and a second query would settle it here.
    const { sql, issued } = recorder([[{ n: 3 }]]);
    expect(await journal.claimAttempt(sql, SLUG, "wrun_1", "a#0", "walk-1", 60_000)).toBe(3);
    expect(issued).toHaveLength(1);
    expect(issued[0]?.sql).toMatch(/on conflict .* do update\s+set holders/s);
  });

  test("keeps a LIVE holder's instant, which is the whole of the `case`", async () => {
    // An unconditional `||` would refresh it, and a walk that keeps re-reaching
    // one key would hold its charge indefinitely — the failure the expiry exists
    // to end, by a slower route. A recorder cannot see the effect; it can see
    // the branch go missing.
    const { sql, issued } = recorder([[{ n: 1 }]]);
    await journal.claimAttempt(sql, SLUG, "wrun_1", "a#0", "walk-1", 60_000);
    expect(issued[0]?.sql).toMatch(/case\s+when .*holders ->> \$4.*>= \$6\s+then '\{\}'::jsonb/s);
  });

  test("refuses an empty result rather than inventing an attempt number", async () => {
    const { sql } = recorder([[]]);
    await expect(
      journal.claimAttempt(sql, SLUG, "wrun_1", "a#0", "walk-1", 60_000),
    ).rejects.toThrow(/returned nothing/);
  });
});

describe("createRun", () => {
  test("REFUSES a duplicate run id rather than reporting success", async () => {
    // `on conflict … do nothing` with no `returning` made this store the ONE
    // backend that answered a duplicate with success: memory throws and the
    // self-hosted store trips its primary key, so `JournalStore.createRun`'s
    // "rejects if `runId` already exists" held everywhere except on the arm every
    // DEPLOYED agent uses. Two racing starts on one id both believed they had
    // won, and the loser's `input` was discarded with nothing anywhere naming it.
    //
    // The empty result IS the conflict: a bare insert of one row either reports
    // that row or was blocked by a row already there, and `do nothing` does not
    // wait on a concurrent inserter — it declines, which is what makes this
    // reachable by the race rather than only by a committed duplicate.
    const { sql, issued } = recorder([[]]);
    await expect(
      journal.createRun(sql, SLUG, {
        runId: "wrun_1",
        workflow: "digest",
        status: "pending",
        createdAt: 1,
      }),
    ).rejects.toBeInstanceOf(journal.PlatformWorkflowRunTakenError);
    // Without the `returning`, zero rows and one row are the same answer.
    expect(issued[0]?.sql).toContain("returning run_id");
  });

  test("refuses it as a TYPED error, which is what buys the caller a 409", async () => {
    // Same argument as `claimHook`'s below: every plain `Error` reaching
    // `withReserved` becomes a 503, so the guest retries a refusal that cannot
    // change and spends the message's whole attempt budget on it.
    const { sql } = recorder([[]]);
    await expect(
      journal.createRun(sql, SLUG, {
        runId: "wrun_1",
        workflow: "digest",
        status: "pending",
        createdAt: 1,
      }),
    ).rejects.toThrow(/workflow run wrun_1 already exists/);
  });

  test("resolves when the insert reports the row it wrote", async () => {
    const { sql } = recorder([[{ run_id: "wrun_1" }]]);
    await expect(
      journal.createRun(sql, SLUG, {
        runId: "wrun_1",
        workflow: "digest",
        status: "pending",
        createdAt: 1,
        input: `{"topic":"otters"}`,
      }),
    ).resolves.toBeUndefined();
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
  test("is ONE statement, so the ownership check IS the claim", async () => {
    // The ownership `select` and the `insert` used to be two round trips on an
    // untransacted connection, so two runs of one agent claiming the same DERIVED
    // token concurrently both read no owner and the loser tripped
    // `workflow_hooks_token_idx` (23505) instead of the authored refusal. An
    // untargeted `on conflict do nothing` cannot raise that at all, and one
    // statement is what makes the read and the write one decision.
    const { sql, issued } = recorder([[{ ...HOOK_ROW, run_id: "wrun_1", key: "hook!0" }]]);
    await journal.claimHook(sql, SLUG, "wrun_1", "hook!0", "tok");
    expect(issued).toHaveLength(1);
    expect(issued[0]?.sql).toContain("on conflict do nothing");
  });

  test("refuses a token another run holds, naming the holder", async () => {
    // Two waits sharing a token means one signal resolves whichever row the
    // planner reached first and the other waits forever.
    const { sql } = recorder([[{ ...HOOK_ROW, run_id: "wrun_other", key: "hook!0" }]]);
    await expect(journal.claimHook(sql, SLUG, "wrun_1", "hook!0", "tok")).rejects.toThrow(
      /already held by run wrun_other/,
    );
  });

  test("refuses it as a TYPED error, which is what buys the caller a 409", async () => {
    // A plain `Error` reaches `withReserved`'s catch-all and becomes a 503 —
    // "come back later" for a condition that cannot change while the holder is
    // alive, so the guest retries and burns the message's attempt budget on it.
    const { sql } = recorder([[{ ...HOOK_ROW, run_id: "wrun_other", key: "hook!0" }]]);
    await expect(journal.claimHook(sql, SLUG, "wrun_1", "hook!0", "tok")).rejects.toBeInstanceOf(
      journal.PlatformWorkflowHookTokenError,
    );
  });

  test("accepts a re-claim by the SAME run and key, which is what a replay does", async () => {
    const { sql } = recorder([[{ ...HOOK_ROW, run_id: "wrun_1", key: "hook!0" }]]);
    await expect(journal.claimHook(sql, SLUG, "wrun_1", "hook!0", "tok")).resolves.toMatchObject({
      token: "tok",
      delivered: false,
    });
  });
});

describe("closeHook is a compare-and-set", () => {
  test("the update refuses an already-DELIVERED window", async () => {
    // Unconditional, this walk of the body timed out while every later replay
    // read `delivered: true` and answered — the divergence `closed` exists to
    // prevent, arriving by the other door.
    const { sql, issued } = recorder([[{ closed: "1", existing: "1" }]]);
    expect(await journal.closeHook(sql, SLUG, "wrun_1", "hook!0")).toBe(true);
    expect(issued[0]?.sql).toContain("delivered = false");
  });

  test("answers false when the row exists and the update matched nothing", async () => {
    const { sql } = recorder([[{ closed: "0", existing: "1" }]]);
    expect(await journal.closeHook(sql, SLUG, "wrun_1", "hook!0")).toBe(false);
  });

  test("answers true when the window is GONE, a terminal run having released it", async () => {
    // Nothing to refuse, so the caller's timeout stands.
    const { sql } = recorder([[{ closed: "0", existing: "0" }]]);
    expect(await journal.closeHook(sql, SLUG, "wrun_1", "hook!0")).toBe(true);
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
