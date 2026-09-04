#!/usr/bin/env node
// Copyright 2026 the AAI authors. MIT license.
/**
 * Non-vacuity gate: a property test that walks a machine must declare a
 * COVERAGE FLOOR, and every floor must record the actual it was measured
 * against.
 *
 * ## The defect class
 *
 * The load-bearing half of a property test is not the property. It is the floor
 * underneath it — a counter asserted against a minimum, proving the generator
 * actually reached the state the property is about. `AGENTS.md` states the
 * argument outright: *"an all-green property proves nothing about a state the
 * generator never entered."* A generated sequence that stops reaching the
 * interesting state does not fail. It passes, faster, forever, and the suite
 * still reports the same green count and the same coverage percentage — which
 * is the same shape as `check-test-assertions`'s defect one level up: a test
 * that runs code and checks nothing.
 *
 * Nothing required it. Fourteen of the twenty suites in the corpus do it well,
 * several with a range recorded per floor; the practice was a convention held
 * by whoever last read the root guide. And a floor that has silently stopped
 * being a floor is not hypothetical in this repo — one session found three in
 * ordinary gates (`MIN_EXAMPLES` 24 under its actual, a scenario floor of
 * `>= 7` against a real 8, and one at zero), every one of them sitting BELOW
 * actual, i.e. each had quietly become decoration.
 *
 * That is why the second half of the rule exists. A floor with no recorded
 * measurement cannot be re-checked: you cannot tell `toBeGreaterThan(45)` at a
 * third of its actual from `toBeGreaterThan(45)` a hair under a collapsed one,
 * and only the second is a bug. `// 158-203` beside it makes staleness a thing a
 * reader can see. `s2s-fuzz.integration.test.ts`'s own header records paying for
 * this: *"twelve of the thirteen did not, and a floor with no recorded baseline
 * cannot be re-measured."*
 *
 * ## What is NOT gated, on purpose
 *
 * Not the number of property tests, not `numRuns`, not generator shape, and not
 * "one per package". A rule of that kind is gameable and its output is
 * compliance property tests, which are worse than none because they read as
 * coverage. Same reasoning as `check-test-assertions` having deliberately no
 * allowlist, and as the mutation-score diagnostic being wired nowhere.
 *
 * ## Which files are obliged, and why the exemptions are structural
 *
 * Both exemptions are properties of the file the parser can SEE, never a
 * per-file allowlist — an allowlist becomes the place anything gets parked, and
 * an entry in it would have to assert that some property rightly proves nothing.
 *
 * 1. **A module that runs no property is exempt.** `fc.assert` / `fc.check` is
 *    what runs one. Three files here only EXPORT arbitraries and commands
 *    (`_pipeline-fuzz-input.ts`, `_s2s-fuzz-commands.ts`, `_s2s-fuzz-plans.ts`);
 *    a floor there would have nothing to be asserted after, because the floor
 *    belongs to whichever suite runs the property. Their obligation is not
 *    waived, it is RELOCATED, and the one-hop import resolution below is what
 *    carries it: `s2s-fuzz.integration.test.ts` is obliged precisely because the
 *    `fc.commands` it runs lives in one of these modules.
 *
 * 2. **A value-level property is exempt** — one that neither uses a stateful
 *    fast-check API (own or one hop) nor counts a state anywhere. Five files:
 *    `ssrf.test.ts`, `protocol.test.ts`, `slugify.test.ts`, `_pcm.test.ts` and
 *    `_base64.test.ts`.
 *
 *    Note what is NOT the test: a sequence-shaped ARBITRARY. `fc.array` looked
 *    like the discriminator until `_pcm.test.ts` landed mid-calibration, where
 *    `fc.array(fc.integer({ min: 0, max: 255 }))` builds a byte BUFFER checked by
 *    a round-trip. A generated sequence says nothing about whether anything walks
 *    it.
 *
 *    This is the judgement call in the rule, so here is the argument. A
 *    value-level property has a vacuity mode — `slugify.test.ts` is the proof:
 *    its grammar claim once looped over five hand-picked strings all five
 *    characters or longer and so could not see that a ONE-character result
 *    violates the grammar. But look at how that was fixed. Not with a counter
 *    over string lengths — with two more properties, naming the one-character
 *    boundary out loud (`"a one-character result is NOT a platform slug"`).
 *    **For a value-level property the remedy for vacuity is another property.**
 *    A floor there would count draws from `fc.string()`, which is an assertion
 *    about fast-check's own distribution — a library that biases toward small
 *    values by design and whose shrinker explores boundaries for you. It cannot
 *    fail, so it is exactly the compliance floor this gate must not produce:
 *    `ssrf.test.ts` generates `fc.integer({ min: 0, max: 255 })`, where "did we
 *    draw an octet" is true by construction.
 *
 *    A floor over a machine walk is the opposite. It measures whether OUR
 *    sequence generator, OUR weights and OUR preconditions reached a state of
 *    OUR system — a question nothing else in the pipeline can answer, and one
 *    whose answer really does drift as the system changes underneath it.
 *
 * ## A floor of 0 needs no measurement
 *
 * `toBeGreaterThan(0)` says "this state was reached at least once", which the
 * root guide blesses for a state whose whole range is small. It also cannot go
 * stale DOWNWARD — zero is the floor of floors — so there is no drift for a
 * recorded actual to expose. Every floor above zero can drift, and must say
 * what it was measured against.
 *
 * ## Its own guard
 *
 * The success output is a count, so the scan carries floors: a corpus that
 * resolved to nothing, or a matcher that stopped recognising `fc.assert`, would
 * otherwise print "all 0 file(s) ✓" — which is this gate's own defect class
 * arriving in the gate. `packages/aai-templates/src/property-floor-gate.test.ts`
 * pins the matcher for the same reason.
 *
 * Wired up as `pnpm check:property-floors`, in `scripts/check.mjs`'s `GATES`
 * table (which is what puts it in the CI check job too — CI derives its gate
 * list from that table via `--gates ci`).
 *
 *     node scripts/check-property-floors.mjs
 *     node scripts/check-property-floors.mjs --report   # classification per file
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

import { parseScriptArgs } from "./_args.mjs";
import { repoRoot } from "./_fs.mjs";
import { analyzeSource, FLOOR_MATCHER } from "./_property-floors-parse.mjs";
import { compareToBaseline, updateBaseline, warnStale } from "./_ratchet.mjs";

const ROOT = repoRoot(import.meta.url);
const BASELINE_PATH = new URL("./property-floor-baseline.json", import.meta.url);
const UPDATE_COMMAND = "node scripts/check-property-floors.mjs --update";

/**
 * The one group carried as debt, and the one that is not.
 *
 * `unmeasured-floor` is a per-file budget on the shared `_ratchet.mjs` engine,
 * on the same only-lowers contract as `escape-hatch-baseline.json`: it is DEBT,
 * with a goal of zero, and the tree opened with exactly one entry.
 *
 * A stateful suite with NO FLOOR AT ALL has no group and no budget. Same
 * argument as `check-test-assertions` having no allowlist: an entry would have
 * to assert that some machine-walking property rightly proves nothing about the
 * state it walks, which is never true. The tree opened at zero of these, so the
 * absolute rule costs nothing today and is what stops the first one landing.
 *
 * `assertNotUniversallyEmpty` from that engine is deliberately NOT used. It
 * fails when every group reports zero against a non-empty baseline, which for a
 * debt scan means blindness — but here it is the GOAL, and the corpus floors
 * below already cover a scan that has gone blind.
 */
const GROUPS = [{ key: "unmeasured-floor", label: "floor with no recorded measurement" }];

/**
 * Floors on the scan itself, because this gate's whole success output is a
 * COUNT. Measured on this checkout: 20 files import `fast-check` (17 tracked
 * plus 3 that landed during the session that wrote this), of which 14 are
 * obliged and they declare 78 floors between them. The floors sit well under
 * each so ordinary churn never trips them, and any plausible breakage — a
 * pathspec that stopped matching, a matcher that stopped recognising
 * `fc.assert(` or `toBeGreaterThan(` — lands at or near zero.
 *
 * Note the pathspec shape: `packages/*.ts` and not `packages/**\/*.ts`. A git
 * pathspec is fnmatch WITHOUT `FNM_PATHNAME`, so `*` already crosses `/` and
 * the `**\/` spelling makes a subdirectory MANDATORY — the trap documented
 * under `check:file-length` in the root guide.
 */
const MIN_CORPUS_FILES = 12;
const MIN_OBLIGED_FILES = 8;
const MIN_FLOORS = 45;

const PATHSPECS = ["packages/*.ts", "packages/*.tsx"];

const { values: flags } = parseScriptArgs({
  script: import.meta.url,
  options: { report: { type: "boolean" }, update: { type: "boolean" } },
});

/** Files mentioning fast-check at all; the parse decides whether they IMPORT it. */
function candidateFiles() {
  let out = "";
  try {
    out = execFileSync(
      "git",
      ["grep", "-lI", "--untracked", "-e", "fast-check", "--", ...PATHSPECS],
      {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      },
    );
  } catch (err) {
    // `git grep` exits 1 for "no matches" and for "pathspec matched nothing"
    // alike, and the two are indistinguishable from the exit code — which is
    // why the corpus floor below is the real check and not this catch.
    if (/** @type {{ status?: number }} */ (err).status !== 1) throw err;
  }
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => !(f.includes("/dist/") || f.includes("node_modules/")));
}

/** @type {Map<string, ReturnType<typeof analyzeSource>>} */
const corpus = new Map();
const unparsable = [];

for (const file of candidateFiles()) {
  const info = analyzeSource(file, readFileSync(join(ROOT, file), "utf8"));
  if (info.errors.length > 0) {
    unparsable.push({ file, why: info.errors[0] });
    continue;
  }
  if (info.importsFastCheck) corpus.set(file, info);
}

// A file the parser choked on is reported first: it contributed nothing to any
// count below, so letting it through would understate all of them.
if (unparsable.length > 0) {
  console.error(`check-property-floors: ${unparsable.length} file(s) failed to parse.\n`);
  for (const { file, why } of unparsable) console.error(`  ${file}  ${why}`);
  process.exit(1);
}

if (corpus.size < MIN_CORPUS_FILES) {
  console.error(
    `check-property-floors: found ${corpus.size} file(s) importing fast-check, below the floor ` +
      `of ${MIN_CORPUS_FILES}.\n\n` +
      "Either the pathspec stopped matching or the import matcher did. A gate whose\n" +
      "success output is a count reports both as a clean run — which is the exact\n" +
      "defect this gate exists to catch. Its spec is\n" +
      "packages/aai-templates/src/property-floor-gate.test.ts.",
  );
  process.exit(1);
}

/**
 * The stateful fast-check APIs a file reaches: its own, plus those of the
 * sibling modules it imports. ONE hop, deliberately — that is enough for both
 * integration suites, whose arbitraries live next door
 * (`s2s-fuzz.integration.test.ts` reaches `fc.commands` only through
 * `./_s2s-fuzz-plans.ts`), and a transitive walk would make the obligation
 * depend on a graph nobody reading the file can see.
 */
function statefulReach(file, info) {
  const reach = new Set(info.statefulApis);
  for (const specifier of info.siblingFcModules) {
    const sibling = corpus.get(normalize(join(dirname(file), specifier)));
    // `?? []`: `analyzeSource`'s error path returns a row with no APIs at all,
    // and an unparsable sibling contributes nothing to what this one reaches.
    if (sibling) for (const api of sibling.statefulApis ?? []) reach.add(api);
  }
  return reach;
}

/**
 * Which of the three classes a file falls in.
 *
 * `arbitraries-only` runs no property, so the floor belongs to whichever suite
 * runs the arbitraries it exports. `value-level` runs one over a VALUE, where
 * the remedy for vacuity is another property. `stateful` is the obliged class.
 */
function classify(info, why) {
  if (!info.runsProperty) return "arbitraries-only";
  return why.length === 0 ? "value-level" : "stateful";
}

const rows = [];
for (const [file, info] of corpus) {
  const reach = statefulReach(file, info);
  const why = [...reach].sort();
  if (info.countsStates) why.push("counts-states");
  const kind = classify(info, why);
  rows.push({ file, info, why, kind, obliged: kind === "stateful" });
}
rows.sort((a, b) => a.file.localeCompare(b.file, "en"));

const obliged = rows.filter((row) => row.obliged);
const floorless = obliged.filter((row) => row.info.floors.length === 0);
const totalFloors = rows.reduce((sum, row) => sum + row.info.floors.length, 0);

/**
 * A floor with no recorded actual, per file. A floor of 0 is exempt: "reached at
 * least once" cannot drift downward, so there is nothing for a baseline to
 * expose.
 */
const bareFloorsOf = (row) => row.info.floors.filter((f) => f.value !== 0 && !f.measured);

/** @type {Map<string, Map<string, number>>} */
const counts = new Map([
  [
    "unmeasured-floor",
    new Map(
      obliged
        // The `@returns` makes the body a TUPLE; an array literal is `string[]`
        // otherwise and `new Map` has no overload for it.
        .map(
          /** @returns {[file: string, count: number]} */ (row) => [
            row.file,
            bareFloorsOf(row).length,
          ],
        )
        .filter(([, n]) => n > 0),
    ),
  ],
]);
/** Every bare floor's line, for the failure message; the counts are the budget. */
const bareLines = new Map(obliged.map((row) => [row.file, bareFloorsOf(row)]));

if (flags.report) {
  for (const { file, info, why, kind } of rows) {
    const floors = info.floors.length;
    const bare = info.floors.filter((f) => f.value !== 0 && !f.measured).length;
    console.log(
      `${kind.padEnd(16)} floors=${String(floors).padEnd(3)} unmeasured=${String(bare).padEnd(3)}` +
        ` ${file}${why.length > 0 ? `  [${why.join(",")}]` : ""}`,
    );
  }
  console.log(
    `\n${corpus.size} file(s), ${obliged.length} obliged, ${totalFloors} floor(s), ` +
      `${floorless.length} floorless, ${counts.get("unmeasured-floor")?.size ?? 0} with an ` +
      "unmeasured floor.",
  );
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

if (flags.update) {
  updateBaseline({
    gate: "check-property-floors",
    baselinePath: BASELINE_PATH,
    baseline,
    groups: GROUPS,
    counts,
    advice:
      "A floor that records no measured actual cannot be re-measured, so this budget\n" +
      "only ever goes DOWN. Record the observed range beside the floor instead — or,\n" +
      "if the state's whole range really is small, make it a floor of 0 and say so.",
    describe: () => baseline._description,
  });
}

const { violations, stale } = compareToBaseline(GROUPS, baseline, counts);
const problems = [];

if (floorless.length > 0) {
  problems.push(
    `${floorless.length} stateful property suite(s) declare no coverage floor:\n` +
      floorless.map(({ file, why }) => `  ${file}  (${why.join(", ")})`).join("\n") +
      "\n\nA generated sequence that stops reaching the interesting state does not fail —\n" +
      "it passes, faster, forever. Count the states the property is about and assert\n" +
      "each as a floor after the run:\n" +
      `  expect(reached.toolTurn, "no turn ever called a tool").${FLOOR_MATCHER}(670); // 2016-2489\n` +
      "See packages/aai-ui/src/fuzz-voiceio.test.ts and\n" +
      "packages/aai-runtime/src/workflow-resume-equivalence.test.ts for the shape.",
  );
}

if (violations.length > 0) {
  problems.push(
    `${violations.length} file(s) hold more unmeasured floors than the baseline allows:\n` +
      violations
        .map(
          ({ file, budget, count }) =>
            `  ${file}  ${count} > ${budget}\n` +
            (bareLines.get(file) ?? [])
              .map((floor) => `      :${floor.line}  floor ${floor.value}`)
              .join("\n"),
        )
        .join("\n") +
      "\n\nA floor with no recorded baseline cannot be re-measured, so a floor that has\n" +
      "silently stopped being one is indistinguishable from a healthy one. Record the\n" +
      "OBSERVED RANGE over several runs beside it — never one actual, never a fraction\n" +
      "of the mean; these distributions have long left tails.\n" +
      `  ).${FLOOR_MATCHER}(45); // 158-203\n` +
      'A floor of 0 needs none: "reached at least once" cannot drift downward.\n' +
      "A comment above a GROUP of floors covers the whole group.",
  );
}

if (problems.length > 0) {
  console.error(`check-property-floors: ${problems.length} problem(s).\n`);
  console.error(problems.join("\n\n"));
  process.exit(1);
}

if (obliged.length < MIN_OBLIGED_FILES || totalFloors < MIN_FLOORS) {
  console.error(
    `check-property-floors: ${obliged.length} obliged file(s) (floor ${MIN_OBLIGED_FILES}) and ` +
      `${totalFloors} floor(s) (floor ${MIN_FLOORS}).\n\n` +
      `${corpus.size} file(s) were found, so this is the matcher rather than the pathspec:\n` +
      "it has stopped recognising a property runner, a stateful API or a floor\n" +
      "assertion, and a gate whose success output is a count reports that as green.\n" +
      "Its spec is packages/aai-templates/src/property-floor-gate.test.ts.",
  );
  process.exit(1);
}

// Unclaimed headroom is a debt entry the next branch gets for free — warned,
// never failed, on the standing contract the other two baseline ratchets carry.
warnStale({ gate: "check-property-floors", stale, updateCommand: UPDATE_COMMAND });

const exempt = rows.length - obliged.length;
const debt = [...(counts.get("unmeasured-floor") ?? new Map()).values()].reduce((a, b) => a + b, 0);
console.log(
  `check-property-floors: ${obliged.length} stateful property suite(s) declare ${totalFloors} ` +
    `coverage floor(s), ${totalFloors - debt} of them recording a measured actual ` +
    `(${debt} baselined); ${exempt} of ${rows.length} fast-check file(s) exempt ` +
    "(arbitraries-only or value-level). ✓",
);
