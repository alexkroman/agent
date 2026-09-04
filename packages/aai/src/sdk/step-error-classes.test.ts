// Copyright 2026 the AAI authors. MIT license.
/**
 * The brand, which is the part that fails SILENTLY when it is wrong.
 *
 * A `FatalError` the engine does not recognise is not an error anybody sees — it
 * is a step that retries when it was told not to, three times, on somebody's
 * bill. So the interesting tests here are the ones about recognition across
 * module copies and about a forged brand, not the constructors.
 */

import { describe, expect, test } from "vitest";
import { DEFAULT_RETRY_DELAY_MS, FatalError, RetryableError } from "./step-error-classes.ts";

describe("FatalError", () => {
  test("is recognised by its own static", () => {
    expect(FatalError.is(new FatalError("no"))).toBe(true);
    expect(RetryableError.is(new FatalError("no"))).toBe(false);
  });

  test("carries a readable `fatal` for a log line and a journaled failure", () => {
    expect(new FatalError("no").fatal).toBe(true);
    expect(new FatalError("no").name).toBe("FatalError");
  });

  test("keeps its cause", () => {
    const cause = new Error("underneath");
    expect(new FatalError("no", { cause }).cause).toBe(cause);
  });
});

describe("RetryableError", () => {
  test("is recognised by its own static", () => {
    expect(RetryableError.is(new RetryableError("later"))).toBe(true);
    expect(FatalError.is(new RetryableError("later"))).toBe(false);
  });

  test("defaults the delay rather than leaving it unset", () => {
    // "No delay" does NOT mean "let the engine decide" — it means one second,
    // which is what a rate limit punishes. A caller with the far side's own
    // `Retry-After` should pass it.
    const before = Date.now();
    const at = new RetryableError("later").retryAfter.getTime();
    expect(at).toBeGreaterThanOrEqual(before + DEFAULT_RETRY_DELAY_MS);
  });

  test("resolves a numeric delay against the clock at construction", () => {
    const before = Date.now();
    const at = new RetryableError("later", { retryAfter: 5000 }).retryAfter.getTime();
    expect(at).toBeGreaterThanOrEqual(before + 5000);
    expect(at).toBeLessThan(before + 6000);
  });

  test("takes an absolute Date as given", () => {
    const at = new Date("2030-01-01T00:00:00.000Z");
    expect(new RetryableError("later", { retryAfter: at }).retryAfter).toEqual(at);
  });
});

describe("the brand", () => {
  test("recognises an error from ANOTHER COPY of this module", () => {
    // The failure this exists to prevent: a guest bundle holding two copies of
    // this module, where `instanceof` answers false across them and a
    // `FatalError` silently downgrades to "unclassified, so retry". The brand is
    // `Symbol.for`, so a second copy's symbol is the same value — simulated here
    // by branding a plain error the way the constructor does.
    const fromElsewhere = new Error("fatal, from a second copy");
    Object.defineProperty(fromElsewhere, Symbol.for("aai.stepError"), {
      value: "fatal",
      enumerable: false,
    });
    expect(FatalError.is(fromElsewhere)).toBe(true);
  });

  test("is non-enumerable, so it survives neither a spread nor JSON", () => {
    // `retryAfter` IS an enumerable own field and should be — a caller reads it.
    // What must not travel is the brand: the journal's codec walks an object's
    // own enumerable keys, and a symbol it copied would be a second way for a
    // verdict to cross a wire, disagreeing with the one the classes own.
    const err = new RetryableError("later");
    const brand = Symbol.for("aai.stepError");
    expect(Object.getOwnPropertyDescriptor(err, brand)?.enumerable).toBe(false);
    expect(Object.getOwnPropertySymbols({ ...err })).not.toContain(brand);
    expect(JSON.stringify(err)).not.toContain("aai.stepError");
  });

  test("refuses a brand carrying a value it does not recognise", () => {
    // `Symbol.for` is a registry lookup, so any code in the process can mint the
    // same symbol. The VALUE is validated rather than trusted.
    const forged = new Error("pretending");
    Object.defineProperty(forged, Symbol.for("aai.stepError"), { value: "nonsense" });
    expect(FatalError.is(forged)).toBe(false);
    expect(RetryableError.is(forged)).toBe(false);
  });

  test("answers false for everything that is not an object", () => {
    for (const value of [undefined, null, "fatal", 7, true, Symbol("fatal")]) {
      expect(FatalError.is(value)).toBe(false);
      expect(RetryableError.is(value)).toBe(false);
    }
  });

  test("answers false for an array, which cannot be either error", () => {
    expect(FatalError.is([])).toBe(false);
  });
});
