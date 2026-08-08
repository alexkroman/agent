// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Guards `scripts/check-test-assertions.mjs` — the gate that fails when a
 * `test()` body asserts nothing.
 *
 * A gate like this has one failure mode worse than the bug it catches: going
 * QUIET. Its whole output on success is a count, so a parser that stopped
 * recognising `test(` would print "all 0 test(s) assert something ✓" and be
 * indistinguishable from a healthy run. That is the same shape as the problem
 * it exists to prevent — something green that checks nothing — so the parser
 * is exercised here against sources with known answers rather than trusted.
 *
 * This lives in aai-templates for the same reason `claude-md-limit.test.ts`
 * does: it is the package that owns repo-level documentation/meta checks, and
 * `?raw` imports reach sibling files without node types.
 */

import { describe, expect, test } from "vitest";

const script = import.meta.glob("../../scripts/check-test-assertions.mjs", {
  query: "?raw",
  import: "default",
  eager: true,
})["../../scripts/check-test-assertions.mjs"];

/**
 * Re-derive the script's two regexes from its own source rather than
 * re-typing them, so this suite cannot pass against a copy that has drifted
 * from the file CI runs.
 */
function patternFrom(name: string): RegExp {
  const line = new RegExp(`const ${name} = (/.*/)([a-z]*);`).exec(script ?? "");
  if (!line?.[1]) throw new Error(`check-test-assertions.mjs no longer declares ${name}`);
  return new RegExp(line[1].slice(1, -1), line[2] || undefined);
}

describe("check-test-assertions parser", () => {
  test("the script is present and declares both patterns", () => {
    expect(script, "scripts/check-test-assertions.mjs not found").toBeTypeOf("string");
    expect(patternFrom("ASSERTION")).toBeInstanceOf(RegExp);
    expect(patternFrom("TEST_OPENER")).toBeInstanceOf(RegExp);
  });

  test("ASSERTION accepts every assertion form the repo actually uses", () => {
    const assertion = patternFrom("ASSERTION");
    for (const form of [
      "expect(x).toBe(1)",
      "expect.soft(x, label).toBe(1)",
      "expect.fail('nope')",
      "expect.hasAssertions()",
      "await expect(p).resolves.toBeUndefined()",
      "expectTypeOf<X>().toHaveProperty('y')",
      "assert(x)",
    ]) {
      expect(assertion.test(form), form).toBe(true);
    }
  });

  test("ASSERTION does not fire on lookalikes", () => {
    const assertion = patternFrom("ASSERTION");
    // `unexpected`/`expected` are ordinary identifiers in this repo's specs;
    // matching them would make the gate green on a body that asserts nothing.
    for (const form of ["const expected = 1;", "unexpectedCalls.push(x)", "// expect it to work"]) {
      expect(assertion.test(form), form).toBe(false);
    }
  });

  test("TEST_OPENER ignores RegExp.prototype.test", () => {
    // The lookbehind that makes this true was added after `/re/.test(x)`
    // produced five of the first run's eight reported offenders — every one
    // of them a false positive that would have cost the next author trust in
    // the gate.
    const opener = patternFrom("TEST_OPENER");
    opener.lastIndex = 0;
    expect(opener.test("if (/\\.tsx?$/.test(name)) out.push(name);")).toBe(false);
    opener.lastIndex = 0;
    expect(opener.test("expect(matcher.test(raw)).toBe(true);")).toBe(false);
  });

  test("TEST_OPENER recognises the call forms the suites use", () => {
    const opener = patternFrom("TEST_OPENER");
    for (const form of [
      'test("a thing", () => {})',
      'it("a thing", () => {})',
      'test.each([1, 2])("case %s", () => {})',
      'it.skipIf(cond)("a thing", () => {})',
    ]) {
      opener.lastIndex = 0;
      expect(opener.test(form), form).toBe(true);
    }
  });

  test("the gate is wired into both the local check and CI", () => {
    // The repo has been here before: the quality ratchets lived only in
    // check.sh, which CI never invokes, so `git push --no-verify` skipped them.
    const files: Record<string, string | undefined> = {
      "package.json": import.meta.glob("../../package.json", {
        query: "?raw",
        import: "default",
        eager: true,
      })["../../package.json"],
      "scripts/check.sh": import.meta.glob("../../scripts/check.sh", {
        query: "?raw",
        import: "default",
        eager: true,
      })["../../scripts/check.sh"],
      ".github/workflows/check.yml": import.meta.glob("../../.github/workflows/check.yml", {
        query: "?raw",
        import: "default",
        eager: true,
      })["../../.github/workflows/check.yml"],
    };
    for (const [path, text] of Object.entries(files)) {
      expect(text, `${path} not found`).toBeTypeOf("string");
      expect(text, `${path} no longer references check:test-assertions`).toContain(
        "check:test-assertions",
      );
    }
  });

  test("the gate fails the process rather than only reporting", () => {
    // A gate that printed its findings and exited 0 would be decorative, and
    // nothing downstream would notice — `check.sh` and the CI step both key
    // on the exit status alone.
    expect(script).toContain("process.exit(1)");
  });
});
