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
 * It runs `findTests` IMPORTED from `scripts/_test-assertions-parse.mjs`, not a
 * copy and not a regex scraped out of the gate's source. `guard-invariants-gate.test.ts`
 * records what the scraping version cost: when the rules it read moved into
 * their own module it parsed ZERO of them, every per-rule assertion went
 * vacuous, and only one floored count noticed. That module exists to be
 * importable — no side effects — for exactly this reason.
 *
 * This lives in aai-templates for the same reason `claude-md-limit.test.ts`
 * does: it is the package that owns repo-level documentation/meta checks, and
 * `?raw` imports reach sibling files without node types.
 */

import { describe, expect, test } from "vitest";
import { GATE_WIRING, numericConstant, sole } from "./_gate-support.ts";

const script = sole(
  import.meta.glob("../../../scripts/check-test-assertions.mjs", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

/** The gate's real parser, imported rather than re-derived. See the module doc. */
const findTests = sole(
  import.meta.glob<
    (
      filename: string,
      source: string,
    ) => { tests: { line: number; title: string; asserts: boolean }[]; errors: string[] }
  >("../../../scripts/_test-assertions-parse.mjs", { import: "findTests", eager: true }),
);

/** Read a numeric constant out of the script rather than restating it here. */
const constant = (name: string): number =>
  numericConstant(script ?? "", name, "check-test-assertions.mjs");

/**
 * Parse a fixture, THROWING rather than asserting — a fixture that does not
 * parse is a bug in the fixture, and an `expect` out here would be an assertion
 * every caller silently inherits (biome's `noMisplacedAssertion`, and this
 * suite's own subject would count it as the caller's assertion).
 */
function parse(source: string, filename = "fixture.ts") {
  if (findTests === undefined) {
    throw new Error("scripts/_test-assertions-parse.mjs is not loadable");
  }
  const { tests, errors } = findTests(filename, source);
  if (errors.length > 0) throw new Error(`fixture did not parse: ${errors[0]}`);
  return tests;
}

/** The titles of the tests a fixture holds that assert NOTHING. */
const offenders = (source: string, filename?: string): string[] =>
  parse(source, filename)
    .filter((t) => !t.asserts)
    .map((t) => t.title);

describe("check-test-assertions parser", () => {
  test("the script and its parser both load", () => {
    expect(script, "scripts/check-test-assertions.mjs not found").toBeTypeOf("string");
    expect(findTests, "scripts/_test-assertions-parse.mjs exports no findTests").toBeTypeOf(
      "function",
    );
  });

  test("finds a test and reports its title and line", () => {
    const tests = parse('\n\ntest("does a thing", () => {\n  expect(1).toBe(1);\n});\n');
    expect(tests).toEqual([{ line: 3, title: "does a thing", asserts: true }]);
  });

  test("accepts every assertion form the repo actually uses", () => {
    for (const form of [
      "expect(x).toBe(1)",
      "expect.soft(x, label).toBe(1)",
      "expect.fail('nope')",
      "expect.hasAssertions()",
      "await expect(p).resolves.toBeUndefined()",
      "expectTypeOf<X>().toHaveProperty('y')",
      "assert(x)",
      "assert.equal(a, b)",
    ]) {
      expect(offenders(`test("t", async () => { ${form}; });`), form).toEqual([]);
    }
  });

  test("does not accept lookalikes", () => {
    // `unexpected`/`expected` are ordinary identifiers in this repo's specs;
    // counting them would make the gate green on a body that asserts nothing.
    for (const form of ["const expected = 1;", "unexpectedCalls.push(x)", "const e = expect;"]) {
      expect(offenders(`test("t", () => { ${form}; });`), form).toEqual(["t"]);
    }
  });

  test("recognises every call shape the suites use, chains included", () => {
    // `test.concurrent` is the one the regex parser this replaced could NOT
    // see: its opener admitted exactly one `.word(…)` before the call, so a
    // whole family went unscanned and eleven assertion-free `test.concurrent`
    // bodies in packages/aai-cli/src/e2e.test.ts passed under a clean run.
    for (const form of [
      'test("t", () => {})',
      'it("t", () => {})',
      'test.only("t", () => {})',
      'test.concurrent("t", async () => {})',
      'test.each([1, 2])("t", () => {})',
      'it.skipIf(cond)("t", () => {})',
      'test.concurrent.for([1])("t", async () => {})',
      'test.each`a`("t", () => {})',
    ]) {
      expect(offenders(form), form).toEqual(["t"]);
    }
  });

  test("ignores RegExp.prototype.test", () => {
    // Five of the first run's eight reported offenders were this — every one a
    // false positive that would have cost the next author trust in the gate.
    // The old parser needed a lookbehind; a chain walk gets it structurally,
    // because neither of these roots at an identifier named `test`.
    expect(parse("if (/\\.tsx?$/.test(name)) out.push(name);")).toEqual([]);
    expect(parse("const ok = matcher.test(raw);")).toEqual([]);
  });

  test("ignores a test() named in a comment or a string", () => {
    // Three files here carry a JSDoc paragraph about `test()`. Scanning raw
    // text finds those, and finds `expect` inside a string that merely
    // mentions it — the two jobs the hand-rolled comment/string masker did.
    expect(parse('/** Every test("x", …) body must assert. */\nconst a = 1;')).toEqual([]);
    expect(parse('// test("commented out", () => {});\nconst a = 1;')).toEqual([]);
    expect(parse('const src = `test("in a template", () => {})`;')).toEqual([]);
    // A substitution IS code, so a test inside one still counts. Spelled as a
    // template literal with the placeholder escaped, because an ordinary string
    // holding `${` is a biome finding and a suppression comment for it would be
    // a ratcheted escape hatch. (Naming that comment syntax here would be one
    // too: `check:hatches` counts the five suppression patterns on comment-only
    // lines, deliberately — only the three CAST patterns skip prose.)
    const inSubstitution = `const s = \`\${test("interpolated", () => {})}\`;`;
    expect(offenders(inSubstitution)).toEqual(["interpolated"]);
  });

  test("counts a nested test once, against the outer one", () => {
    const tests = parse(
      'test("outer", () => {\n  register(() => test("inner", () => { expect(1).toBe(1); }));\n});',
    );
    expect(tests.map((t) => t.title)).toEqual(["outer"]);
    // The inner assertion counts for the outer call, which is what the text
    // scan this replaced did too — the seam is the whole call, not its body.
    expect(tests[0]?.asserts).toBe(true);
  });

  test("parses TSX and modern TypeScript rather than skipping it", () => {
    expect(
      offenders(
        'test("renders", () => {\n  const el = <div className="x" />;\n  render(el satisfies unknown);\n});',
        "fixture.tsx",
      ),
    ).toEqual(["renders"]);
  });

  test("a file that will not parse is REPORTED, never silently empty", () => {
    // Skipping it would understate every count the gate prints, which is the
    // failure mode this whole suite exists for — so the parser hands the error
    // back and the gate exits on it.
    if (findTests === undefined) throw new Error("parser not loadable");
    const { tests, errors } = findTests("broken.ts", 'test("t", () => { const = ; });');
    expect(errors.length, "a syntax error produced no diagnostic").toBeGreaterThan(0);
    expect(tests).toEqual([]);
    expect(script, "the gate no longer fails on an unparsable file").toContain("failed to parse");
  });

  test("both corpus floors are declared and enforced", () => {
    // The floors ARE the gate's other defence against going quiet, and until
    // recently no assertion mentioned either — so deleting both left this guard
    // green while restoring exactly the failure mode it was written for.
    expect(constant("MIN_TEST_FILES"), "the test-FILE floor is gone").toBeGreaterThanOrEqual(200);
    expect(constant("MIN_TESTS_SCANNED"), "the test-COUNT floor is gone").toBeGreaterThanOrEqual(
      2000,
    );
    // Declared is not enforced. Both comparisons must exist, and both must exit
    // non-zero — a floor that only warns is a floor that is not a floor.
    for (const name of ["MIN_TEST_FILES", "MIN_TESTS_SCANNED"]) {
      expect(script, `${name} is declared but never compared against`).toMatch(
        new RegExp(`<\\s*${name}`),
      );
    }
    expect(script, "a floor breach no longer fails the process").toContain("below the floor of");
  });

  test("the gate is wired into both the local check and CI", () => {
    // The repo has been here before: the quality ratchets lived only in
    // the local check script, which CI never invokes, so `git push --no-verify`
    // skipped them.
    for (const [path, text] of Object.entries(GATE_WIRING)) {
      expect(text, `${path} not found`).toBeTypeOf("string");
      expect(text, `${path} no longer references check:test-assertions`).toContain(
        "check:test-assertions",
      );
    }
  });

  test("the gate fails the process rather than only reporting", () => {
    // A gate that printed its findings and exited 0 would be decorative, and
    // nothing downstream would notice — `check.mjs` and the CI step both key
    // on the exit status alone.
    expect(script).toContain("process.exit(1)");
  });
});
