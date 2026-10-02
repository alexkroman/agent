// Copyright 2026 the AAI authors. MIT license.
// The project kinds and the guard a stored document's `kind` is read
// through (studio-project-kind.ts).

import { describe, expect, test } from "vitest";
import { isProjectKind, PROJECT_KINDS } from "./studio-project-kind.ts";

describe("PROJECT_KINDS", () => {
  test("is the switcher's two positions, voice agent first", () => {
    expect(PROJECT_KINDS).toEqual(["agent", "workflow"]);
  });
});

describe("isProjectKind", () => {
  test.each(PROJECT_KINDS)("accepts %s", (kind) => {
    expect(isProjectKind(kind)).toBe(true);
  });

  // A `kind` read from a row is a claim: anything else reads as malformed,
  // never as a default.
  test.each([
    ["a missing kind", undefined],
    ["null", null],
    ["an unknown name", "voice"],
    ["a different case", "Agent"],
    ["a non-string", 0],
    ["an array holding a kind", ["agent"]],
  ])("refuses %s", (_label, value) => {
    expect(isProjectKind(value)).toBe(false);
  });
});
