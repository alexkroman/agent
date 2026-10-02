// Copyright 2026 the AAI authors. MIT license.
// The effect tally and the journal outcome the resume harnesses compare.

import { describe, expect, test } from "vitest";
import { byCodeUnit, createTally, journalOutcome } from "./_tally-harness.ts";
import { createMemoryJournal } from "./journal/backends/memory.ts";

describe("createTally", () => {
  test("counts effects per name and in total, numbering each start", () => {
    const tally = createTally();
    expect(tally.counted.count("charge")).toBe(1);
    expect(tally.counted.count("email")).toBe(2);
    expect(tally.counted.count("charge")).toBe(3);
    expect(tally.counted.runs("charge")).toBe(2);
    expect(tally.counted.runs("never")).toBe(0);
    expect(tally.total).toBe(3);
    expect(tally.snapshot()).toEqual({ charge: 2, email: 1 });
  });
});

describe("journalOutcome", () => {
  test("reads the run's verdict and its step keys in code-unit order", async () => {
    const journal = createMemoryJournal();
    await journal.createRun({
      runId: "wrun_1",
      workflow: "w",
      status: "running",
      createdAt: 0,
      input: null,
    });
    for (const key of ["b#0", "B#0", "a#0"]) {
      await journal.appendStep("wrun_1", {
        key,
        name: key,
        status: "ok",
        attempts: 1,
        startedAt: 0,
        finishedAt: 0,
      });
    }
    await journal.setStatus("wrun_1", "failed", { error: { message: "boom" } });
    const tally = createTally();
    tally.counted.count("x");
    await expect(journalOutcome(journal, "wrun_1", tally)).resolves.toEqual({
      status: "failed",
      output: undefined,
      error: "boom",
      keys: ["B#0", "a#0", "b#0"],
      counts: { x: 1 },
      total: 1,
    });
  });

  test("a run that does not exist reads as an empty outcome", async () => {
    const outcome = await journalOutcome(createMemoryJournal(), "wrun_none", createTally());
    expect(outcome).toMatchObject({ status: undefined, keys: [], total: 0 });
  });
});

test("byCodeUnit is not a locale compare", () => {
  expect(["b", "B", "a"].sort(byCodeUnit)).toEqual(["B", "a", "b"]);
});
