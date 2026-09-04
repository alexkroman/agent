// Copyright 2026 the AAI authors. MIT license.
/**
 * The env vocabulary's own tests, over an explicit map rather than `process.env`.
 *
 * Every reader takes the environment as a parameter for exactly this reason: the
 * rule under test is "blank counts as unset", and `vi.stubEnv` cannot express a
 * value that is present and whitespace-only as distinctly as a literal can.
 */
import { describe, expect, test } from "vitest";
import { envFlag, envInt, envValue, evalStepCapHint } from "./_env.ts";

describe("envValue", () => {
  test.each([
    ["unset", {}],
    ["empty", { X: "" }],
    // `X= cmd` is how a shell unsets one variable for a single command.
    ["whitespace-only", { X: "   " }],
  ])("%s reads as undefined", (_label, env) => {
    expect(envValue(env, "X")).toBeUndefined();
  });

  test("a set value is returned verbatim, untrimmed", () => {
    expect(envValue({ X: " keep me " }, "X")).toBe(" keep me ");
  });
});

describe("envFlag", () => {
  test.each([
    ["1", true],
    ["true", true],
    ["anything", true],
    // The one word that means off, so a CI matrix row can turn a half of the
    // tier off without unsetting the variable.
    ["0", false],
    ["", false],
    ["  ", false],
  ])("%o reads as %s", (raw, expected) => {
    expect(envFlag({ X: raw }, "X")).toBe(expected);
  });

  test("unset is off", () => {
    expect(envFlag({}, "X")).toBe(false);
  });
});

describe("envInt", () => {
  test("unset and blank both fall back", () => {
    expect(envInt({}, "X", 7)).toBe(7);
    expect(envInt({ X: " " }, "X", 7)).toBe(7);
  });

  test("a positive integer is read", () => {
    expect(envInt({ X: "3" }, "X", 7)).toBe(3);
  });

  test.each(["0", "-1", "1.5", "eighty"])(
    "%o THROWS rather than coercing, and names the variable",
    (raw) => {
      // A `NaN` bound answers false to every comparison, so coercion reports the
      // agent as failing a check the setting broke.
      expect(() => envInt({ X: raw }, "X", 7)).toThrow(/^X must be a positive integer/);
    },
  );
});

describe("evalStepCapHint", () => {
  test("defaults to 80 and is overridden by AAI_STEP_CAP_HINT", () => {
    expect(evalStepCapHint({})).toBe(80);
    expect(evalStepCapHint({ AAI_STEP_CAP_HINT: "12" })).toBe(12);
  });
});
