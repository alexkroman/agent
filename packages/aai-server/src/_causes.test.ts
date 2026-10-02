// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { causes } from "./_causes.ts";

describe("causes", () => {
  test("walks the cause chain outermost first", () => {
    const inner = new Error("inner");
    const outer = new Error("outer", { cause: inner });
    expect([...causes(outer)]).toEqual([outer, inner]);
  });

  test("stops at a link that is not a record", () => {
    const outer = new Error("outer", { cause: "a string" });
    expect([...causes(outer)]).toEqual([outer]);
    expect([...causes(undefined)]).toEqual([]);
  });

  test("terminates on a cycle", () => {
    const a: { cause?: unknown } = {};
    const b = { cause: a };
    a.cause = b;
    expect([...causes(a)]).toEqual([a, b]);
  });
});
