// Copyright 2026 the AAI authors. MIT license.
/**
 * The oracle's own spec.
 *
 * It is the thing every other invariant in the repo is stated against, so its
 * two guarantees have to hold unconditionally: a violation THROWS (it is never a
 * log), and building the message can never replace the finding with a different
 * error.
 */

import { describe, expect, test } from "vitest";
import { InvariantViolation, invariant, isInvariantViolation } from "./invariant.ts";

describe("invariant", () => {
  test("a holding condition costs nothing and returns", () => {
    const detail = { calls: 0 };
    expect(() =>
      invariant(true, "x", () => {
        detail.calls += 1;
        return {};
      }),
    ).not.toThrow();
    // The thunk is what lets a violation report real numbers for free; a version
    // that evaluated it eagerly would pay for context nobody reads.
    expect(detail.calls, "the detail thunk ran on the PASSING path").toBe(0);
  });

  test("a broken condition throws, rather than returning or logging", () => {
    expect(() => invariant(false, "page.tail")).toThrow(InvariantViolation);
  });

  test("the name is carried separately, so it is searchable", () => {
    // `broken` rather than the literal `false`: `asserts condition` narrows the
    // literal to `never`, so `tsc` rightly calls the line after it unreachable
    // (TS7027). That the signature does this is the point of the last test in
    // this block — here it just has to not fight the spec.
    const broken: boolean = false;
    try {
      invariant(broken, "page.tail", () => ({ tail: 0, got: 4 }));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvariantViolation);
      expect((err as InvariantViolation).invariant).toBe("page.tail");
      // And the detail is IN the message, which is the half a bare assertion loses.
      expect((err as InvariantViolation).message).toContain('"tail":0');
      expect((err as InvariantViolation).message).toContain('"got":4');
    }
  });

  /**
   * The likeliest place for a second throw is a thunk reading the very state that
   * just went inconsistent. Reporting ITS `TypeError` in place of the violation
   * would lose the finding entirely, which is the one outcome this seam exists to
   * prevent.
   */
  test("a detail thunk that throws does not replace the violation", () => {
    const err = (() => {
      try {
        invariant(false, "page.tail", () => {
          throw new TypeError("cannot read properties of undefined");
        });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InvariantViolation);
    expect((err as InvariantViolation).invariant).toBe("page.tail");
    expect((err as InvariantViolation).message).toContain("detail unavailable");
  });

  test("a detail that will not serialize does not either", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => invariant(false, "x", () => cyclic)).toThrow(InvariantViolation);
  });

  test("it narrows for the caller, which is honest because the check really ran", () => {
    const value: string | undefined = "present" as string | undefined;
    invariant(value !== undefined, "value.present");
    // No cast and no `!`: if this stopped compiling the `asserts` signature broke.
    expect(value.length).toBe(7);
  });
});

describe("isInvariantViolation", () => {
  test("finds one wrapped in a cause chain, which is how it will arrive", () => {
    const wrapped = new Error("request failed", {
      cause: new Error("hop", { cause: new InvariantViolation("page.tail", "boom") }),
    });
    expect(isInvariantViolation(wrapped)).toBe(true);
  });

  test.each([
    ["a plain error", new Error("boom")],
    ["a string", "boom"],
    ["undefined", undefined],
    ["null", null],
  ])("says no to %s", (_label, value) => {
    expect(isInvariantViolation(value)).toBe(false);
  });

  test("terminates on a cyclic cause chain", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b", { cause: a }) as Error & { cause?: unknown };
    a.cause = b;
    expect(isInvariantViolation(a)).toBe(false);
  });
});
