// Copyright 2026 the AAI authors. MIT license.
/**
 * The run's timing on the memory journal: `startedAt` is first-write-wins and
 * `settledAt` rides the terminal write — `RunStatusPatch`.
 */

import { describe, expect, test } from "vitest";
import { createMemoryJournal } from "./memory.ts";

describe("setStatus timing", () => {
  test("keeps the FIRST startedAt across re-announcements, and writes settledAt", async () => {
    const journal = createMemoryJournal();
    await journal.createRun({
      runId: "r",
      workflow: "w",
      status: "pending",
      createdAt: 1,
      input: {},
    });
    expect(await journal.setStatus("r", "running", { startedAt: 10 }, ["pending", "running"])).toBe(
      true,
    );
    expect(await journal.setStatus("r", "running", { startedAt: 20 }, ["pending", "running"])).toBe(
      true,
    );
    expect(await journal.getRun("r")).toMatchObject({ status: "running", startedAt: 10 });
    expect(await journal.getRun("r")).not.toHaveProperty("settledAt");
    await journal.setStatus("r", "completed", { output: 1, settledAt: 30 }, ["running"]);
    expect(await journal.getRun("r")).toMatchObject({
      status: "completed",
      output: 1,
      startedAt: 10,
      settledAt: 30,
    });
  });

  test("a patch naming neither leaves both absent", async () => {
    const journal = createMemoryJournal();
    await journal.createRun({
      runId: "r",
      workflow: "w",
      status: "pending",
      createdAt: 1,
      input: {},
    });
    await journal.setStatus("r", "running");
    const run = await journal.getRun("r");
    expect(run).not.toHaveProperty("startedAt");
    expect(run).not.toHaveProperty("settledAt");
  });
});
