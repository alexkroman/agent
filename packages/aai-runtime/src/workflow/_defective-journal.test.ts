// Copyright 2026 the AAI authors. MIT license.
// Each defect removes exactly ONE guard: the healthy store refuses, the
// defective one does not — and every other method is the inner store's.

import { describe, expect, test } from "vitest";
import { defectiveJournal } from "./_defective-journal.ts";
import { createMemoryJournal } from "./journal/backends/memory.ts";
import type { JournalStore, RunRecord, StepEntry } from "./journal/types.ts";

const RUN: RunRecord = {
  runId: "wrun_1",
  workflow: "w",
  status: "running",
  createdAt: 0,
  input: null,
};

function step(output: unknown): StepEntry {
  return {
    key: "s0#0",
    name: "s0",
    status: "ok",
    output,
    attempts: 1,
    startedAt: 0,
    finishedAt: 0,
  };
}

async function withRun(store: JournalStore): Promise<JournalStore> {
  await store.createRun(RUN);
  return store;
}

describe("defectiveJournal", () => {
  test("silentDuplicateCreate accepts a second create on a taken id", async () => {
    const healthy = await withRun(createMemoryJournal());
    await expect(healthy.createRun(RUN)).rejects.toThrow();
    const defective = await withRun(
      defectiveJournal(createMemoryJournal(), "silentDuplicateCreate"),
    );
    await expect(defective.createRun({ ...RUN, input: "loser" })).resolves.toBeUndefined();
  });

  test("unconditionalClose reports a close over an already-answered hook", async () => {
    const answered = async (store: JournalStore) => {
      await withRun(store);
      await store.claimHook("wrun_1", "hook!t#0", "t");
      await store.deliverHook("t", { ok: true });
      return store.closeHook("wrun_1", "hook!t#0");
    };
    await expect(answered(createMemoryJournal())).resolves.toBe(false);
    await expect(
      answered(defectiveJournal(createMemoryJournal(), "unconditionalClose")),
    ).resolves.toBe(true);
  });

  test("overwritingAppend answers the LATE entry instead of the one that won", async () => {
    const append = async (store: JournalStore) => {
      await withRun(store);
      await store.appendStep("wrun_1", step("first"));
      return (await store.appendStep("wrun_1", step("second"))).output;
    };
    await expect(append(createMemoryJournal())).resolves.toBe("first");
    await expect(
      append(defectiveJournal(createMemoryJournal(), "overwritingAppend")),
    ).resolves.toBe("second");
  });

  test("unguardedStatus lets a terminal move ignore the compare-and-set", async () => {
    const complete = async (store: JournalStore) => {
      await withRun(store);
      await store.setStatus("wrun_1", "cancelled");
      return store.setStatus("wrun_1", "completed", {}, ["running"]);
    };
    await expect(complete(createMemoryJournal())).resolves.toBe(false);
    await expect(
      complete(defectiveJournal(createMemoryJournal(), "unguardedStatus")),
    ).resolves.toBe(true);
  });

  test("every other method is the inner store's own", () => {
    const inner = createMemoryJournal();
    const defective = defectiveJournal(inner, "unguardedStatus");
    expect(defective.readSteps).toBe(inner.readSteps);
    expect(defective.createRun).toBe(inner.createRun);
  });
});
