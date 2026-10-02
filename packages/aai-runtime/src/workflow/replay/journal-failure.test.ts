// Copyright 2026 the AAI authors. MIT license.
// `watchJournalFailure`: every journal rejection is remembered (the first one),
// rethrown unchanged, and a conflict passes through unremembered.

import { describe, expect, test } from "vitest";
import { createMemoryJournal } from "../journal/backends/memory.ts";
import { JournalConflictError, type JournalStore } from "../journal/types.ts";
import { watchJournalFailure } from "./journal-failure.ts";

function failingWith(errors: unknown[]): JournalStore {
  const memory = createMemoryJournal();
  return {
    ...memory,
    getRun: async () => {
      throw errors.shift();
    },
  };
}

describe("watchJournalFailure", () => {
  test("a healthy journal reports no failure and answers as itself", async () => {
    const watch = watchJournalFailure(createMemoryJournal());
    await expect(watch.journal.getRun("wrun_none")).resolves.toBeUndefined();
    expect(watch.failure()).toBeUndefined();
  });

  test("a store failure is rethrown and the FIRST one is remembered", async () => {
    const first = new Error("socket reset");
    const watch = watchJournalFailure(failingWith([first, new Error("pool exhausted")]));
    await expect(watch.journal.getRun("wrun_1")).rejects.toBe(first);
    await expect(watch.journal.getRun("wrun_1")).rejects.toThrow("pool exhausted");
    expect(watch.failure()).toBe(first);
  });

  test("a conflict is the run's verdict, not the store failing: passed through, not remembered", async () => {
    const conflict = new JournalConflictError("token held by another run");
    const watch = watchJournalFailure(failingWith([conflict]));
    await expect(watch.journal.getRun("wrun_1")).rejects.toBe(conflict);
    expect(watch.failure()).toBeUndefined();
  });

  test("resumableRuns is wrapped only when the store has one", () => {
    const memory = createMemoryJournal();
    expect(watchJournalFailure(memory).journal.resumableRuns).toBeTypeOf("function");
    expect(watchJournalFailure({ ...memory, resumableRuns: undefined }).journal).not.toHaveProperty(
      "resumableRuns",
    );
  });
});
