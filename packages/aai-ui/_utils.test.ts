// Copyright 2025 the AAI authors. MIT license.

import { afterEach, describe, expect, test, vi } from "vitest";
import { pageBaseUrl, truncate, tryParseJSON } from "./_utils.ts";

describe("tryParseJSON", () => {
  test.each([
    ['{"a":1}', { a: 1 }],
    ["[1,2]", [1, 2]],
    ["42", 42],
    ["0", 0],
    ["false", false],
    ['"quoted"', "quoted"],
  ])("parses %j", (input, expected) => {
    expect(tryParseJSON(input)).toEqual(expected);
  });

  test('JSON "null" comes back as the raw string', () => {
    // `?? str` cannot distinguish a successfully parsed `null` from a parse
    // failure, so this one JSON value round-trips to its source text. Pinned
    // rather than fixed: callers render tool results, where showing "null" is
    // no worse than showing an empty cell, and the alternative is a sentinel.
    expect(tryParseJSON("null")).toBe("null");
  });

  test.each(["not json", "{unclosed", "", undefined])(
    "returns %j unchanged when it is not JSON",
    (input) => {
      // Tool results arrive as strings that may or may not be JSON, so the
      // input has to survive a failed parse rather than becoming undefined.
      expect(tryParseJSON(input)).toBe(input);
    },
  );

  test("preserves falsy parsed values rather than falling back", () => {
    // `0` and `false` are the values a plain `||` fallback would have eaten.
    expect(tryParseJSON("0")).toBe(0);
    expect(tryParseJSON("false")).toBe(false);
  });
});

describe("truncate", () => {
  test("leaves a string shorter than the limit alone", () => {
    expect(truncate("short", 80)).toBe("short");
  });

  test("leaves a string exactly at the limit alone", () => {
    // The boundary: `max` is how many characters are allowed, so a string of
    // exactly that length is not cut — and gains no ellipsis.
    const exact = "a".repeat(80);
    expect(truncate(exact, 80)).toBe(exact);
    expect(truncate(exact, 80)).not.toContain("...");
  });

  test("cuts one character over the limit and marks it", () => {
    expect(truncate("a".repeat(81), 80)).toBe(`${"a".repeat(80)}...`);
  });

  test("defaults to 80 characters", () => {
    expect(truncate("a".repeat(80))).toHaveLength(80);
    expect(truncate("a".repeat(81))).toBe(`${"a".repeat(80)}...`);
  });

  test("handles an empty string and a zero limit", () => {
    expect(truncate("", 10)).toBe("");
    expect(truncate("ab", 0)).toBe("...");
  });
});

describe("pageBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("joins the page origin and path", () => {
    vi.stubGlobal("location", { origin: "https://agent.example", pathname: "/demo/" });
    expect(pageBaseUrl()).toBe("https://agent.example/demo/");
  });

  test("drops the query and hash by construction", () => {
    // Only origin + pathname are read, so a shareable URL never carries the
    // current page's parameters.
    vi.stubGlobal("location", {
      origin: "https://agent.example",
      pathname: "/demo",
      search: "?sessionId=abc",
      hash: "#x",
    });
    expect(pageBaseUrl()).toBe("https://agent.example/demo");
  });

  test("returns an empty string off-document", () => {
    // The module is imported in non-browser contexts (SSR, tests, the
    // default-client build), where touching `location` would throw.
    vi.stubGlobal("location", undefined);
    expect(pageBaseUrl()).toBe("");
  });
});
