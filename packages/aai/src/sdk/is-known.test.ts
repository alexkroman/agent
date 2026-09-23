// Copyright 2026 the AAI authors. MIT license.
import { expect, expectTypeOf, test } from "vitest";
import { isKnown } from "./is-known.ts";

const MODES = ["auto", "manual"] as const;

test("answers membership, case-sensitively", () => {
  expect(isKnown(MODES, "auto")).toBe(true);
  expect(isKnown(MODES, "manual")).toBe(true);
  expect(isKnown(MODES, "Auto")).toBe(false);
  expect(isKnown(MODES, "")).toBe(false);
  expect(isKnown([], "auto")).toBe(false);
});

test("narrows the value to the list's union", () => {
  const value: string = "manual";
  if (isKnown(MODES, value)) {
    expectTypeOf(value).toEqualTypeOf<"auto" | "manual">();
  } else {
    expectTypeOf(value).toEqualTypeOf<string>();
  }
});
