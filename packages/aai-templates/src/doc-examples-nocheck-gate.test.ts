// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * The `no-check` ratchet — `scripts/_no-check-ratchet.mjs`, run by
 * `scripts/check-doc-examples.mjs`.
 *
 * That gate compiles every ```ts fence in the published packages' doc comments,
 * the user-facing markdown and the studio prompts — except the ones marked
 * `no-check`, which it walks straight past. Those are shipped examples nothing
 * compiles, and until they were counted nothing stopped the population growing:
 * `packages/aai/README.md`'s "Testing an agent" example imported a name its own
 * subpath does not export, so every reader who copied the most-copied file in
 * the package got an unresolved-export build error, and the gate was green.
 *
 * `scripts/no-check-baseline.json` is the per-file budget. This suite is the
 * guard UNDER that gate, and it exists for the reason every other gate spec in
 * this package does: **the ratchet's entire success output is a count.** A fence
 * matcher that stopped recognising ```` ```ts no-check ```` would report a debt
 * of zero, agree with a baseline nobody re-seeded, and print a checkmark — the
 * same shape as the `\b` bug that left two escape-hatch patterns dead for months
 * while the tree held 110 violations.
 *
 * So the assertions below re-derive the count INDEPENDENTLY, with their own
 * parser, over the markdown half of the gate's own declared corpus, and hold the
 * baseline to it. Two properties make that stable rather than brittle:
 *
 *   - the corpus is parsed out of the script's `MARKDOWN_FILES`, so a file the
 *     gate stopped reading is a failure here rather than a silently smaller
 *     check;
 *   - the comparison is the ratchet's real invariant (`found <= budget`, and
 *     every file with a fence has an entry), not equality — the gate treats
 *     unclaimed headroom as a WARNING on purpose, and a spec demanding equality
 *     would turn "somebody made an example compile" into a red test.
 *
 * It lives in aai-templates for the reason its sibling gate specs do: this
 * package already owns the tests for repo-level scripts, and `?raw` imports
 * reach them with no node types, which this package's tsconfig has none of.
 */

import { describe, expect, test } from "vitest";
import { byCodeUnit, GATE_WIRING, numericConstant, repoPathOf, sole } from "./_gate-support.ts";

const SCRIPT = "scripts/check-doc-examples.mjs";
const RATCHET_MODULE = "scripts/_no-check-ratchet.mjs";

/** The gate's ENTRY POINT: the corpus lists and the fence parser live here. */
const script = sole(
  import.meta.glob("../../../scripts/check-doc-examples.mjs", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

/**
 * The ratchet half, and the shared engine under it — read SEPARATELY, and the
 * separation is the point.
 *
 * A spec that scrapes has to be told where the thing lives, which is the cost of
 * scraping: when the two baseline gates converged onto one engine, every
 * assertion about `--update` silently stopped finding its string in the gate and
 * failed naming a mechanism that had merely MOVED. This ratchet was split out of
 * the gate for size the same way, so it is named here rather than assumed.
 */
const ratchet = sole(
  import.meta.glob("../../../scripts/_no-check-ratchet.mjs", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

const engine = sole(
  import.meta.glob("../../../scripts/_ratchet.mjs", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

const baseline: Record<string, unknown> =
  sole(
    import.meta.glob<Record<string, unknown>>("../../../scripts/no-check-baseline.json", {
      import: "default",
      eager: true,
    }),
  ) ?? {};

/**
 * Every markdown source the gate might read, by repo-relative path.
 *
 * Globbed wider than the gate's own list and then INTERSECTED with it below: a
 * literal pattern is what `import.meta.glob` requires, and reading the list off
 * the script is what makes "the gate stopped reading a document" visible here.
 */
const markdown: Record<string, string> = Object.fromEntries(
  Object.entries({
    ...import.meta.glob<string>("../../../README.md", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
    ...import.meta.glob<string>("../../../docs/home.md", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
    ...import.meta.glob<string>("../../*/README.md", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
    ...import.meta.glob<string>("../../../examples/*/README.md", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
    ...import.meta.glob<string>("../scaffold/CLAUDE.md", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  }).map(([key, source]) => [repoPathOf(key), source]),
);

/** The gate's own `MARKDOWN_FILES`, read as data rather than restated. */
function declaredMarkdown(): string[] {
  const block = /const MARKDOWN_FILES = \[([\s\S]*?)\];/.exec(script ?? "");
  if (block?.[1] === undefined) throw new Error(`${SCRIPT} no longer declares MARKDOWN_FILES`);
  return [...block[1].matchAll(/"([^"]+)"/g)]
    .map((found) => found[1])
    .filter((file): file is string => file !== undefined)
    .sort(byCodeUnit);
}

/** The per-file budgets, as a plain record. */
const budgets = (baseline["no-check"] ?? {}) as Record<string, number>;

/**
 * A ts/tsx fence's info string, or `undefined` on any other line.
 *
 * Written from the markdown spec rather than copied from the gate: a copy of
 * the matcher would agree with the gate about a fence neither of them can see,
 * which is the one thing this file exists to rule out.
 */
function fenceInfo(line: string): string | undefined {
  const found = /^\s*```(tsx?)(\s.*)?$/.exec(line);
  return found === null ? undefined : (found[2] ?? "");
}

/** `{ checked, skipped }` fence counts for one document. */
function countFences(source: string): { checked: number; skipped: number } {
  let checked = 0;
  let skipped = 0;
  let open = false;
  for (const line of source.split("\n")) {
    if (open) {
      if (/^\s*```/.test(line)) open = false;
      continue;
    }
    const info = fenceInfo(line);
    if (info === undefined) continue;
    open = true;
    if (info.includes("no-check")) skipped += 1;
    else checked += 1;
  }
  return { checked, skipped };
}

/** The documents this suite can both READ and prove the gate reads. */
const corpus = declaredMarkdown()
  .filter((file) => markdown[file] !== undefined)
  .map((file) => ({ file, ...countFences(markdown[file] ?? "") }));

describe("the no-check ratchet's wiring", () => {
  test("all three sources are readable", () => {
    expect(script, `${SCRIPT} not found`).toBeTypeOf("string");
    expect(ratchet, `${RATCHET_MODULE} not found`).toBeTypeOf("string");
    expect(engine, "scripts/_ratchet.mjs not found").toBeTypeOf("string");
  });

  test("the entry point still RUNS the ratchet", () => {
    // The split is for file size; the wiring is what makes it a gate. A module
    // nothing calls is the same silent absence the ratchet itself exists to
    // catch, one level up.
    expect(script, `${SCRIPT} no longer imports ${RATCHET_MODULE}`).toContain(
      "_no-check-ratchet.mjs",
    );
    expect(script, `${SCRIPT} no longer calls the ratchet`).toContain("enforceNoCheckBudget(");
    expect(ratchet, `${RATCHET_MODULE} no longer exports it`).toContain(
      "export function enforceNoCheckBudget",
    );
  });

  test("the gate that carries it is enforced by both runners", () => {
    // A gate in package.json but in neither runner is a script nobody runs; one
    // in check.mjs alone is enforced by the pre-push hook, which `--no-verify`
    // skips. The ratchet deliberately rides the EXISTING `check:doc-examples`
    // row rather than adding a name to keep in step across files — which is also
    // why CI needs no edit: it RUNS the table (`gate-wiring.test.ts` owns that
    // half, and `_gate-support.ts` says why the workflow is not asserted here).
    const wiring = Object.entries(GATE_WIRING);
    expect(wiring.length, "GATE_WIRING resolved to nothing").toBeGreaterThanOrEqual(2);
    for (const [file, source] of wiring) {
      expect(source, `${file} not found`).toBeTypeOf("string");
      expect(source, `${file} no longer names check:doc-examples`).toContain("check:doc-examples");
    }
  });

  test("it runs on the SHARED ratchet engine, not a second copy", () => {
    // A bespoke re-implementation is how the two existing ratchets drifted
    // before `_ratchet.mjs` existed — only one of them deduplicated its output,
    // only one documented why `git grep` exits 1.
    expect(ratchet).toContain('from "./_ratchet.mjs"');
    for (const symbol of ["updateBaseline", "compareToBaseline", "warnStale"]) {
      expect(ratchet, `${RATCHET_MODULE} no longer calls ${symbol}`).toContain(symbol);
    }
    expect(ratchet, `${RATCHET_MODULE} no longer reads its baseline`).toContain(
      "no-check-baseline.json",
    );
  });

  test("--update refuses to RAISE an entry", () => {
    // The asymmetry is the whole contract: `--update` records removals, and
    // blessing an addition has to be a hand edit a reviewer can see. Asserted
    // against the engine, which owns it.
    expect(engine, "the shared engine no longer refuses to raise a baseline entry").toContain(
      "refusing to RAISE",
    );
  });

  test("an all-zero scan against a non-empty baseline is a hard failure", () => {
    expect(ratchet).toContain("assertNotUniversallyEmpty");
    // That guard only fires against a NON-empty baseline, so an empty baseline
    // would disarm it as well as the ratchet.
    expect(
      Object.keys(budgets).length,
      "the baseline is empty, so the all-zero guard checks nothing",
    ).toBeGreaterThan(0);
  });
});

describe("the corpus floors", () => {
  // A scan that stops matching prints the same checkmark as a clean tree, and
  // here it would additionally report a debt of zero. Both floors are asserted
  // to be real numbers rather than the `> 0` that would satisfy the letter of
  // the rule — the interesting failure is PARTIAL blindness.
  test("the gate declares both, and neither is nominal", () => {
    expect(numericConstant(ratchet ?? "", "MIN_DOCUMENTS", RATCHET_MODULE)).toBeGreaterThan(100);
    expect(numericConstant(ratchet ?? "", "MIN_FENCES", RATCHET_MODULE)).toBeGreaterThan(100);
  });

  test("the fence floor is above the whole no-check debt", () => {
    // Otherwise a tree in which every checked example vanished — the extractor
    // going blind to the compiled half — could still clear the floor on the
    // hatches alone.
    const debt = Object.values(budgets).reduce((sum, count) => sum + count, 0);
    expect(numericConstant(ratchet ?? "", "MIN_FENCES", RATCHET_MODULE)).toBeGreaterThan(debt);
  });
});

describe("the baseline against an independent parse", () => {
  test("the corpus resolves to something", () => {
    // The floor every gate spec here carries: two empty lists agree, and "no
    // file exceeds its budget" is vacuously true of no files.
    expect(declaredMarkdown().length, "MARKDOWN_FILES parsed to nothing").toBeGreaterThanOrEqual(8);
    expect(corpus.length, "no declared markdown document was readable").toBeGreaterThanOrEqual(8);
  });

  test("the parser recognises no-check fences, and only those", () => {
    // The non-vacuity assertion this file exists for. A matcher that had gone
    // blind reports zero skipped; one that stopped reading the info string at
    // all reports zero CHECKED, because every fence would look opted-out.
    const skipped = corpus.reduce((sum, doc) => sum + doc.skipped, 0);
    const checked = corpus.reduce((sum, doc) => sum + doc.checked, 0);
    expect(skipped, "no `no-check` fence found in the whole markdown corpus").toBeGreaterThan(20);
    expect(
      checked,
      "every ts fence read as opted-out — the info string is not being read",
    ).toBeGreaterThan(10);
  });

  test("tsx fences are counted too", () => {
    // `packages/aai-ui/README.md` opts out in ```tsx, so a matcher narrowed to
    // ```ts would silently stop counting a whole language tag.
    const tsx = Object.values(markdown).some((source) =>
      source.split("\n").some((line) => /^\s*```tsx\s+.*no-check/.test(line)),
    );
    expect(tsx, "no ```tsx no-check fence in the corpus — has one been removed?").toBe(true);
  });

  test("no document holds more no-check fences than the baseline allows", () => {
    // The ratchet's real invariant, re-derived. Not equality: unclaimed
    // headroom is a WARNING in the gate on purpose, so a branch that made an
    // example compile must not redden this.
    for (const { file, skipped } of corpus) {
      expect(
        skipped,
        `${file} holds more no-check fences than its baseline allows`,
      ).toBeLessThanOrEqual(budgets[file] ?? 0);
    }
  });

  test("every document that opts out has a baseline entry", () => {
    const withFences = corpus.filter((doc) => doc.skipped > 0).map((doc) => doc.file);
    expect(withFences.length, "no document opts out at all").toBeGreaterThan(3);
    for (const file of withFences) {
      expect(budgets[file], `${file} opts a fence out and is absent from the baseline`).toBeTypeOf(
        "number",
      );
    }
  });

  test("the baseline is a debt list, not a description of the tree", () => {
    // `_description` is the only prose the file carries — `--update` rewrites
    // everything else — so a reason recorded there would be erased. It is what
    // tells the next reader the goal is zero.
    expect(baseline._description, "the baseline lost its _description").toBeTypeOf("string");
    expect(String(baseline._description)).toContain("no-check");
  });
});
