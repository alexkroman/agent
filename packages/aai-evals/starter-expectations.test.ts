// Copyright 2026 the AAI authors. MIT license.
/**
 * The grader grading itself — an expectation is a claim about a PROMPT, so it
 * has to be checkable against that prompt.
 *
 * This was a fail-fast block at the top of `scripts/starter-eval/run.mjs`, which
 * meant it ran only when somebody spent tokens on a full eval. It is a unit test
 * now: nothing here needs a key, a studio, or a model, and the bug class it
 * catches is the one that makes an eval LIE — a required tool the prompt never
 * asks for fails a perfectly good agent, and a check that accepts prose as
 * evidence passes a broken one.
 *
 * @module
 */

import { STARTERS } from "aai-studio-client/starters";
import { describe, expect, test } from "vitest";
import { checkCapabilities, EXPECTATIONS } from "../../scripts/starter-eval/expectations.mjs";

/** Every starter, flattened across the hero's two switcher positions. */
const starters = Object.values(STARTERS).flat();

/**
 * A prompt naming a template makes the TEMPLATE the ask — its files carry the
 * tools, builtins and `client.tsx` the expectation describes — so the
 * prose-consistency rules below do not apply to one.
 */
const referencesTemplate = (prompt: string): boolean => /\buse the \S+ template\b/i.test(prompt);

describe("starter expectations", () => {
  test("every expectation names a starter that exists", () => {
    const labels = new Set(starters.map((s) => s.label));
    const unknown = EXPECTATIONS.filter((e) => !labels.has(e.label)).map((e) => e.label);
    expect(unknown).toEqual([]);
  });

  test("a required UI is asked for by the prompt", () => {
    const offenders = EXPECTATIONS.filter((e) => e.ui).filter((e) => {
      const prompt = starters.find((s) => s.label === e.label)?.prompt ?? "";
      return !(referencesTemplate(prompt) || /client\.tsx|custom UI/i.test(prompt));
    });
    expect(offenders.map((e) => e.label)).toEqual([]);
  });

  test("a required builtin is named by the prompt", () => {
    const offenders: string[] = [];
    for (const e of EXPECTATIONS) {
      const prompt = starters.find((s) => s.label === e.label)?.prompt ?? "";
      if (referencesTemplate(prompt)) continue;
      for (const builtin of [...(e.builtins ?? []), ...(e.builtinDelegation ?? [])]) {
        if (!prompt.includes(builtin)) offenders.push(`${e.label}: ${builtin}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("builtinDelegation does not pass on prose alone", () => {
    // The other direction: a grader that says yes to everything measures
    // nothing. `builtinDelegation` accepts prose as evidence, so prove that an
    // agent carrying the prose and none of the machinery still fails.
    const offenders: string[] = [];
    for (const e of EXPECTATIONS) {
      const capabilities = e.capabilities ?? [];
      if (!e.builtinDelegation || capabilities.length === 0) continue;
      const proseOnly = `greeting: "${capabilities.map((syn) => syn[0]).join(" and ")}"`;
      const { missing } = checkCapabilities(e, { config: null, source: proseOnly });
      if (missing.length !== capabilities.length) offenders.push(e.label);
    }
    expect(offenders).toEqual([]);
  });

  test("the catalog is not empty, so an empty run cannot look healthy", () => {
    expect(starters.length).toBeGreaterThan(5);
    expect(EXPECTATIONS.length).toBeGreaterThan(0);
  });

  test("each sweep above has cases to sweep", () => {
    // The floor the three `offenders == []` tests need and did not have.
    //
    // Every one of them filters on a FIELD and then asserts the survivors are
    // clean. Rename `ui` to `requiresUi`, or `builtins` to `requiredBuiltins`,
    // and all three filter down to nothing, assert `[] == []`, and print green
    // — in the file whose own doc says "a grader that says yes to everything
    // measures nothing". `EXPECTATIONS.length > 0` above cannot see it, because
    // the catalog is still full; what emptied is the SELECTION.
    //
    // Floors rather than exact counts, so adding a starter never fails this,
    // and each is well under today's number (7 / 3 / 3 / 3 of 12).
    const withUi = EXPECTATIONS.filter((e) => e.ui);
    const withBuiltins = EXPECTATIONS.filter(
      (e) => (e.builtins ?? []).length > 0 || (e.builtinDelegation ?? []).length > 0,
    );
    const withDelegation = EXPECTATIONS.filter(
      (e) => e.builtinDelegation && (e.capabilities ?? []).length > 0,
    );
    expect(withUi.length, "no expectation declares `ui` — was the field renamed?").toBeGreaterThan(
      2,
    );
    expect(
      withBuiltins.length,
      "no expectation declares `builtins`/`builtinDelegation` — was a field renamed?",
    ).toBeGreaterThan(1);
    expect(
      withDelegation.length,
      "no expectation pairs `builtinDelegation` with `capabilities`, so the " +
        "prose-alone test checks nothing",
    ).toBeGreaterThan(1);
  });
});
