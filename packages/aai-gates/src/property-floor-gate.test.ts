// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Guards `scripts/check-property-floors.mjs` — the gate that fails when a
 * property test walks a machine without declaring a coverage floor, or declares
 * one that records no measured actual.
 *
 * The failure mode worse than the bug it catches is the gate going QUIET. Its
 * whole success output is a count, so a matcher that stopped recognising
 * `fc.assert(`, `fc.asyncProperty(` or `toBeGreaterThan(` would print
 * "13 stateful property suite(s) declare 81 coverage floor(s) … ✓" over a tree
 * it never read — which is the same shape as the defect the gate exists to
 * prevent, arriving in the gate. So the matcher is exercised here against
 * sources with known answers rather than trusted, and the script's own corpus
 * floors are read out of it rather than restated.
 *
 * It runs `analyzeSource` IMPORTED from `scripts/_property-floors-parse.mjs`,
 * not a copy and not a regex scraped out of the gate's source —
 * `guard-invariants-gate.test.ts` records what the scraping version cost. That
 * module exists to be importable, with no side effects, for exactly this reason.
 *
 * Lives in aai-templates on the same rule as `test-assertion-gate.test.ts`: it
 * is the package that owns repo-level meta checks, and `?raw` imports reach
 * sibling files without node types.
 */

import { describe, expect, test } from "vitest";
import { GATE_WIRING, numericConstant, sole } from "./_gate-support.ts";

type Floor = { kind: string; value: number; line: number; measured: boolean; table?: string };
type Analysis = {
  importsFastCheck?: boolean;
  runsProperty?: boolean;
  countsStates?: boolean;
  statefulApis?: string[];
  siblingFcModules?: string[];
  floors?: Floor[];
  errors: string[];
};

const script = sole(
  import.meta.glob("../../../scripts/check-property-floors.mjs", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

const baseline = sole(
  import.meta.glob<Record<string, unknown>>("../../../scripts/property-floor-baseline.json", {
    import: "default",
    eager: true,
  }),
);

/** The gate's real parser, imported rather than re-derived. See the module doc. */
const analyzeSource = sole(
  import.meta.glob<(filename: string, source: string) => Analysis>(
    "../../../scripts/_property-floors-parse.mjs",
    { import: "analyzeSource", eager: true },
  ),
);

/** Read a numeric constant out of the script rather than restating it here. */
const constant = (name: string): number =>
  numericConstant(script ?? "", name, "check-property-floors.mjs");

/**
 * Analyse a fixture, THROWING rather than asserting — a fixture that does not
 * parse is a bug in the fixture, and an `expect` out here would be an assertion
 * every caller silently inherits.
 */
function analyze(source: string, filename = "fixture.test.ts"): Analysis {
  if (analyzeSource === undefined) {
    throw new Error("scripts/_property-floors-parse.mjs is not loadable");
  }
  const result = analyzeSource(filename, source);
  if (result.errors.length > 0) throw new Error(`fixture did not parse: ${result.errors[0]}`);
  return result;
}

/** The gate's own verdict for one file, spelled the way the script spells it. */
function verdict(source: string): "exempt" | "floorless" | "unmeasured" | "ok" {
  const info = analyze(source);
  const stateful =
    info.runsProperty === true &&
    ((info.statefulApis ?? []).length > 0 || info.countsStates === true);
  if (!stateful) return "exempt";
  const floors = info.floors ?? [];
  if (floors.length === 0) return "floorless";
  return floors.some((f) => f.value !== 0 && !f.measured) ? "unmeasured" : "ok";
}

/** A property that walks a machine: an async property over a generated sequence. */
const WALK = (body: string) => `
import fc from "fast-check";
import { expect, test } from "vitest";
test("walks", async () => {
  const reached = { opened: 0 };
  await fc.assert(
    fc.asyncProperty(fc.array(fc.boolean()), async (ops) => {
      for (const op of ops) if (op) reached.opened++;
    }),
  );
${body}
});
`;

describe("check-property-floors parser", () => {
  test("the script, its parser and its baseline all load", () => {
    expect(script, "scripts/check-property-floors.mjs not found").toBeTypeOf("string");
    expect(analyzeSource, "scripts/_property-floors-parse.mjs exports no analyzeSource").toBeTypeOf(
      "function",
    );
    expect(baseline, "scripts/property-floor-baseline.json not found").toBeTypeOf("object");
  });

  test("recognises a fast-check import, in every spelling a file could use", () => {
    // The corpus's own form is `import fc from "fast-check"`, but the gate must
    // not be blind to a namespace or named import: a file it does not see as a
    // fast-check file is a file it never asks the question about, and that is
    // indistinguishable from a passing file.
    for (const form of [
      'import fc from "fast-check";',
      'import * as fc from "fast-check";',
      'import { array } from "fast-check";',
      'import type { Arbitrary } from "fast-check";',
    ]) {
      expect(analyze(form).importsFastCheck, form).toBe(true);
    }
  });

  test("a file that only NAMES fast-check in prose is not a fast-check file", () => {
    // Four files in the tree discuss fast-check in a comment and import nothing.
    // Counting them would inflate the corpus floor's reading of a healthy tree,
    // and would demand a floor of a module with no property in it.
    const prose = "/** fast-check supplies the randomness now. */\nconst a = 1;\n";
    expect(analyze(prose).importsFastCheck).toBe(false);
  });

  test("only fc.assert / fc.check make a file a property RUNNER", () => {
    // The arbitraries-only exemption rests entirely on this. Three modules in
    // the tree export arbitraries and commands and run no property; the floor
    // belongs to whichever suite runs them.
    const arbsOnly = `
import fc from "fast-check";
export const stepArb = fc.array(fc.record({ kind: fc.constant("ok") }));
export const plan = fc.commands([fc.constant(null)]);
`;
    expect(analyze(arbsOnly).runsProperty).toBe(false);
    expect(verdict(arbsOnly)).toBe("exempt");
    expect(
      analyze('import fc from "fast-check";\nfc.assert(fc.property(fc.nat(), () => {}));')
        .runsProperty,
    ).toBe(true);
    expect(
      analyze('import fc from "fast-check";\nfc.check(fc.property(fc.nat(), () => {}));')
        .runsProperty,
    ).toBe(true);
  });

  test("recognises each stateful fast-check API", () => {
    for (const api of [
      "commands",
      "modelRun",
      "asyncModelRun",
      "scheduler",
      "schedulerFor",
      "asyncProperty",
    ]) {
      const src = `import fc from "fast-check";\nconst a = fc.${api}(x);\n`;
      expect(analyze(src).statefulApis, api).toContain(api);
    }
  });

  test("fc.array alone is NOT a stateful signal", () => {
    // The calibration finding that reshaped the rule. `_pcm.test.ts` generates a
    // byte BUFFER with `fc.array(fc.integer({ min: 0, max: 255 }))` and checks a
    // round-trip — one value, one assertion. Obliging it would have produced the
    // compliance floor this gate must not create ("did we draw a non-empty
    // array", true by construction).
    const valueLevel = `
import fc from "fast-check";
import { expect, test } from "vitest";
test("round-trips", () => {
  fc.assert(fc.property(fc.array(fc.integer()), (xs) => {
    expect(decode(encode(xs))).toEqual(xs);
  }));
});
`;
    expect(analyze(valueLevel).statefulApis).toEqual([]);
    expect(analyze(valueLevel).countsStates).toBe(false);
    expect(verdict(valueLevel)).toBe("exempt");
  });

  test("recognises a counter in each of the three spellings the tree uses", () => {
    // The other half of the obligation trigger. Four suites walk a machine
    // through a SYNC fc.property, so no API marks them stateful; what they have
    // is a tally. The Map form is `workflow-typed-json-property.test.ts`, which
    // was classified value-level until that arm existed.
    for (const bump of [
      "reached.opened++;",
      "cov.opened += 1;",
      "cov[key] = (cov[key] ?? 0) + 1;",
      "seen.set(what, (seen.get(what) ?? 0) + 1);",
    ]) {
      expect(analyze(`const x = 1;\n${bump}\n`).countsStates, bump).toBe(true);
    }
  });

  test("an ordinary read is not a counter", () => {
    for (const line of ["const n = reached.opened;", "out.push(x);", "map.set(k, v);"]) {
      expect(analyze(`${line}\n`).countsStates, line).toBe(false);
    }
  });

  test("finds a floor and reads its value, matcher and line", () => {
    const info = analyze(
      '\nexpect(reached.a, "never").toBeGreaterThan(45); // 158-203\nexpect(b).toBeGreaterThanOrEqual(7); // measured 12-19\n',
    );
    expect(info.floors).toEqual([
      { kind: "assertion", value: 45, line: 2, measured: true },
      { kind: "assertion", value: 7, line: 3, measured: true },
    ]);
  });

  test("a stateful suite with no floor FAILS", () => {
    expect(verdict(WALK(""))).toBe("floorless");
  });

  test("a floor with no recorded measurement FAILS", () => {
    expect(verdict(WALK('  expect(reached.opened, "never opened").toBeGreaterThan(30);'))).toBe(
      "unmeasured",
    );
  });

  test("a floor recording a measurement PASSES, in each accepted form", () => {
    for (const note of [
      "// 104-210",
      "// ~350",
      "// measured 234-273",
      "// observed 3 to 9 over 20 runs",
    ]) {
      expect(
        verdict(WALK(`  expect(reached.opened, "never opened").toBeGreaterThan(30); ${note}`)),
        note,
      ).toBe("ok");
    }
  });

  test("a note with no number is NOT a measurement", () => {
    // The whole second half of the rule turns on this. "The comment contains a
    // digit" would pass every floor in the tree, since a floor's neighbouring
    // JSDoc nearly always contains one.
    for (const note of ["// see above", "// the interesting state", "// re-measure me"]) {
      expect(
        verdict(WALK(`  expect(reached.opened, "never opened").toBeGreaterThan(30); ${note}`)),
        note,
      ).toBe("unmeasured");
    }
  });

  test("a floor of 0 needs no measurement", () => {
    // "Reached at least once" cannot drift DOWNWARD, so there is nothing for a
    // recorded actual to expose — and the root guide blesses `> 0` for a state
    // whose whole range is small.
    expect(verdict(WALK('  expect(reached.opened, "never").toBeGreaterThan(0);'))).toBe("ok");
  });

  test("a comment above a GROUP of floors covers the whole group", () => {
    // Two of the first draft's three findings were this, and both were the gate
    // being wrong rather than the file: floors come in groups under one comment,
    // and a scan that stopped at the first line of code reported every floor
    // after the first as unmeasured.
    const grouped = WALK(
      [
        "  // Measured over five runs: started 41-68, discarded 38-65.",
        '  expect(reached.opened, "a").toBeGreaterThan(13);',
        '  expect(reached.opened, "b").toBeGreaterThan(12);',
      ].join("\n"),
    );
    expect(verdict(grouped)).toBe("ok");
  });

  test("the upward scan stops at ordinary code", () => {
    // The bound that keeps the group rule from wandering up the file and
    // finding a number in an unrelated paragraph.
    const separated = WALK(
      [
        "  // Measured over five runs: 41-68.",
        "  const n = reached.opened;",
        '  expect(n, "a").toBeGreaterThan(13);',
      ].join("\n"),
    );
    expect(verdict(separated)).toBe("unmeasured");
  });

  test("a floors TABLE is a floor, and its entries carry their own measurements", () => {
    // s2s-fuzz.integration.test.ts declares thirteen floors this way and
    // asserts them in one go, so a matcher that only knew the `expect` shape
    // read the repo's most heavily floored suite as having none.
    const table = `
const COVERAGE_FLOORS = {
  toolExecuted: 78, // measured 234-273
  clientCancel: 108, // measured 324-395
};
const missed = Object.entries(COVERAGE_FLOORS).filter(([, f]) => f > 0);
`;
    const floors = analyze(table).floors ?? [];
    expect(floors.map((f) => [f.kind, f.value, f.measured])).toEqual([
      ["table", 78, true],
      ["table", 108, true],
    ]);
    expect(floors.every((f) => f.table === "COVERAGE_FLOORS")).toBe(true);
  });

  test("a floors table nothing READS is not a floor", () => {
    // Decoration, not a floor — and counting it would let a file satisfy the
    // gate with an object literal no assertion ever consults.
    const orphan = "const COVERAGE_FLOORS = { toolExecuted: 78 }; // measured 234-273\n";
    expect(analyze(orphan).floors).toEqual([]);
  });

  test("the corpus and matcher floors are real numbers, under today's actuals", () => {
    // Measured on the checkout that wrote this gate: 22 files import
    // fast-check, 13 are obliged, and they declare 81 floors. The floors sit
    // under each so ordinary churn never trips them — the corpus is moving,
    // three suites landed mid-session — while any plausible breakage lands near
    // zero.
    const corpus = constant("MIN_CORPUS_FILES");
    const obliged = constant("MIN_OBLIGED_FILES");
    const floors = constant("MIN_FLOORS");
    expect(corpus).toBeGreaterThan(0);
    expect(obliged).toBeGreaterThan(0);
    expect(floors).toBeGreaterThan(0);
    expect(obliged, "more obliged files than files").toBeLessThanOrEqual(corpus);
    expect(floors, "a floor per obliged file is the weakest useful reading").toBeGreaterThan(
      obliged,
    );
  });

  test("the pathspecs do not use the mandatory-subdirectory glob", () => {
    // A git pathspec is fnmatch WITHOUT FNM_PATHNAME, so `packages/**/*.ts`
    // parses as "packages/" + anything + "/" + anything + ".ts" — the literal
    // slash makes a subdirectory MANDATORY. That trap cost check:file-length
    // its entire top-level `scripts/` corpus while printing a checkmark.
    expect(script ?? "").toContain('"packages/*.ts"');
    expect(script ?? "").not.toContain("packages/**/*.ts");
  });

  test("the baseline is a shrink-only budget, with no group for a floorless suite", () => {
    // The one debt group is per-file and only ever goes down. There is
    // deliberately no group for a stateful suite with NO floor: an entry would
    // assert that some machine-walking property rightly proves nothing about
    // the state it walks, which is never true. Same argument as
    // check:test-assertions having no allowlist.
    const entries = baseline ?? {};
    expect(Object.keys(entries)).toContain("unmeasured-floor");
    expect(Object.keys(entries)).not.toContain("floorless");
    expect(entries._description, "the baseline must explain itself").toBeTypeOf("string");
    const group = entries["unmeasured-floor"] as Record<string, number>;
    for (const [file, count] of Object.entries(group)) {
      expect(Number.isInteger(count) && count > 0, `${file} has a non-count budget`).toBe(true);
    }
  });

  test("the gate is wired into both runners", () => {
    // A gate named in package.json but not in scripts/check.mjs is enforced by
    // nothing; one named only in check.mjs is enforced by the pre-push hook
    // alone, which `git push --no-verify` skips. CI derives its list from that
    // same table, so the row is the whole CI wiring — see _gate-support.ts on
    // why check.yml is NOT a third entry.
    expect(Object.entries(GATE_WIRING).length, "GATE_WIRING resolved to nothing").toBeGreaterThan(
      1,
    );
    for (const [file, source] of Object.entries(GATE_WIRING)) {
      expect(source, `${file} not readable`).toBeTypeOf("string");
      expect(source ?? "", `${file} does not name check:property-floors`).toContain(
        "check:property-floors",
      );
    }
  });
});
