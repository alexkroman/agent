// Copyright 2026 the AAI authors. MIT license.
/**
 * What a RECORDER can see about the Postgres journal — and it is one thing above
 * all others.
 *
 * `workflow-journal.scenario.test.ts` (in `aai-server`) drives this against a
 * real server and is where the behaviour lives: whether `claimAttempt` really
 * increments atomically, whether `appendStep`'s `on conflict` rests on a key that
 * exists. None of that is representable here, because a recording `Db` returns
 * whatever it is told to.
 *
 * What IS worth pinning in the fast tier is the SHAPE of three decisions that
 * were wrong when written and whose failure is silent:
 *
 * - **Every jsonb binding is `::text::jsonb`.** postgres.js JSON-serializes a
 *   parameter bound to a `jsonb` position, so handing it the codec's
 *   already-encoded text stores a JSON *string* containing the JSON — after which
 *   a run's `input` reads back as text and a `Uint8Array` envelope never revives.
 *   It shipped, and only a real server found it. A recorder can see the cast, so
 *   the cheap tier can keep it.
 * - **The compare-and-set really passes its `expect` list.** `setStatus`'s whole
 *   contract is that a worker which had not noticed a cancel cannot mark the run
 *   completed, and that is a `where` clause a recorder CAN read.
 * - **No statement binds `undefined`.** postgres.js refuses one outright, so a
 *   workflow body that returns nothing used to fail `setStatus` inside the
 *   driver and leave the run `running` forever. The recorder cannot run the
 *   driver — but the PARAMETER is exactly what the driver rejects, so it can
 *   see the bug.
 */

import type { Db } from "@alexkroman1/aai/internal";
import { describe, expect, test } from "vitest";
import { type IssuedStatement, recordingDb } from "./_test-utils.ts";
import { createPostgresJournal } from "./workflow-journal-postgres.ts";
import { isResumableJournal } from "./workflow-journal-types.ts";

/** `recordingDb` under this file's older name, returning the two halves apart. */
function recorder(rows: readonly Record<string, unknown>[][] = []) {
  const db = recordingDb(rows);
  return { db, issued: db.issued };
}

/** Every statement that binds a value into a `jsonb` column. */
const JSONB_BINDINGS = /\$\d+::(text::)?jsonb/g;

describe("every jsonb binding casts through text", () => {
  test("createRun, setStatus, appendStep and deliverHook all use `::text::jsonb`", async () => {
    // createRun, setStatus, appendStep's insert, appendStep's read-back,
    // deliverHook — the read-back is the only one whose answer is load-bearing
    // (an empty result is a thrown "step vanished").
    const { db, issued } = recorder([
      [],
      [{ run_id: "wrun_1" }],
      [],
      [
        {
          key: "a#0",
          name: "a",
          status: "ok",
          output: '"value"',
          error: null,
          attempts: 1,
          finished_at: 2,
        },
      ],
      [],
    ]);
    const journal = createPostgresJournal({ db });

    await journal.createRun({
      runId: "wrun_1",
      workflow: "digest",
      status: "pending",
      createdAt: 1,
      input: { topic: "otters" },
    });
    await journal.setStatus("wrun_1", "completed", { output: "done" }, ["running"]);
    await journal.appendStep("wrun_1", {
      key: "a#0",
      name: "a",
      status: "ok",
      output: "value",
      attempts: 1,
      finishedAt: 2,
    });
    await journal.deliverHook("tok", { ok: true });

    const casts = issued.flatMap((stmt: IssuedStatement) => stmt.sql.match(JSONB_BINDINGS) ?? []);
    // Four writes carry an encoded value, and every one of them must name `text`
    // first — a bare `$n::jsonb` is the double-encode.
    expect(casts.length).toBeGreaterThanOrEqual(4);
    expect(casts.filter((cast: string) => !cast.includes("::text::jsonb"))).toEqual([]);
  });

  test("binds the codec's TEXT, not an object", async () => {
    // The other half of the same decision: if a caller ever "fixed" the cast by
    // parsing the value instead, the parameter would stop being a string and the
    // envelope would be re-serialized by the driver rather than by the codec.
    const { db, issued } = recorder();
    await createPostgresJournal({ db }).createRun({
      runId: "wrun_1",
      workflow: "digest",
      status: "pending",
      createdAt: 1,
      input: { topic: "otters" },
    });
    // By MEMBERSHIP rather than by position. This read `params.at(-1)` and
    // broke the day `code_version` was appended to the insert — a false failure
    // about a parameter this test is not about. `toContain` compares with
    // `Object.is`, so a re-parsed object still would not match the string, which
    // is the whole claim.
    expect(issued[0]?.params).toContain('{"topic":"otters"}');
    // Stated POSITIVELY — every parameter is something the driver binds as-is.
    // The negative spelling (`typeof p === "object" && p !== null`) is an
    // open-coded record guard, which `guard-invariants` rule 17 counts, and
    // `isRecord` is not the remedy here: it excludes arrays, and an array
    // parameter would be just as wrong as an object.
    const bindable = (value: unknown) =>
      value === null || typeof value === "string" || typeof value === "number";
    expect(issued[0]?.params.every(bindable)).toBe(true);
  });
});

describe("no statement ever binds `undefined`", () => {
  // postgres.js REFUSES an undefined parameter — `UNDEFINED_VALUE: Undefined
  // values are not allowed`, thrown from `handleValue` before a byte is sent,
  // and `sql.unsafe` is untagged so every parameter goes through it. Four
  // bindings here are `encodeStorageJson(...)`, which is `JSON.stringify`
  // underneath and answers `undefined` for `undefined` whatever its return type
  // says. The reachable one was `setStatus`: a body that returns nothing makes
  // the engine call `setStatus(runId, "completed", { output: undefined })`, the
  // run never left `running`, and the delivery retried into the same fault.
  //
  // A recorder cannot run the driver, so what it CAN see is the parameter — and
  // that is exactly the value the driver rejects.
  test.each([
    [
      "createRun with no input",
      (journal: ReturnType<typeof createPostgresJournal>) =>
        journal.createRun({
          runId: "wrun_1",
          workflow: "digest",
          status: "pending",
          createdAt: 1,
          input: undefined,
        }),
    ],
    [
      "setStatus completing with no output",
      (journal: ReturnType<typeof createPostgresJournal>) =>
        journal.setStatus("wrun_1", "completed", { output: undefined }, ["running"]),
    ],
    [
      "deliverHook with no payload",
      (journal: ReturnType<typeof createPostgresJournal>) => journal.deliverHook("tok", undefined),
    ],
    [
      "appendStep with no output",
      (journal: ReturnType<typeof createPostgresJournal>) =>
        journal.appendStep("wrun_1", {
          key: "a#0",
          name: "a",
          status: "ok",
          attempts: 1,
          finishedAt: 2,
        }),
    ],
  ])("%s binds null", async (_label, act) => {
    const { db, issued } = recorder([
      [
        {
          run_id: "wrun_1",
          key: "a#0",
          name: "a",
          status: "ok",
          output: null,
          error: null,
          attempts: 1,
          finished_at: 2,
        },
      ],
    ]);
    await act(createPostgresJournal({ db }));
    for (const statement of issued) {
      expect(statement.params, statement.sql).not.toContain(undefined);
    }
  });
});

describe("setStatus", () => {
  test("passes its `expect` list, which IS the compare-and-set", async () => {
    const { db, issued } = recorder([[{ run_id: "wrun_1" }]]);
    const moved = await journalOf(db).setStatus("wrun_1", "completed", undefined, ["running"]);
    expect(moved).toBe(true);
    expect(issued[0]?.params).toContainEqual(["running"]);
  });

  test("answers false when the update matched no row", async () => {
    // The row count is the answer — a worker that had not noticed a cancel must
    // not be told it moved the run.
    const { db } = recorder([[]]);
    expect(await journalOf(db).setStatus("wrun_1", "completed", undefined, ["running"])).toBe(
      false,
    );
  });

  test("passes null for an ABSENT expect, so the predicate matches any status", async () => {
    const { db, issued } = recorder([[{ run_id: "wrun_1" }]]);
    await journalOf(db).setStatus("wrun_1", "cancelled");
    expect(issued[0]?.params).toContain(null);
  });
});

describe("claimHook", () => {
  test("refuses a token another run holds, naming the holder", async () => {
    const { db } = recorder([[{ run_id: "wrun_other", key: "hook!0" }]]);
    await expect(journalOf(db).claimHook("wrun_1", "hook!0", "tok")).rejects.toThrow(
      /already held by run wrun_other/,
    );
  });

  test("accepts a re-claim by the SAME run and key, which is what a replay does", async () => {
    const { db } = recorder([
      [
        {
          run_id: "wrun_1",
          key: "hook!0",
          token: "tok",
          delivered: false,
          payload: null,
          closed: false,
        },
      ],
    ]);
    await expect(journalOf(db).claimHook("wrun_1", "hook!0", "tok")).resolves.toMatchObject({
      token: "tok",
      delivered: false,
    });
  });

  test("is ONE statement, so the ownership check IS the claim", async () => {
    // The ownership `select` used to run first, on an untransacted connection, so
    // two waits racing on one token both read no owner and the loser tripped the
    // unique index — a raw 23505 where the store promises an authored refusal.
    // A bare `on conflict do nothing` absorbs the primary key and the token index
    // alike, so the row the statement reports is what decides whose claim it was.
    const { db, issued } = recorder([
      [
        {
          run_id: "wrun_1",
          key: "hook!0",
          token: "tok",
          delivered: false,
          payload: null,
          closed: false,
        },
      ],
    ]);
    await journalOf(db).claimHook("wrun_1", "hook!0", "tok");
    expect(issued).toHaveLength(1);
    expect(issued[0]?.sql).toContain("union all");
  });

  test("RE-RUNS the statement when both arms came back empty", async () => {
    // A rival's UNCOMMITTED claim is invisible to the statement's snapshot AND
    // makes `on conflict do nothing` decline, so both arms are empty — which is
    // indeterminate, not a conflict. By the next attempt the rival has committed
    // or aborted.
    const { db, issued } = recorder([
      [],
      [
        {
          run_id: "wrun_1",
          key: "hook!0",
          token: "tok",
          delivered: false,
          payload: null,
          closed: false,
        },
      ],
    ]);
    await expect(journalOf(db).claimHook("wrun_1", "hook!0", "tok")).resolves.toMatchObject({
      token: "tok",
    });
    expect(issued).toHaveLength(2);
  });
});

/** The journal over a recorder, for the cases that do not read `issued`. */
function journalOf(db: Db) {
  return createPostgresJournal({ db });
}

describe("claimAttempt", () => {
  const HOUR = 60 * 60 * 1000;

  test("is ONE statement, which IS the atomicity claim", async () => {
    // Read-then-increment would let two concurrent deliveries of the same run
    // read the same number and take a step past its ceiling. Nothing a recorder
    // can do proves the database is atomic — but a SECOND query here would prove
    // it is not, and that is the regression worth catching in the fast tier.
    const { db, issued } = recorder([[{ n: 3 }]]);
    expect(await journalOf(db).claimAttempt("wrun_1", "a#0", "walk-1", HOUR)).toBe(3);
    expect(issued).toHaveLength(1);
    expect(issued[0]?.sql).toMatch(/on conflict .* do update\s+set holders/s);
  });

  test("the upsert is CONDITIONAL, or a live holder's lease would be refreshed", async () => {
    // The whole of what stops a walk that keeps re-reaching one key holding its
    // charge indefinitely — see `_workflow-journal-attempts.ts`. A recorder
    // cannot see the effect, but it can see the `where` go missing.
    const { db, issued } = recorder([[{ n: 1 }]]);
    await journalOf(db).claimAttempt("wrun_1", "a#0", "walk-1", HOUR);
    // The `case` is the whole of what stops a LIVE holder's instant being
    // refreshed, and an unconditional `||` would delete it silently. A recorder
    // cannot see the effect; it can see the branch go missing.
    expect(issued[0]?.sql).toMatch(/case\s+when .*holders ->> \$3.*>= \$5\s+then '\{\}'::jsonb/s);
  });

  test("the CUTOFF crosses as a parameter derived from the lease, not as SQL", async () => {
    // `now() - interval` would make the DATABASE the clock, where every other
    // instant in this schema is the engine's. Asserted on the bound value so a
    // future rewrite cannot quietly move the comparison server-side.
    const { db, issued } = recorder([[{ n: 1 }]]);
    const before = Date.now();
    await journalOf(db).claimAttempt("wrun_1", "a#0", "walk-1", HOUR);
    const [, , , at, cutoff] = issued[0]?.params ?? [];
    expect(Number(at)).toBeGreaterThanOrEqual(before);
    expect(Number(at) - Number(cutoff)).toBe(HOUR);
  });

  test("refuses an empty result rather than inventing an attempt number", async () => {
    const { db } = recorder([[]]);
    await expect(journalOf(db).claimAttempt("wrun_1", "a#0", "walk-1", HOUR)).rejects.toThrow(
      /returned nothing/,
    );
  });
});

describe("releaseAttempt", () => {
  test("deletes the NAMED charge, so it cannot take another walk's", async () => {
    const { db, issued } = recorder([[]]);
    await journalOf(db).releaseAttempt("wrun_1", "a#0", "walk-1");
    expect(issued).toHaveLength(1);
    // `holders - $3` and not a decrement: the charge being given back is named,
    // so a release that lands twice removes nothing the second time.
    expect(issued[0]?.sql).toMatch(/set holders = holders - \$3/s);
    expect(issued[0]?.params).toEqual(["wrun_1", "a#0", "walk-1"]);
  });
});

describe("wakeSleeps", () => {
  test("a BARE wake reaches ordinary sleeps only, never a hook deadline", async () => {
    // The bug this pins: a hook's timeout was journaled as an ordinary sleep, so
    // a "send it now" tool calling `wakeUp()` with no correlation id also closed
    // every open approval window on the run.
    const { db, issued } = recorder([[{ key: "sleep!0" }]]);
    expect(await journalOf(db).wakeSleeps("wrun_1", undefined)).toBe(1);
    expect(issued[0]?.sql).toContain("kind = 'sleep'");
    expect(issued[0]?.params).toContain(null);
  });

  test("a CORRELATED wake passes its ids, and reaches any kind", async () => {
    const { db, issued } = recorder([[{ key: "hookTimeout!0" }]]);
    await journalOf(db).wakeSleeps("wrun_1", ["order-7"]);
    expect(issued[0]?.params).toContainEqual(["order-7"]);
  });

  test("counts the rows it moved, so a caller can tell nothing-waiting from woke-one", async () => {
    const { db } = recorder([[]]);
    expect(await journalOf(db).wakeSleeps("wrun_1", undefined)).toBe(0);
  });
});

describe("claimSleep", () => {
  test("writes with `do nothing` then READS, so a replay cannot push the deadline out", async () => {
    const { db, issued } = recorder([
      [],
      [{ wake_at: "1700000000000", woken: false, correlation_id: null, kind: "sleep" }],
    ]);
    const slept = await journalOf(db).claimSleep("wrun_1", "sleep!0", 42, undefined);
    expect(issued[0]?.sql).toMatch(/on conflict .* do nothing/s);
    // 42 went in; what comes back is the FIRST claim's deadline, not this one's.
    expect(slept.wakeAt).toBe(1_700_000_000_000);
  });

  test("defaults the kind to `sleep`, so only an explicit hook deadline is one", async () => {
    const { db, issued } = recorder([
      [],
      [{ wake_at: 1, woken: false, correlation_id: "c", kind: "sleep" }],
    ]);
    await journalOf(db).claimSleep("wrun_1", "sleep!0", 1, "c");
    expect(issued[0]?.params).toContain("sleep");
  });
});

describe("a bigint column arrives as a STRING", () => {
  test('getRun and readSteps convert it, so a timestamp is never `"17…" < 42`', async () => {
    // postgres.js hands back `bigint` as a string to avoid the 2^53 cliff. Left
    // alone, every comparison against a deadline is lexicographic and every
    // arithmetic one is concatenation.
    const { db } = recorder([
      [
        {
          run_id: "wrun_1",
          workflow: "digest",
          status: "completed",
          created_at: "1700000000000",
          input: '{"topic":"otters"}',
          output: '"done"',
          error: null,
        },
      ],
      [
        {
          key: "a#0",
          name: "a",
          status: "ok",
          output: "1",
          error: null,
          attempts: 1,
          finished_at: "1700000000001",
        },
      ],
    ]);
    const journal = journalOf(db);
    const run = await journal.getRun("wrun_1");
    expect(run?.createdAt).toBe(1_700_000_000_000);
    expect(run?.input).toEqual({ topic: "otters" });

    const [step] = await journal.readSteps("wrun_1");
    expect(step?.finishedAt).toBe(1_700_000_000_001);
  });

  test("getRun answers undefined for a run nothing stored", async () => {
    const { db } = recorder([[]]);
    expect(await journalOf(db).getRun("wrun_missing")).toBeUndefined();
  });

  test("listRuns passes its limit and maps every row", async () => {
    const row = {
      run_id: "wrun_1",
      workflow: "digest",
      status: "pending" as const,
      created_at: 7,
      input: "null",
      output: null,
      error: null,
    };
    const { db, issued } = recorder([[row, { ...row, run_id: "wrun_2" }]]);
    const runs = await journalOf(db).listRuns("digest", 25);
    expect(runs.map((r) => r.runId)).toEqual(["wrun_1", "wrun_2"]);
    expect(issued[0]?.params).toContain(25);
  });
});

describe("resumableRuns is DECLARED here, and reads only its own tables", () => {
  test("the sweep query bounds itself and never binds undefined", async () => {
    // The presence pin — see `workflow-journal-memory.test.ts` for why each
    // backend needs one. What a recorder can additionally see is the two things
    // that were wrong when this was written elsewhere: an unbounded pass, and a
    // status filter spelled as a negation (which stops matching an index).
    const { db, issued } = recorder([[]]);
    const journal = createPostgresJournal({ db });
    expect(isResumableJournal(journal)).toBe(true);
    expect(await journal.resumableRuns?.(200)).toEqual([]);
    const statement = issued[0];
    expect(statement?.params).toEqual([200]);
    expect(statement?.sql).toContain("limit $1");
    expect(statement?.sql).toContain("status in ('pending', 'running')");
  });

  test("a null wake_at maps to an ABSENT deadline, not to null", async () => {
    // One of the five absence drifts the conformance table exists to hammer: the
    // memory backend answers `undefined` for a run waiting on nothing, and a
    // `null` here would read as a deadline at the epoch — i.e. always overdue.
    const { db } = recorder([[{ run_id: "wrun_1", wake_at: null }]]);
    expect(await createPostgresJournal({ db }).resumableRuns?.(10)).toEqual([{ runId: "wrun_1" }]);
  });

  test("a bigint wake_at arrives as a STRING and is read as a number", async () => {
    const { db } = recorder([[{ run_id: "wrun_1", wake_at: "1700000000123" }]]);
    expect(await createPostgresJournal({ db }).resumableRuns?.(10)).toEqual([
      { runId: "wrun_1", wakeAt: 1_700_000_000_123 },
    ]);
  });
});
