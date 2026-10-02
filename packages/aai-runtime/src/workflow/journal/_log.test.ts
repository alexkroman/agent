// Copyright 2026 the AAI authors. MIT license.
/**
 * `rebuildJournal` and `recordJournal`: a world reconstructed from its write log
 * alone, which is what the engine harness's post-condition replays against.
 *
 * Split out of the former `journal/log.test.ts`; the post-condition itself is
 * `../_engine-harness.test.ts` and the derived invariants `_invariants.test.ts`.
 */

import { describe, expect, test } from "vitest";
import { rebuildJournal, recordJournal } from "./_log.ts";
import { createMemoryJournal } from "./backends/memory.ts";
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
