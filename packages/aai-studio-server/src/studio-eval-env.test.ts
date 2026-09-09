// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio eval settings, over an explicit map rather than `process.env`.
 *
 * Every reader takes the environment as a parameter for the reason
 * `aai-evals/env`'s own spec gives: the rule under test is "blank counts as
 * unset", and `vi.stubEnv` cannot express a value that is present and
 * whitespace-only as distinctly as a literal can. `evalOrigin` gained the
 * parameter in the move for exactly that — it read `process.env` directly and
 * was the one of the three nothing could test.
 */
import { describe, expect, test } from "vitest";
import { evalContracts, evalOrigin, evalStepCapHint } from "./studio-eval-env.ts";

describe("evalOrigin", () => {
  test("defaults to the local dev server and is overridden by AAI_EVAL_ORIGIN", () => {
    expect(evalOrigin({})).toBe("http://127.0.0.1:8080");
    expect(evalOrigin({ AAI_EVAL_ORIGIN: "https://studio.example" })).toBe(
      "https://studio.example",
    );
  });
});

describe("evalContracts", () => {
  test("is off unless opted into, and `0` turns it back off", () => {
    expect(evalContracts({})).toBe(false);
    expect(evalContracts({ AAI_EVAL_CONTRACTS: "1" })).toBe(true);
    // A CI matrix row turns the half off without unsetting the variable.
    expect(evalContracts({ AAI_EVAL_CONTRACTS: "0" })).toBe(false);
  });
});

describe("evalStepCapHint", () => {
  test("defaults to 80 and is overridden by AAI_STEP_CAP_HINT", () => {
    expect(evalStepCapHint({})).toBe(80);
    expect(evalStepCapHint({ AAI_STEP_CAP_HINT: "12" })).toBe(12);
  });

  test("a blank value falls back rather than reading as NaN", () => {
    // `NaN` answers false to every comparison, so coercion reports the agent as
    // having run away from a step cap the setting broke.
    expect(evalStepCapHint({ AAI_STEP_CAP_HINT: " " })).toBe(80);
  });
});
