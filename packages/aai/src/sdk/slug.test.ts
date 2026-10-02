// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { MAX_SLUG_LENGTH, PREVIEW_SLUG_SUFFIX, RESERVED_SLUGS, VALID_SLUG_RE } from "./slug.ts";

describe("VALID_SLUG_RE", () => {
  test.each(["ab", "my-agent", "my_agent", "agent2", "0x"])("accepts %j", (slug) => {
    expect(VALID_SLUG_RE.test(slug)).toBe(true);
  });

  test.each([
    ["a", "one character"],
    ["My-Agent", "uppercase"],
    ["-agent", "a leading separator"],
    ["agent_", "a trailing separator"],
    ["my agent", "a space"],
    ["café", "a non-ASCII letter"],
  ])("rejects %j (%s)", (slug) => {
    expect(VALID_SLUG_RE.test(slug)).toBe(false);
  });

  test("MAX_SLUG_LENGTH is exactly the longest slug the pattern accepts", () => {
    expect(VALID_SLUG_RE.test("a".repeat(MAX_SLUG_LENGTH))).toBe(true);
    expect(VALID_SLUG_RE.test("a".repeat(MAX_SLUG_LENGTH + 1))).toBe(false);
  });
});

describe("RESERVED_SLUGS", () => {
  test("holds the top-level platform routes", () => {
    expect([...RESERVED_SLUGS].sort()).toEqual([
      "deploy",
      "health",
      "metrics",
      "studio",
      "studio-assets",
    ]);
  });

  test("is made of names the pattern would otherwise accept — that is why they need reserving", () => {
    for (const slug of RESERVED_SLUGS) expect(VALID_SLUG_RE.test(slug), slug).toBe(true);
  });
});

describe("PREVIEW_SLUG_SUFFIX", () => {
  test("keeps a project's preview slug valid", () => {
    expect(VALID_SLUG_RE.test(`my-project${PREVIEW_SLUG_SUFFIX}`)).toBe(true);
    expect(PREVIEW_SLUG_SUFFIX).toBe("-preview");
  });
});
