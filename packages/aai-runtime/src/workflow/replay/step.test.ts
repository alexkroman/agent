// Copyright 2026 the AAI authors. MIT license.
// `runStepAttempts` over a real memory journal: what one step journals for a
// success, a retried failure and a fatal one — and `stepFailure`, the replay
// side of a failed entry.

import { FatalError } from "@alexkroman1/aai/step-errors";
import { describe, expect, test, vi } from "vitest";
import { createMemoryJournal } from "../journal/backends/memory.ts";
import type { JournalStore, StepEntry } from "../journal/types.ts";
import type { StepGate } from "../step-gate.ts";
import { runStepAttempts, type StepAttemptOptions, stepFailure } from "./step.ts";

async function journalWithRun(): Promise<JournalStore> {
  const journal = createMemoryJournal();
  await journal.createRun({
    runId: "wrun_1",
    workflow: "digest",
    status: "running",
    createdAt: 0,
    input: null,
  });
  return journal;
}

function options(journal: JournalStore, fn: () => unknown, over: Partial<StepAttemptOptions> = {}) {
  return {
    runId: "wrun_1",
    name: "fetch",
    key: "s0#0",
    maxAttempts: 3,
    journal,
    holder: "walk_a",
    signal: undefined,
    gate: undefined,
    fn,
    ...over,
  } satisfies StepAttemptOptions;
}

describe("runStepAttempts", () => {
  test("a step that returns journals an ok entry with its output", async () => {
    const journal = await journalWithRun();
    const onFirstReach = vi.fn();
    const entry = await runStepAttempts(options(journal, () => ({ n: 1 }), { onFirstReach }));
    expect(entry).toMatchObject({ key: "s0#0", status: "ok", output: { n: 1 }, attempts: 1 });
    await expect(journal.readStep("wrun_1", "s0#0")).resolves.toMatchObject({ status: "ok" });
    expect(onFirstReach).toHaveBeenCalledTimes(1);
  });

  test("an ordinary throw is retried, and a later success records the try it took", async () => {
    const journal = await journalWithRun();
    const fn = vi.fn().mockRejectedValueOnce(new Error("flaky")).mockResolvedValueOnce("ok");
    const entry = await runStepAttempts(options(journal, fn));
    expect(fn).toHaveBeenCalledTimes(2);
    expect(entry).toMatchObject({ status: "ok", output: "ok", attempts: 2 });
  });

  test("a step that never succeeds journals a failure after maxAttempts", async () => {
    const journal = await journalWithRun();
    const fn = vi.fn(async () => {
      throw new Error("still down");
    });
    const entry = await runStepAttempts(options(journal, fn, { maxAttempts: 2 }));
    expect(fn).toHaveBeenCalledTimes(2);
    expect(entry).toMatchObject({
      status: "failed",
      error: { message: "still down" },
      attempts: 2,
    });
  });

  test("a FatalError is not retried", async () => {
    const journal = await journalWithRun();
    const fn = vi.fn(async () => {
      throw new FatalError("bad input");
    });
    const entry = await runStepAttempts(options(journal, fn));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(entry).toMatchObject({ status: "failed", attempts: 1 });
  });

  test("an aborted walk runs nothing and journals nothing", async () => {
    const journal = await journalWithRun();
    const fn = vi.fn();
    const signal = AbortSignal.abort(new Error("cancelled"));
    await expect(runStepAttempts(options(journal, fn, { signal }))).rejects.toThrow("cancelled");
    expect(fn).not.toHaveBeenCalled();
    await expect(journal.readStep("wrun_1", "s0#0")).resolves.toBeUndefined();
  });

  test("a gate wraps the whole attempt loop", async () => {
    const journal = await journalWithRun();
    // A plain generic function: `vi.fn` fixes the generic and no longer fits `StepGate`.
    const entered = vi.fn();
    const gate: StepGate = (run) => {
      entered();
      return run();
    };
    await runStepAttempts(options(journal, () => 1, { gate }));
    expect(entered).toHaveBeenCalledTimes(1);
  });
});

describe("stepFailure", () => {
  const failed: StepEntry = {
    key: "s0#0",
    name: "fetch",
    status: "failed",
    attempts: 3,
    startedAt: 0,
    finishedAt: 1,
  };

  test("rebuilds a FatalError from the journaled message, so a replay does not retry it", () => {
    const err = stepFailure({ ...failed, error: { message: "still down" } });
    expect(FatalError.is(err)).toBe(true);
    expect(err.message).toBe("still down");
  });

  test("names the step when the entry carries no message", () => {
    expect(stepFailure(failed).message).toBe("step fetch failed");
  });
});
