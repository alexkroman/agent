// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { requestPath, requestQuery } from "./request-url.ts";

describe("requestPath", () => {
  test.each([
    ["/runs/abc?wait=5", "/runs/abc"],
    ["/runs/abc", "/runs/abc"],
    ["/?a=1", "/"],
    ["?a=1", ""],
  ])("%s -> %s", (raw, expected) => {
    expect(requestPath(raw)).toBe(expected);
  });

  // `http.IncomingMessage.url` is optional, and an origin-form target with no
  // path means the root — which is what the four different dead `?? "/"` /
  // `?? ""` fallbacks this replaced were all reaching for.
  test.each([undefined, ""])("%s answers the root", (raw) => {
    expect(requestPath(raw)).toBe("/");
  });
});

describe("requestQuery", () => {
  test("reads a parameter", () => {
    expect(requestQuery("/runs?wait=5").get("wait")).toBe("5");
  });

  // The bug the one spelling exists to remove. `split("?")[1]` keeps only the
  // segment BETWEEN the first and second `?`, so this answered `a` — silently,
  // at five of the six sites that parsed a query in this package.
  test("keeps a value that itself contains a question mark", () => {
    expect(requestQuery("/runs?namespace=a?b").get("namespace")).toBe("a?b");
  });

  test.each([undefined, "", "/runs", "/runs?"])("%s parses as empty", (raw) => {
    expect([...requestQuery(raw)]).toEqual([]);
  });
});
