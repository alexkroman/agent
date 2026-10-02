// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { emptyDump, sortTenantDump, type TenantDump } from "./_tenancy-ops-harness.ts";

const run = (runId: string): TenantDump["runs"][number] => ({
  runId,
  workflow: "wf",
  status: "pending",
  createdAt: 1,
  input: undefined,
  output: undefined,
  error: undefined,
});

describe("the tenancy vocabulary", () => {
  test("an empty dump has every table, and each is empty", () => {
    expect(emptyDump()).toEqual({
      runs: [],
      steps: [],
      attempts: [],
      sleeps: [],
      hooks: [],
      uploads: [],
      slots: [],
      events: [],
    });
    // A fresh value each call, so two arms never share one by accident.
    expect(emptyDump()).not.toBe(emptyDump());
  });

  test("sortTenantDump orders by code unit, not by locale, and by the full key", () => {
    const dump: TenantDump = {
      ...emptyDump(),
      // `!` (0x21) sorts before `_` (0x5f) by code unit; a collation can disagree.
      runs: [run("wf_r0"), run("wf!r0")],
      slots: [
        { sessionId: "s2", slot: "a", value: "1" },
        { sessionId: "s1", slot: "b", value: "2" },
        { sessionId: "s1", slot: "a", value: "3" },
      ],
      events: [
        { sessionId: "s1", index: 10, event: "x" },
        { sessionId: "s1", index: 2, event: "y" },
      ],
    };
    const sorted = sortTenantDump(dump);
    expect(sorted.runs.map((r) => r.runId)).toEqual(["wf!r0", "wf_r0"]);
    expect(sorted.slots.map((s) => `${s.sessionId}/${s.slot}`)).toEqual(["s1/a", "s1/b", "s2/a"]);
    // Numerically, so 2 precedes 10.
    expect(sorted.events.map((e) => e.index)).toEqual([2, 10]);
  });

  test("sortTenantDump does not mutate its input", () => {
    const dump: TenantDump = { ...emptyDump(), runs: [run("b"), run("a")] };
    sortTenantDump(dump);
    expect(dump.runs.map((r) => r.runId)).toEqual(["b", "a"]);
  });
});
