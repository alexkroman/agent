// Copyright 2026 the AAI authors. MIT license.
// The journal's sort orders: each primary key, and the code-unit tiebreak that
// makes every arm agree on an order the primary key leaves open.

import { describe, expect, test } from "vitest";
import { codeUnit, newestFirst, settledFirst, soonestFirst } from "./_order.ts";
import type { RunRecord, StepEntry } from "./types.ts";

function step(key: string, finishedAt: number): StepEntry {
  return { key, name: key, status: "ok", attempts: 1, startedAt: 0, finishedAt };
}

function runRecord(runId: string, createdAt: number): RunRecord {
  return { runId, workflow: "w", status: "running", createdAt, input: null };
}

describe("codeUnit", () => {
  test("compares by UTF-16 code unit, not by locale", () => {
    // "Z" (0x5A) sorts before "a" (0x61) by code unit; a locale compare disagrees.
    expect(["a", "Z", "b"].sort(codeUnit)).toEqual(["Z", "a", "b"]);
    expect(codeUnit("x", "x")).toBe(0);
  });
});

describe("soonestFirst", () => {
  test("orders by wake time, an absent one first, then by run id", () => {
    const runs = [
      { runId: "wrun_b", wakeAt: 5 },
      { runId: "wrun_c" },
      { runId: "wrun_a", wakeAt: 5 },
    ];
    expect(runs.sort(soonestFirst).map((run) => run.runId)).toEqual(["wrun_c", "wrun_a", "wrun_b"]);
  });
});

describe("settledFirst", () => {
  test("orders by finish time, ties by key", () => {
    const steps = [step("s2", 10), step("s1", 10), step("s0", 20)];
    expect(steps.sort(settledFirst).map((s) => s.key)).toEqual(["s1", "s2", "s0"]);
  });
});

describe("newestFirst", () => {
  test("orders by creation time descending, ties by run id descending", () => {
    const runs = [runRecord("wrun_a", 1), runRecord("wrun_b", 2), runRecord("wrun_c", 2)];
    expect(runs.sort(newestFirst).map((r) => r.runId)).toEqual(["wrun_c", "wrun_b", "wrun_a"]);
  });
});
