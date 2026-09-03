// Copyright 2026 the AAI authors. MIT license.
/**
 * The gate under the gate: proof that the replay post-condition and the derived
 * journal invariants can FAIL.
 *
 * Everything in `_workflow-journal-log.ts`,
 * `_workflow-journal-invariants.ts` and `_workflow-engine-harness.ts`'s
 * `expectWorldSound` reports success by printing nothing, which is the shape of
 * failure this repo keeps paying for — a gate that stopped matching prints the
 * same green as a tree that is clean. `check-escape-hatches`, `guard-invariants`
 * and `check-test-assertions` all carry their own spec for the same reason, and
 * `packages/aai-templates/CLAUDE.md` argues it.
 *
 * Three things are pinned:
 *
 * - **The hook is WIRED.** `harness` registers the post-condition, and it really
 *   re-derives the runs a spec finished rather than skipping all of them. This is
 *   what the two engine suites do not floor — see that harness's module doc for
 *   why a per-file count floor is refused.
 * - **The post-condition CATCHES a journal that cannot re-derive its run.**
 *   Demonstrated twice — a step whose journaled output came back changed, and a
 *   body that reads a clock outside `ctx.now`. Its BOUNDARY is pinned in the
 *   same block: a log missing a step entry passes, because replay simply does
 *   the work again.
 * - **Every derived invariant fires**, each on a hand-written log that breaks
 *   exactly one of them, and none of them fires on a healthy log.
 */

import { describe, expect, test, vi } from "vitest";
import {
  createdRuns,
  expectReplayable,
  expectWorldSound,
  harness,
  unwatchedHarness,
} from "./_workflow-engine-harness.ts";
import { checkJournalInvariants } from "./_workflow-journal-invariants.ts";
import { type JournalWrite, rebuildJournal, recordJournal } from "./_workflow-journal-log.ts";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import type { RunRecord, StepEntry } from "./workflow-journal-types.ts";

/** A run record, with only the field a case is about spelled out. */
function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "wrun_1",
    workflow: "digest",
    status: "pending",
    createdAt: 0,
    input: {},
    ...over,
  };
}

/** A settled step entry. */
function step(over: Partial<StepEntry> = {}): StepEntry {
  return { key: "work#0", name: "work", status: "ok", attempts: 1, finishedAt: 1, ...over };
}

/** The two writes every log starts with: the create, and the first delivery. */
const opened: JournalWrite[] = [
  { m: "createRun", runId: "wrun_1", record: run() },
  {
    m: "setStatus",
    runId: "wrun_1",
    next: "running",
    patch: undefined,
    expect: ["pending", "running"],
    moved: true,
  },
];

describe("the post-condition is wired", () => {
  test("harness re-derives every run a spec finished", async () => {
    const world = harness({ digest: (input) => ({ echoed: input.topic }) });
    const runId = await world.engine.start("digest", [{ topic: "otters" }]);
    await world.engine.execute(runId);

    // The number is what proves the hook is not a no-op: `harness` runs this
    // same function on test teardown, and a version of it that skipped every
    // run would be invisible there.
    expect(await expectWorldSound(world)).toBe(1);
    expect(createdRuns(world.writes)).toEqual([runId]);
  });

  test("a run still parked is skipped, and says so when asked directly", async () => {
    const world = harness({
      digest: async (_input, ctx) => {
        await ctx.sleep("settle", 60_000);
        return "eventually";
      },
    });
    const runId = await world.engine.start("digest", [{}]);
    await world.engine.execute(runId);

    expect(await expectWorldSound(world)).toBe(0);
    await expect(expectReplayable(world, runId)).rejects.toThrow(/is running/);
  });

  test("it FAILS when a step's journaled output does not survive the round trip", async () => {
    // `unwatchedHarness`, because this test's teardown must not also run the
    // post-condition it is deliberately breaking.
    const world = unwatchedHarness({ digest: (_input, ctx) => ctx.step("work", () => "done") });
    const runId = await world.engine.start("digest", [{}]);
    await world.engine.execute(runId);
    expect(await expectWorldSound(world)).toBe(1);

    // A step whose stored output came back CHANGED is the bug class this exists
    // for, and the one `workflow-typed-json.ts` is written against: a backend
    // reaching for `JSON.stringify` turns a `Uint8Array` into an index map and
    // "the run resumes with garbage rather than failing". Nothing above the
    // journal notices, because the run still completes.
    const corrupted = world.writes.map((write) =>
      write.m === "appendStep" ? { ...write, entry: { ...write.entry, output: "garbage" } } : write,
    );
    await expect(expectReplayable({ ...world, writes: corrupted }, runId)).rejects.toThrow(
      /re-derived from its own journal/,
    );
  });

  test("a journal missing a step is still re-derivable, and that is the BOUNDARY", async () => {
    // Worth pinning because it is the obvious negative case and it does not
    // fail: drop a step entry and the replay simply does the work again,
    // reaching the same answer and re-journaling the same key. So what this
    // post-condition claims is that the ANSWER is re-derivable, never that the
    // work is not repeated — exactly-once is `workflow-replay.test.ts`'s claim,
    // and the two crash models are what drive it under interruption.
    const work = vi.fn(() => "done");
    const world = unwatchedHarness({ digest: (_input, ctx) => ctx.step("work", work) });
    const runId = await world.engine.start("digest", [{}]);
    await world.engine.execute(runId);

    const shortened = world.writes.filter((write) => write.m !== "appendStep");
    await expectReplayable({ ...world, writes: shortened }, runId);
    expect(work).toHaveBeenCalledTimes(2);
  });

  test("it FAILS when a body reads a clock outside ctx.now", async () => {
    // The documented blind spot, from the other side: an unjournaled read is
    // what makes the post-condition report a difference it cannot attribute, and
    // a spec is the one place `guard-invariants` rule 30 cannot see the body.
    const world = unwatchedHarness({ digest: () => ({ at: Math.random() }) });
    const runId = await world.engine.start("digest", [{}]);
    await world.engine.execute(runId);

    await expect(expectReplayable(world, runId)).rejects.toThrow(/re-derived from its own journal/);
  });
});

describe("rebuildJournal", () => {
  test("reconstructs a run, its steps and its waits from the log alone", async () => {
    const { journal, writes } = recordJournal(createMemoryJournal());
    await journal.createRun(run({ status: "running", input: { topic: "otters" } }));
    await journal.claimAttempt("wrun_1", "work#0", "walk-1", 60 * 60 * 1000);
    await journal.appendStep("wrun_1", step({ output: "done" }));
    await journal.claimSleep("wrun_1", "sleep!0", 5000, "later", "sleep");
    await journal.setStatus("wrun_1", "completed", { output: "done" }, ["running"]);

    const replica = await rebuildJournal(writes);
    expect(await replica.getRun("wrun_1")).toEqual(
      run({ status: "completed", input: { topic: "otters" }, output: "done" }),
    );
    expect(await replica.readSteps("wrun_1")).toEqual([step({ output: "done" })]);
    expect(await replica.claimSleep("wrun_1", "sleep!0", 99_999, undefined)).toEqual({
      wakeAt: 5000,
      woken: false,
      correlationId: "later",
      kind: "sleep",
    });
    // The lease came back too, which is what a divergence check reads.
    expect(await replica.claimAttempt("wrun_1", "work#0", "walk-2", 60 * 60 * 1000)).toBe(2);
  });

  test("replays neither a rejected write nor a compare-and-set that lost", async () => {
    const { journal, writes } = recordJournal(createMemoryJournal());
    await journal.createRun(run({ status: "running" }));
    await expect(journal.appendStep("wrun_nope", step())).rejects.toThrow(/not found/);
    expect(await journal.setStatus("wrun_1", "completed", { output: "a" }, ["pending"])).toBe(
      false,
    );
    expect(await journal.setStatus("wrun_1", "completed", { output: "b" }, ["running"])).toBe(true);

    const replica = await rebuildJournal(writes);
    expect(await replica.getRun("wrun_1")).toMatchObject({ status: "completed", output: "b" });
    expect(await replica.getRun("wrun_nope")).toBeUndefined();
  });

  test("a prefix is the world before that write landed", async () => {
    const { journal, writes } = recordJournal(createMemoryJournal());
    await journal.createRun(run({ status: "running" }));
    await journal.appendStep("wrun_1", step({ output: "done" }));
    await journal.setStatus("wrun_1", "completed", { output: "done" }, ["running"]);

    const before = await rebuildJournal(writes.slice(0, writes.length - 1));
    const record = await before.getRun("wrun_1");
    expect(record?.status).toBe("running");
    // Absent rather than explicitly `undefined`: `setStatus` is the only writer
    // of `output` and this world is the moment before it ran.
    expect(record && "output" in record).toBe(false);
    expect(await before.readSteps("wrun_1")).toHaveLength(1);
  });

  test("keeps a store that cannot enumerate resumable runs unenumerable", async () => {
    // `resumableRuns` is optional, and an absent implementation is a
    // DECLARATION — the boot sweep warns rather than pretending. A wrapper that
    // always defined it would tell the sweep this store can be swept.
    const inner = createMemoryJournal();
    delete inner.resumableRuns;
    expect(recordJournal(inner).journal.resumableRuns).toBeUndefined();
    expect(recordJournal(createMemoryJournal()).journal.resumableRuns).toBeDefined();
  });

  test("does not record a read", async () => {
    const { journal, writes } = recordJournal(createMemoryJournal());
    await journal.createRun(run());
    await journal.getRun("wrun_1");
    await journal.readSteps("wrun_1");
    await journal.listRuns("digest", 10);
    await journal.resumableRuns?.(10);
    expect(writes.map((write) => write.m)).toEqual(["createRun"]);
  });
});

describe("checkJournalInvariants", () => {
  test("says nothing about a healthy log", async () => {
    const world = harness({
      digest: async (_input, ctx) => ctx.step("work", () => "done"),
    });
    const runId = await world.engine.start("digest", [{}]);
    await world.engine.execute(runId);
    expect(checkJournalInvariants(world.writes)).toEqual([]);
  });

  test("catches a run created twice", () => {
    expect(
      checkJournalInvariants([
        { m: "createRun", runId: "wrun_1", record: run() },
        { m: "createRun", runId: "wrun_1", record: run() },
      ]),
    ).toEqual(["run wrun_1 was created twice"]);
  });

  test("does not count a create that was REFUSED as a second create", () => {
    // The healthy shape of two colliding starts: one wins, the other rejects.
    expect(
      checkJournalInvariants([
        { m: "createRun", runId: "wrun_1", record: run() },
        { m: "createRun", runId: "wrun_1", record: run(), threw: "already exists" },
      ]),
    ).toEqual([]);
  });

  test("catches a write that landed before its run existed", () => {
    expect(
      checkJournalInvariants([
        ...opened,
        { m: "appendStep", runId: "wrun_2", entry: step(), stored: step() },
      ]),
    ).toEqual(["appendStep landed on run wrun_2 before its createRun"]);
  });

  test("catches one step key journaled two different ways", () => {
    const first = step({ output: "a" });
    const second = step({ output: "b" });
    expect(
      checkJournalInvariants([
        ...opened,
        { m: "appendStep", runId: "wrun_1", entry: first, stored: first },
        { m: "appendStep", runId: "wrun_1", entry: second, stored: second },
      ]),
    ).toEqual([expect.stringContaining("step wrun_1/work#0 was journaled as")]);
  });

  test("catches a step journaled failed although a walk journaled it ok", () => {
    // The shape of the defect the package guide records: a pre-body attempt
    // ceiling wrote `failed` over a step that then SUCCEEDED, and the successful
    // walk read that failure back out of the idempotent append.
    const failed = step({ status: "failed", error: { message: "exhausted 3 attempt(s)" } });
    expect(
      checkJournalInvariants([
        ...opened,
        { m: "appendStep", runId: "wrun_1", entry: failed, stored: failed },
        { m: "appendStep", runId: "wrun_1", entry: step({ output: "done" }), stored: failed },
      ]),
    ).toEqual([
      "step wrun_1/work#0 is journaled failed (exhausted 3 attempt(s)) although a walk journaled it ok",
    ]);
  });

  test("catches a sleep whose deadline was decided twice", () => {
    expect(
      checkJournalInvariants([
        ...opened,
        {
          m: "claimSleep",
          runId: "wrun_1",
          key: "sleep!0",
          wakeAt: 1000,
          correlationId: undefined,
          kind: "sleep",
          answered: { wakeAt: 1000, woken: false, kind: "sleep" },
        },
        {
          m: "claimSleep",
          runId: "wrun_1",
          key: "sleep!0",
          wakeAt: 61_000,
          correlationId: undefined,
          kind: "sleep",
          answered: { wakeAt: 61_000, woken: false, kind: "sleep" },
        },
      ]),
    ).toEqual([expect.stringContaining("sleep wrun_1/sleep!0 was decided")]);
  });

  test("does not count a woken sleep read back as a re-decision", () => {
    const decided = { wakeAt: 1000, woken: false, kind: "sleep" } as const;
    expect(
      checkJournalInvariants([
        ...opened,
        {
          m: "claimSleep",
          runId: "wrun_1",
          key: "sleep!0",
          wakeAt: 1000,
          correlationId: undefined,
          kind: "sleep",
          answered: decided,
        },
        { m: "wakeSleeps", runId: "wrun_1", correlationIds: undefined, stopped: 1 },
        {
          m: "claimSleep",
          runId: "wrun_1",
          key: "sleep!0",
          wakeAt: 1000,
          correlationId: undefined,
          kind: "sleep",
          answered: { ...decided, woken: true },
        },
      ]),
    ).toEqual([]);
  });

  test("catches a wait that was both delivered and closed", () => {
    expect(
      checkJournalInvariants([
        ...opened,
        {
          m: "claimHook",
          runId: "wrun_1",
          key: "hook!0",
          token: "tok",
          answered: { token: "tok", delivered: false, closed: false },
        },
        { m: "deliverHook", token: "tok", payload: { ok: true }, woke: "wrun_1" },
        { m: "closeHook", runId: "wrun_1", key: "hook!0", closed: true },
      ]),
    ).toEqual(["hook wrun_1/hook!0 was both delivered and closed"]);
  });

  test("does not count a refused close or a refused signal", () => {
    expect(
      checkJournalInvariants([
        ...opened,
        {
          m: "claimHook",
          runId: "wrun_1",
          key: "hook!0",
          token: "tok",
          answered: { token: "tok", delivered: false, closed: false },
        },
        { m: "deliverHook", token: "tok", payload: { ok: true }, woke: "wrun_1" },
        // `closeHook` answering `false` is the compare-and-set refusing, which is
        // the mechanism working rather than a violation.
        { m: "closeHook", runId: "wrun_1", key: "hook!0", closed: false },
        // And a signal nobody holds resolves `undefined`, the ordinary answer.
        { m: "deliverHook", token: "tok", payload: { ok: true }, woke: undefined },
      ]),
    ).toEqual([]);
  });

  test("catches a run moved terminal twice", () => {
    expect(
      checkJournalInvariants([
        ...opened,
        {
          m: "setStatus",
          runId: "wrun_1",
          next: "completed",
          patch: { output: "a" },
          expect: ["running"],
          moved: true,
        },
        {
          m: "setStatus",
          runId: "wrun_1",
          next: "failed",
          patch: { error: { message: "late" } },
          expect: ["running"],
          moved: true,
        },
      ]),
    ).toEqual(["run wrun_1 moved terminal twice — completed then failed"]);
  });

  test("does not count a terminal move that LOST its compare-and-set", () => {
    expect(
      checkJournalInvariants([
        ...opened,
        {
          m: "setStatus",
          runId: "wrun_1",
          next: "completed",
          patch: { output: "a" },
          expect: ["running"],
          moved: true,
        },
        {
          m: "setStatus",
          runId: "wrun_1",
          next: "completed",
          patch: { output: "a" },
          expect: ["running"],
          moved: false,
        },
      ]),
    ).toEqual([]);
  });

  test("reports every violation, not the first", () => {
    const problems = checkJournalInvariants([
      { m: "createRun", runId: "wrun_1", record: run() },
      { m: "createRun", runId: "wrun_1", record: run() },
      { m: "appendStep", runId: "wrun_2", entry: step(), stored: step() },
    ]);
    // The whole reason the checker answers a LIST: under an interleaving the
    // informative violation is rarely the first one.
    expect(problems).toHaveLength(2);
  });
});

describe("the post-condition over the runtime's own suites", () => {
  test("holds for a run that fans out, retries and narrates", async () => {
    const flaky = vi.fn();
    let tries = 0;
    const world = harness({
      digest: async (_input, ctx) => {
        const [a, b] = await Promise.all([ctx.step("a", () => "A"), ctx.step("b", () => "B")]);
        const c = await ctx.step("c", () => {
          flaky();
          tries += 1;
          if (tries === 1) throw new Error("once");
          return "C";
        });
        return [a, b, c];
      },
    });
    const runId = await world.engine.start("digest", [{}]);
    expect(await world.engine.execute(runId)).toBe("completed");
    expect(await world.engine.readOutput(runId)).toEqual(["A", "B", "C"]);

    // The point: replaying the journal re-derives that answer WITHOUT running
    // the flaky body again, which is the exactly-once claim seen from outside.
    const calls = flaky.mock.calls.length;
    await expectReplayable(world, runId);
    expect(flaky.mock.calls.length).toBe(calls);
  });
});
