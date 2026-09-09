// Copyright 2026 the AAI authors. MIT license.
/**
 * The two settings `describeEval` reads, and the one property both share.
 *
 * These assertions are worth having because the functions they cover replaced
 * NOTHING: `AAI_EVAL_REPEAT` and `AAI_EVAL_ONLY` were plumbed end to end and
 * read by no code on this side, so the regression this file guards against is
 * the flags going back to being silently ignored — which no failing eval would
 * ever reveal, that being the whole shape of the bug.
 */

import { describe, expect, test } from "vitest";
import { evalOnlySelects, evalRepeat } from "./_env.ts";

describe("evalRepeat", () => {
  test("defaults to one, so an unset environment runs what it always ran", () => {
    expect(evalRepeat({})).toBe(1);
  });

  test("blank counts as unset, because that is how a shell unsets one", () => {
    // `AAI_EVAL_REPEAT= pnpm test:eval` is the shape. Reading it as `Number("")`
    // is 0, and zero repeats is a suite that measured nothing.
    expect(evalRepeat({ AAI_EVAL_REPEAT: "" })).toBe(1);
    expect(evalRepeat({ AAI_EVAL_REPEAT: "   " })).toBe(1);
  });

  test("reads a positive integer", () => {
    expect(evalRepeat({ AAI_EVAL_REPEAT: "3" })).toBe(3);
  });

  test("THROWS on a value it cannot use rather than coercing it", () => {
    // The alternative is `Number("three")` → NaN → a loop that never runs, and a
    // green suite that repeated nothing.
    expect(() => evalRepeat({ AAI_EVAL_REPEAT: "three" })).toThrow(/positive integer/);
    expect(() => evalRepeat({ AAI_EVAL_REPEAT: "0" })).toThrow(/positive integer/);
    expect(() => evalRepeat({ AAI_EVAL_REPEAT: "-2" })).toThrow(/positive integer/);
    expect(() => evalRepeat({ AAI_EVAL_REPEAT: "1.5" })).toThrow(/positive integer/);
  });
});

describe("evalOnlySelects", () => {
  test("unset selects everything", () => {
    expect(evalOnlySelects("answers a question", {})).toBe(true);
    expect(evalOnlySelects("answers a question", { AAI_EVAL_ONLY: "" })).toBe(true);
  });

  test("matches a substring, case-insensitively — the caller is typing, not globbing", () => {
    expect(
      evalOnlySelects("answers a question in its own voice", { AAI_EVAL_ONLY: "own voice" }),
    ).toBe(true);
    expect(
      evalOnlySelects("answers a question in its own voice", { AAI_EVAL_ONLY: "OWN VOICE" }),
    ).toBe(true);
  });

  test("rejects a name it does not appear in", () => {
    expect(
      evalOnlySelects("keeps the thread across two turns", { AAI_EVAL_ONLY: "own voice" }),
    ).toBe(false);
  });
});
