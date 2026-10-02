// Copyright 2026 the AAI authors. MIT license.
// The journal interface's two runtime helpers.

import { describe, expect, test } from "vitest";
import { createMemoryJournal } from "./backends/memory.ts";
import { isResumableJournal, isTerminalStatus, type JournalStore } from "./types.ts";

describe("isTerminalStatus", () => {
  test.each([
    ["completed", true],
    ["failed", true],
    ["cancelled", true],
    ["running", false],
    ["pending", false],
  ] as const)("%s → %s", (status, terminal) => {
    expect(isTerminalStatus(status)).toBe(terminal);
  });
});

describe("isResumableJournal", () => {
  test("a store with resumableRuns is resumable; one without is not", () => {
    const memory = createMemoryJournal();
    expect(isResumableJournal(memory)).toBe(true);
    const plain: JournalStore = { ...memory, resumableRuns: undefined };
    expect(isResumableJournal(plain)).toBe(false);
  });
});
