// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createMemoryJournal as createMemoryJournalStore } from "./backends/memory.ts";
import { createMemoryJournal, journalStoreOf, workflowJournal } from "./handle.ts";

describe("WorkflowJournal", () => {
  test("a handle IS its store, so the engine sees exactly what a backend built", () => {
    const store = createMemoryJournalStore();
    expect(journalStoreOf(workflowJournal(store))).toBe(store);
  });

  test("no handle reads as no store, so an absent option stays absent", () => {
    expect(journalStoreOf(undefined)).toBeUndefined();
  });

  test("createMemoryJournal mints a working store per call", async () => {
    const one = journalStoreOf(createMemoryJournal());
    const two = journalStoreOf(createMemoryJournal());
    expect(one).not.toBe(two);
    await one.createRun({
      runId: "r1",
      workflow: "w",
      status: "pending",
      createdAt: 0,
      input: {},
    });
    expect(await one.getRun("r1")).toMatchObject({ runId: "r1", workflow: "w" });
    // Separate worlds: the second journal never saw the run.
    expect(await two.getRun("r1")).toBeUndefined();
  });
});
