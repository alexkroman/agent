// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { createProgressStream, createRunSnapshot } from "./testing-workflows.ts";
import { isTerminal } from "./workflow-run.ts";

describe("createRunSnapshot", () => {
  test("defaults to a running run — what a tool that just started one reads back", () => {
    const run = createRunSnapshot();
    expect(run.status).toBe("running");
    expect(isTerminal(run)).toBe(false);
  });

  test("carries the identity fields a spec does not care to name", () => {
    expect(createRunSnapshot()).toEqual({
      runId: "wrun_1",
      workflow: "workflow",
      createdAt: Date.UTC(2026, 0, 1),
      status: "running",
    });
  });

  test("a completed run narrows to its output without a cast", () => {
    const run = createRunSnapshot({ status: "completed", output: { sources: 3 } });
    // The property under test: `output` is reachable after narrowing, which is
    // what the hand-rolled `as WorkflowRunSnapshot` fixtures gave up.
    expect(run.status === "completed" && run.output.sources).toBe(3);
  });

  test("a failed run narrows to its error", () => {
    const run = createRunSnapshot({ status: "failed", error: "gateway down" });
    expect(run.status === "failed" && run.error).toBe("gateway down");
  });

  test("a cancelled run is terminal and carries neither output nor error", () => {
    const run = createRunSnapshot({ status: "cancelled" });
    expect(isTerminal(run)).toBe(true);
    expect(run).toEqual({
      runId: "wrun_1",
      workflow: "workflow",
      createdAt: Date.UTC(2026, 0, 1),
      status: "cancelled",
    });
  });

  test("overrides the base fields, and omits `key` rather than setting it undefined", () => {
    expect(createRunSnapshot({ runId: "wrun_9", workflow: "recap", createdAt: 7 })).toEqual({
      runId: "wrun_9",
      workflow: "recap",
      createdAt: 7,
      status: "running",
    });
    expect("key" in createRunSnapshot()).toBe(false);
    expect(createRunSnapshot({ key: "caller-1" }).key).toBe("caller-1");
  });

  test("an explicitly pending run stays pending", () => {
    expect(createRunSnapshot({ status: "pending" }).status).toBe("pending");
  });
});

describe("createProgressStream", () => {
  test("yields the lines and then closes, so a drain terminates", async () => {
    const seen: unknown[] = [];
    for await (const line of createProgressStream(["one", "two"])) seen.push(line);
    expect(seen).toEqual(["one", "two"]);
  });

  test("an empty stream closes immediately", async () => {
    const seen: unknown[] = [];
    for await (const line of createProgressStream()) seen.push(line);
    expect(seen).toEqual([]);
  });
});
