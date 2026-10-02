// Copyright 2026 the AAI authors. MIT license.
/**
 * Every derived journal invariant FIRES, each on a hand-written log that breaks
 * exactly one of them, and none of them fires on a healthy log — a check that
 * reports success by printing nothing has to be shown failing.
 *
 * Split out of the former `journal/log.test.ts`; the post-condition that runs
 * these on every engine spec's teardown is `../_engine-harness.test.ts`.
 */

import { describe, expect, test } from "vitest";
import { harness } from "../_engine-harness.ts";
import { checkJournalInvariants } from "./_invariants.ts";
import type { JournalWrite } from "./_log.ts";
import type { RunRecord, StepEntry } from "./types.ts";

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
  return {
    key: "work#0",
    name: "work",
    status: "ok",
    attempts: 1,
    startedAt: 1,
    finishedAt: 1,
    ...over,
  };
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
