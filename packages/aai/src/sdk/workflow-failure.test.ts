// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { DEFAULT_STEP_MAX_ATTEMPTS } from "./workflow-ctx-options.ts";
import { asFailureError, resolveFailureHandler } from "./workflow-failure.ts";

describe("resolveFailureHandler", () => {
  test("absent is absent", () => {
    expect(resolveFailureHandler(undefined)).toBeUndefined();
  });

  test("a bare hook gets the default step budget", () => {
    const hook = () => undefined;
    expect(resolveFailureHandler(hook)).toEqual({
      run: hook,
      maxAttempts: DEFAULT_STEP_MAX_ATTEMPTS,
    });
  });

  test("the step form keeps its budget, and defaults a missing one", () => {
    const run = () => undefined;
    expect(resolveFailureHandler({ run, maxAttempts: 120 })).toEqual({ run, maxAttempts: 120 });
    expect(resolveFailureHandler({ run })).toEqual({ run, maxAttempts: DEFAULT_STEP_MAX_ATTEMPTS });
  });
});

describe("asFailureError", () => {
  test("an Error is passed through as itself", () => {
    const err = new TypeError("bad");
    expect(asFailureError(err)).toBe(err);
  });

  test("anything else becomes an Error carrying its text", () => {
    expect(asFailureError("plain").message).toBe("plain");
    expect(asFailureError(42).message).toBe("42");
  });
});
