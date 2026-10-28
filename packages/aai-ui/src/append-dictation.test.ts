// Copyright 2026 the AAI authors. MIT license.
// Where dictated words land: after the draft, one space between, never a
// replacement of what was typed.

import { describe, expect, test } from "vitest";
import { appendDictation } from "./append-dictation.ts";

describe("appendDictation", () => {
  test("joins with exactly one space", () => {
    expect(appendDictation("Build an agent", "that books tables.")).toBe(
      "Build an agent that books tables.",
    );
    expect(appendDictation("Build an agent  \n", " that books tables. ")).toBe(
      "Build an agent that books tables.",
    );
  });

  test("an empty or blank draft is replaced, with no leading space", () => {
    expect(appendDictation("", "Hello")).toBe("Hello");
    expect(appendDictation("   ", "Hello")).toBe("Hello");
  });

  test("nothing said leaves the draft exactly as it was", () => {
    expect(appendDictation("Keep me  ", "  ")).toBe("Keep me  ");
  });
});
