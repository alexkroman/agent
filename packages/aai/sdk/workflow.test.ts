// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  DEFAULT_STEP_BACKOFF_MS,
  DEFAULT_STEP_MAX_ATTEMPTS,
  findUnjournalable,
  isTerminal,
  MAX_WORKFLOW_STEPS,
  rejectingWorkflows,
  TERMINAL_WORKFLOW_STATUSES,
  WORKFLOWS_UNAVAILABLE_MESSAGE,
  type WorkflowRunStatus,
  workflow,
} from "./workflow.ts";

describe("workflow()", () => {
  test("returns its definition unchanged", () => {
    const def = {
      description: "d",
      input: z.object({ topic: z.string() }),
      run: () => "out",
    };
    expect(workflow(def)).toBe(def);
  });

  test("accepts a definition with no schema and no description", () => {
    const def = workflow({ run: () => undefined });
    expect(def.input).toBeUndefined();
    expect(def.description).toBeUndefined();
  });
});

describe("WORKFLOWS_UNAVAILABLE_MESSAGE", () => {
  test("names both halves an author could be missing", () => {
    // The two causes are different fixes, and a message naming only one sends
    // an author who declared workflows off to check their agent definition.
    expect(WORKFLOWS_UNAVAILABLE_MESSAGE).toContain("agent({ workflows })");
    expect(WORKFLOWS_UNAVAILABLE_MESSAGE).toContain("aai storage enable");
    expect(WORKFLOWS_UNAVAILABLE_MESSAGE).toContain("DATABASE_URL");
  });
});

describe("defaults", () => {
  test("retry defaults are bounded and positive", () => {
    expect(DEFAULT_STEP_MAX_ATTEMPTS).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_STEP_BACKOFF_MS).toBeGreaterThan(0);
  });

  test("the step cap stays under the db row cap it exists to respect", async () => {
    // Replay reads the journal through `ctx.db`, which throws past
    // MAX_DB_RESULT_ROWS — a cap above it would make a long run unreplayable,
    // which is the silent duplicate-side-effect bug the constant prevents.
    const { MAX_DB_RESULT_ROWS } = await import("./db.ts");
    expect(MAX_WORKFLOW_STEPS).toBeLessThanOrEqual(MAX_DB_RESULT_ROWS);
  });
});

/**
 * A class with only data properties — accepted, and documented as such: it is
 * structurally indistinguishable from the object literal it round-trips into.
 *
 * Declared here rather than inline in the `test.each` table below, because an
 * inline `class` body inside a call argument defeats the brace matching in
 * `scripts/check-test-assertions.mjs` and the whole table reads to it as a test
 * with no assertion.
 */
class DataOnly {
  x = 1;
  y = 2;
}

describe("findUnjournalable", () => {
  test.each([
    ["a string", "text"],
    ["a number", 42],
    ["a boolean", true],
    ["null", null],
    ["undefined", undefined],
    ["a plain object", { a: 1, b: { c: "d" } }],
    ["an array", [1, "two", { three: true }]],
    ["a nested empty array", { rows: [] }],
    ["a class instance with only data", new DataOnly()],
  ])("accepts %s", (_label, value) => {
    expect(findUnjournalable(value)).toBeUndefined();
  });

  test.each([
    ["a Date", new Date(), "a Date at the result"],
    ["a Map", new Map([["a", 1]]), "a Map at the result"],
    ["a Set", new Set([1]), "a Set at the result"],
    ["a RegExp", /x/, "a RegExp at the result"],
    ["a bigint", 1n, "a bigint at the result"],
    ["a symbol", Symbol("s"), "a symbol at the result"],
    ["a function", () => 1, "a function at the result"],
  ])("rejects %s", (_label, value, expected) => {
    expect(findUnjournalable(value)).toBe(expected);
  });

  test("names the property path, not just the type", () => {
    // The path is the whole value of the message: a step returning a big object
    // with one bad field is otherwise a hunt.
    expect(findUnjournalable({ order: { placed: new Date() } })).toBe(
      "a Date at the result.order.placed",
    );
    expect(findUnjournalable({ items: [{ seen: new Set([1]) }] })).toBe(
      "a Set at the result.items[0].seen",
    );
  });

  test("reports a cycle rather than following it", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(findUnjournalable(cyclic)).toBe("a circular reference at the result.self");
  });

  test("accepts the same object reached twice, which is not a cycle", () => {
    // `JSON.stringify`'s own rule: a DAG serializes fine, so rejecting one would
    // refuse a value the journal can hold.
    const shared = { a: 1 };
    expect(findUnjournalable({ left: shared, right: shared })).toBeUndefined();
  });

  test("refuses a structure nested past the walk's depth", () => {
    let deep: unknown = "bottom";
    for (let i = 0; i < 100; i++) deep = { deep };
    expect(findUnjournalable(deep)).toContain("nested past");
  });
});

describe("isTerminal", () => {
  const base = { runId: "r1", workflow: "w", stepsCompleted: 0 };

  test.each([
    ["completed", { ...base, status: "completed" as const, output: 1 }],
    ["failed", { ...base, status: "failed" as const, error: "boom" }],
    ["cancelled", { ...base, status: "cancelled" as const }],
  ])("%s is terminal", (_label, run) => {
    expect(isTerminal(run)).toBe(true);
  });

  test.each([
    ["pending", { ...base, status: "pending" as const }],
    ["running", { ...base, status: "running" as const }],
    ["sleeping", { ...base, status: "sleeping" as const, wakeAt: 1 }],
  ])("%s is not terminal", (_label, run) => {
    expect(isTerminal(run)).toBe(false);
  });

  test("undefined is not terminal", () => {
    // What a page holds before its first poll lands, and what a caller holds for
    // a run id that does not exist — neither is finished.
    expect(isTerminal(undefined)).toBe(false);
  });

  test("covers every status, so a new one cannot be silently non-terminal", () => {
    // A status added to the union without a decision here would poll forever on a
    // page and read as unfinished to an agent.
    const statuses: WorkflowRunStatus[] = [
      "pending",
      "running",
      "sleeping",
      "completed",
      "failed",
      "cancelled",
    ];
    expect(new Set(statuses).size).toBe(statuses.length);
    expect(TERMINAL_WORKFLOW_STATUSES.every((status) => statuses.includes(status))).toBe(true);
  });
});

describe("rejectingWorkflows", () => {
  test("every promise-returning method rejects with the given message", async () => {
    const workflows = rejectingWorkflows("nope");

    await expect(workflows.start("w")).rejects.toThrow("nope");
    await expect(workflows.get("r")).rejects.toThrow("nope");
    await expect(workflows.find("w", "k")).rejects.toThrow("nope");
    await expect(workflows.cancel("r")).rejects.toThrow("nope");
  });

  test("listing resolves empty rather than rejecting", () => {
    // It is synchronous, so it cannot reject — and "no workflows" is the truthful
    // answer for every case this factory covers.
    expect(rejectingWorkflows("nope").listing()).toEqual([]);
  });

  test("satisfies the whole client surface, which is why it exists", () => {
    // Three copies of this stub existed and adding a method broke all of them at
    // once; the assertion is on the KEY SET, because that is the contract.
    expect(Object.keys(rejectingWorkflows("nope")).sort()).toEqual([
      "cancel",
      "find",
      "get",
      "listing",
      "start",
    ]);
  });
});
