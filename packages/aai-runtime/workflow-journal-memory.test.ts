// Copyright 2026 the AAI authors. MIT license.
/**
 * The REFERENCE implementation's own spec.
 *
 * `createMemoryJournal` is what `workflow-engine.test.ts` and
 * `workflow-replay.test.ts` run the engine against, so most of the contract is
 * already exercised — as a side effect of testing something else, which is
 * exactly the coverage that stops covering a branch the moment the engine stops
 * taking it. What is here is the part of this backend those specs cannot reach,
 * plus the refusals its own module doc turns on:
 *
 * - **The terminal-run SWEEP.** It is the one thing this journal does that
 *   DELETES, and it was reached by nothing: an engine spec starts a handful of
 *   runs and the cap is 200. A sweep that dropped an in-flight run would strand
 *   it, and one that forgot a slot's hook tokens would hold a DERIVED token —
 *   which is what the SDK tells authors to use — against every later run in the
 *   process.
 * - **A token goes back the moment its run goes terminal**, which is the same
 *   release the two Postgres stores get from `setStatus`'s `delete` CTE. The
 *   three backends agreeing on this is what makes a second `recap-workflow`
 *   recap in one session possible at all.
 * - **The refusals.** A duplicate `runId`, and the four methods that throw for
 *   a run nothing created.
 */

import { describe, expect, test } from "vitest";
import { recordingDb } from "./_test-utils.ts";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import { createPlatformJournal } from "./workflow-journal-platform.ts";
import { createPostgresJournal } from "./workflow-journal-postgres.ts";
import type { JournalStore, RunRecord, StepEntry } from "./workflow-journal-types.ts";
import { isResumableJournal } from "./workflow-journal-types.ts";

/** `createRun`'s bag, with only the parts a case varies spelled out. */
function runRecord(runId: string, over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId,
    workflow: "digest",
    status: "pending",
    createdAt: 1,
    input: { topic: "otters" },
    ...over,
  };
}

/** `appendStep`'s bag: a settled step, named after its own key. */
function stepRecord(key: string, finishedAt: number): StepEntry {
  return {
    key,
    name: key.split("#")[0] ?? key,
    status: "ok",
    output: null,
    attempts: 1,
    finishedAt,
  };
}

/** Start a run and drive it straight to `completed`. */
async function settle(journal: JournalStore, runId: string, createdAt = 1): Promise<void> {
  await journal.createRun(runRecord(runId, { createdAt }));
  await journal.setStatus(runId, "completed", { output: null });
}

describe("the terminal-run sweep", () => {
  // The cap is 200 (`MAX_TERMINAL_RUNS`), deliberately not exported — a test
  // reading it would pass against any value including a broken one. 260 is
  // comfortably past it whatever the constant says, and the assertions are
  // about the SHAPE (oldest gone, newest kept, in-flight kept) rather than a
  // boundary index.
  const PAST_THE_CAP = 260;

  test("forgets the OLDEST terminal runs and keeps the newest", async () => {
    const journal = createMemoryJournal();
    for (let i = 0; i < PAST_THE_CAP; i++) await settle(journal, `wrun_${i}`, i);

    expect(await journal.getRun("wrun_0")).toBeUndefined();
    expect(await journal.getRun(`wrun_${PAST_THE_CAP - 1}`)).toMatchObject({ status: "completed" });
    // Under the cap, so something in the middle survives too — the sweep drops
    // an OVERHANG rather than truncating to a recent window.
    expect(await journal.getRun(`wrun_${PAST_THE_CAP - 100}`)).toBeDefined();
  });

  test("never forgets an IN-FLIGHT run, however old", async () => {
    const journal = createMemoryJournal();
    // Started first, so it is the first entry the sweep's insertion-order walk
    // meets — and it is still owed a delivery.
    await journal.createRun(runRecord("wrun_inflight", { createdAt: 0 }));
    for (let i = 0; i < PAST_THE_CAP; i++) await settle(journal, `wrun_${i}`, i + 1);

    expect(await journal.getRun("wrun_inflight")).toMatchObject({ status: "pending" });
  });

  test("gives a forgotten run's hook TOKENS back", async () => {
    // `byToken` is an index INTO the slots, so a swept slot whose entry stayed
    // would hold its token against every later run for the life of the process
    // — the lifetime half of what the DevKit's `using`-scoped hook released.
    const journal = createMemoryJournal();
    await journal.createRun(runRecord("wrun_old", { createdAt: 0 }));
    await journal.claimHook("wrun_old", "hook!0", "retention:session-7");
    await journal.setStatus("wrun_old", "completed");
    for (let i = 0; i < PAST_THE_CAP; i++) await settle(journal, `wrun_${i}`, i + 1);

    await journal.createRun(runRecord("wrun_new", { createdAt: 9999 }));
    await expect(
      journal.claimHook("wrun_new", "hook!0", "retention:session-7"),
    ).resolves.toMatchObject({ token: "retention:session-7", delivered: false });
  });
});

describe("a token is held only while its run might still be answered", () => {
  test("a TERMINAL move releases it, so a derived token serves a second run", async () => {
    // The same release `setStatus`'s `delete` CTE gives the two Postgres stores.
    // Without it `recap-workflow`'s `retention:<sessionId>` served exactly one
    // run ever: a second recap in one session hit `claimHook`'s conflict, which
    // is not a suspend, so the saga compensated and deleted that transcript too.
    const journal = createMemoryJournal();
    await journal.createRun(runRecord("wrun_1"));
    await journal.claimHook("wrun_1", "hook!0", "retention:s1");
    await journal.setStatus("wrun_1", "completed");

    await journal.createRun(runRecord("wrun_2"));
    await expect(journal.claimHook("wrun_2", "hook!0", "retention:s1")).resolves.toMatchObject({
      delivered: false,
    });
  });

  test("a NON-terminal move keeps it — that is what a hook is for", async () => {
    const journal = createMemoryJournal();
    await journal.createRun(runRecord("wrun_1"));
    await journal.claimHook("wrun_1", "hook!0", "tok");
    await journal.setStatus("wrun_1", "running");

    await journal.createRun(runRecord("wrun_2"));
    await expect(journal.claimHook("wrun_2", "hook!0", "tok")).rejects.toThrow(
      /already held by run wrun_1/,
    );
  });

  test("a released token no longer resolves a DELIVERY", async () => {
    const journal = createMemoryJournal();
    await journal.createRun(runRecord("wrun_1"));
    await journal.claimHook("wrun_1", "hook!0", "tok");
    await journal.setStatus("wrun_1", "completed");

    expect(await journal.deliverHook("tok", { ok: true })).toBeUndefined();
  });
});

describe("listRuns is a TOTAL order, not merely sorted", () => {
  test("breaks a same-millisecond tie on the id, by code unit", async () => {
    // Two runs started in the same millisecond are ordinary under a fan-out, so
    // `createdAt` alone leaves the listing free to reorder between calls.
    const journal = createMemoryJournal();
    for (const id of ["wrun_b", "wrun_a", "wrun_c"]) {
      await journal.createRun(runRecord(id, { createdAt: 5 }));
    }
    const ids = (await journal.listRuns("digest", 10)).map((run) => run.runId);
    expect(ids).toEqual(["wrun_c", "wrun_b", "wrun_a"]);
    expect((await journal.listRuns("digest", 10)).map((run) => run.runId)).toEqual(ids);
  });

  test("filters to one declared key and honours the limit", async () => {
    const journal = createMemoryJournal();
    await journal.createRun(runRecord("wrun_1", { workflow: "digest", createdAt: 1 }));
    await journal.createRun(runRecord("wrun_2", { workflow: "recap", createdAt: 2 }));
    await journal.createRun(runRecord("wrun_3", { workflow: "digest", createdAt: 3 }));

    expect((await journal.listRuns("digest", 10)).map((run) => run.runId)).toEqual([
      "wrun_3",
      "wrun_1",
    ]);
    expect(await journal.listRuns("digest", 1)).toHaveLength(1);
  });
});

describe("readSteps is a TOTAL order too, for the same reason", () => {
  test("breaks a same-millisecond tie on the step KEY, not on insertion order", async () => {
    // Both databases read the journal back with `order by finished_at, key`, so
    // insertion order — which is all this backend used to answer with — agrees
    // with them right up to a tie. Two steps of one fan-out settling inside one
    // millisecond is ordinary, and the reference implementation is what the
    // other two are checked against, so it is the one that has to be right.
    const journal = createMemoryJournal();
    await journal.createRun(runRecord("wrun_ties"));
    for (const key of ["b#0", "a#0"]) {
      await journal.appendStep("wrun_ties", stepRecord(key, 7));
    }
    expect((await journal.readSteps("wrun_ties")).map((step) => step.key)).toEqual(["a#0", "b#0"]);
  });

  test("orders by finishedAt ahead of the key, so a later step sorts later", async () => {
    const journal = createMemoryJournal();
    await journal.createRun(runRecord("wrun_order"));
    for (const [key, finishedAt] of [
      ["z#0", 1],
      ["a#0", 2],
    ] as const) {
      await journal.appendStep("wrun_order", stepRecord(key, finishedAt));
    }
    expect((await journal.readSteps("wrun_order")).map((step) => step.key)).toEqual(["z#0", "a#0"]);
  });
});

describe("the refusals", () => {
  test("createRun rejects a duplicate id rather than overwriting", async () => {
    // The id is the CALLER's, so a collision is two starts racing and keeping
    // the second discards a run somebody already holds an id for.
    const journal = createMemoryJournal();
    await journal.createRun(runRecord("wrun_1"));
    await expect(journal.createRun(runRecord("wrun_1"))).rejects.toThrow(/already exists/);
  });

  test.each([
    ["claimAttempt", (j: JournalStore) => j.claimAttempt("wrun_missing", "a#0", "w", 1000)],
    ["claimSleep", (j: JournalStore) => j.claimSleep("wrun_missing", "s#0", 1, undefined)],
    ["claimHook", (j: JournalStore) => j.claimHook("wrun_missing", "h#0", "tok")],
    [
      "appendStep",
      (j: JournalStore) =>
        j.appendStep("wrun_missing", {
          key: "a#0",
          name: "a",
          status: "ok",
          attempts: 1,
          finishedAt: 1,
        }),
    ],
  ])("%s throws for a run nothing created", async (_label, act) => {
    await expect(act(createMemoryJournal())).rejects.toThrow(/wrun_missing not found/);
  });

  test("the READS answer emptily instead, because a listing must not fail", async () => {
    const journal = createMemoryJournal();
    expect(await journal.getRun("wrun_missing")).toBeUndefined();
    expect(await journal.readSteps("wrun_missing")).toEqual([]);
    expect(await journal.setStatus("wrun_missing", "completed")).toBe(false);
    expect(await journal.wakeSleeps("wrun_missing", undefined)).toBe(0);
    // `true` rather than a throw AND rather than `false`: there is no window to
    // refuse, so no signal can be taken and the caller's timeout stands.
    await expect(journal.closeHook("wrun_missing", "h#0")).resolves.toBe(true);
  });
});

describe("what a caller is handed is a COPY", () => {
  test("mutating a returned record cannot edit the store", async () => {
    // The one way a memory backend can differ from a real one in a direction
    // that HIDES a bug rather than causing one.
    const journal = createMemoryJournal();
    await journal.createRun(runRecord("wrun_1"));
    const run = await journal.getRun("wrun_1");
    if (run) run.status = "completed";
    expect(await journal.getRun("wrun_1")).toMatchObject({ status: "pending" });

    await journal.appendStep("wrun_1", {
      key: "a#0",
      name: "a",
      status: "ok",
      output: 1,
      attempts: 1,
      finishedAt: 1,
    });
    const [step] = await journal.readSteps("wrun_1");
    if (step) step.attempts = 99;
    expect((await journal.readSteps("wrun_1"))[0]?.attempts).toBe(1);
  });
});

describe("closeHook is a COMPARE-AND-SET, and the three backends agree on it", () => {
  // Unconditional, it prevented only half the divergence `HookRecord.closed`
  // documents: the engine reads the deadline and THEN closes, so a signal
  // landing between the two left this walk taking the timed-out branch while
  // every later replay read `delivered: true` and answered. The boolean is what
  // the engine branches on, so a backend that answers it differently sends one
  // deployment down a branch the other two never take.

  test("the reference answers false for an ANSWERED window, and leaves it answered", async () => {
    const journal = createMemoryJournal();
    await journal.createRun(runRecord("wrun_1"));
    await journal.claimHook("wrun_1", "hook!0", "tok");
    expect(await journal.deliverHook("tok", { ok: true })).toBe("wrun_1");

    expect(await journal.closeHook("wrun_1", "hook!0")).toBe(false);
    // The refusal must not have shut the window on the way out — the next replay
    // has to read the payload.
    const reread = await journal.claimHook("wrun_1", "hook!0", "tok");
    expect(reread).toMatchObject({ delivered: true, payload: { ok: true } });
    expect(reread.closed).not.toBe(true);
  });

  test("the reference answers true for an OPEN window, and shuts it", async () => {
    const journal = createMemoryJournal();
    await journal.createRun(runRecord("wrun_1"));
    await journal.claimHook("wrun_1", "hook!0", "tok");

    expect(await journal.closeHook("wrun_1", "hook!0")).toBe(true);
    // Idempotent, which is what a replay of the timeout path does.
    expect(await journal.closeHook("wrun_1", "hook!0")).toBe(true);
    expect(await journal.deliverHook("tok", { late: true })).toBeUndefined();
  });

  test("the reference answers true for a window that is GONE", async () => {
    // A terminal run gives its tokens back, so there is nothing to refuse and
    // the caller's timeout stands.
    const journal = createMemoryJournal();
    await journal.createRun(runRecord("wrun_1"));
    expect(await journal.closeHook("wrun_1", "hook!0")).toBe(true);
  });

  /**
   * The same two answers, read out of each backend's own wire shape.
   *
   * The memory arm is behaviour; the other two are DECODING — a row count for
   * Postgres, a JSON value for the platform — which is the half that can drift
   * without a database in the room. What each backend does with the statement it
   * sends is `workflow-journal.scenario.test.ts`'s and
   * `platform-workflow-journal.scenario.test.ts`'s question.
   */
  const BACKENDS: readonly {
    name: string;
    /** A journal whose `closeHook` will answer the given verdict. */
    of: (closed: boolean) => JournalStore;
  }[] = [
    {
      name: "postgres",
      of: (closed) =>
        createPostgresJournal({
          db: recordingDb([[{ closed: closed ? "1" : "0", existing: "1" }]]),
        }),
    },
    {
      name: "platform",
      of: (closed) =>
        createPlatformJournal({
          base: "https://platform.test/digest",
          token: "sandbox-token",
          fetch: async () =>
            new Response(JSON.stringify({ result: closed }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        }),
    },
  ];

  test.each(BACKENDS.map((backend) => [backend.name, backend] as const))(
    "%s answers true when the window shut",
    async (_name, backend) => {
      expect(await backend.of(true).closeHook("wrun_1", "hook!0")).toBe(true);
    },
  );

  test.each(BACKENDS.map((backend) => [backend.name, backend] as const))(
    "%s answers false when the update matched nothing, so the caller answers",
    async (_name, backend) => {
      expect(await backend.of(false).closeHook("wrun_1", "hook!0")).toBe(false);
    },
  );
});

describe("resumableRuns is DECLARED here", () => {
  test("the reference backend can be swept, so the boot sweep is reachable", async () => {
    // The presence pin. `resumableRuns` is OPTIONAL on `JournalStore` — the
    // platform backend omits it on purpose — so the shared conformance cases
    // probe for it and state the absence rather than failing. That means a
    // backend which silently LOST the method would pass the whole table through
    // the absent branch. This is where memory's half of that is nailed down;
    // `workflow-journal-postgres.test.ts` and `workflow-journal-platform.test.ts`
    // carry the other two.
    const journal = createMemoryJournal();
    expect(isResumableJournal(journal)).toBe(true);
    expect(await journal.resumableRuns?.(10)).toEqual([]);
  });
});
