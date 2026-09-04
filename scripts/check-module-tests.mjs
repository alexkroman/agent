// Copyright 2026 the AAI authors. MIT license.
/**
 * Every source module under `packages/*&#47;src/` must have a CO-LOCATED test.
 *
 * Usage:
 *   node scripts/check-module-tests.mjs            # gate (pnpm check:module-tests)
 *   node scripts/check-module-tests.mjs --update   # record modules that now have one
 *   node scripts/check-module-tests.mjs --seed     # one-time: introduce the gate
 *   node scripts/check-module-tests.mjs --list     # every in-scope module, one per line
 *
 * ## The gap this closes, which no existing gate can see
 *
 * `check:coverage-per-file` holds every file to a 50% statement floor, and that
 * sounds like it already answers this. It does not: a module can be dragged
 * over the floor INCIDENTALLY, by a test written for something else. Four
 * modules in `aai-guest` had no test file of their own —
 * `studio-agent.ts`, `studio-session.ts`, `studio-http.ts`,
 * `studio-tool-descriptions.ts` — and the first was at **85.71%** lines and the
 * last two at **100%**, purely because `studio-chat.test.ts` and
 * `studio-session-init.test.ts` reach through them. So nothing in the repo
 * noticed, and the module where the coding agent's whole tool registry is
 * assembled had no assertion of its own about what it contains.
 *
 * Incidental coverage is worth less than it measures, and in one specific way:
 * it covers the lines the OTHER module's test happens to walk, and it moves
 * whenever that test moves. A co-located test is a claim about this module.
 *
 * ## What makes it a ratchet rather than a wish
 *
 * 341 of the 877 modules in scope are short of a test today. That is the
 * honest state and it is recorded, one path per line, in
 * `scripts/module-test-allowlist.json` — a DEBT baseline with a goal of zero,
 * exactly like `escape-hatch-baseline.json`. The engine is the shared one
 * (`_ratchet.mjs`), so it carries the contract those two already have:
 * `--update` REMOVES an entry that now has a test and REFUSES to add one, so
 * paying debt off is one command and taking debt on needs a hand edit in a
 * reviewable diff. `--seed` is the separate one-time bootstrap that introduced
 * the gate over the tree as it stood — the same split
 * `check-coverage-per-file.mjs` documents, and for the same reason: an
 * `--update` that could CREATE an entry would silently bless the very
 * regression the gate exists to catch.
 *
 * The engine is count-shaped (`{ group: { file: count } }`) and this gate is
 * set-shaped, so every entry's value is `1`: one module, one debt. That is the
 * whole encoding — the alternative was a third copy of the merge/refuse/report
 * machinery for the sake of a prettier JSON.
 *
 * ## Two floors, because the whole output is a count
 *
 * `assertScanCorpus` floors the PATHSPECS (a glob that stops matching prints
 * the same checkmark as a healthy tree), and {@link MIN_MODULES} floors what
 * survives the exclusions — which is where a widened exclusion would bite
 * instead. Both are set from the measured actual with headroom.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { parseScriptArgs } from "./_args.mjs";
import { compareNames, repoRoot } from "./_fs.mjs";
import {
  assertScanCorpus,
  compareToBaseline,
  git,
  updateBaseline,
  warnStale,
} from "./_ratchet.mjs";

const GATE = "check-module-tests";
const ROOT = repoRoot(import.meta.url);
const BASELINE_PATH = new URL("./module-test-allowlist.json", import.meta.url);
const KEY = "modules-without-tests";
const GROUPS = [{ key: KEY, label: "no co-located test" }];
const UPDATE_COMMAND = "node scripts/check-module-tests.mjs --update";

/** Every TypeScript file a package ships or builds from. */
const PATHSPECS = [
  "packages/*/src/*.ts",
  "packages/*/src/*.tsx",
  // A pathspec is fnmatch WITHOUT FNM_PATHNAME, so the `**` form REQUIRES a
  // subdirectory — hence the pair. Verified with `git ls-files`, never read.
  "packages/*/src/**/*.ts",
  "packages/*/src/**/*.tsx",
];

/** Measured 1,822 files across the ten packages; floored well under it. */
const MIN_FILES = 1600;
/** Measured 877 in-scope modules; floored under it for the same reason. */
const MIN_MODULES = 780;

/** A test file, in any of the tiers — these ARE the tests. */
const TEST_FILE = /\.(?:test|test-d)\.tsx?$/;
/** The infixes that put a test in a slow tier; a module may be tested from any. */
const TEST_SUFFIXES = [
  ".test.ts",
  ".test.tsx",
  ".integration.test.ts",
  ".integration.test.tsx",
  ".scenario.test.ts",
  ".scenario.test.tsx",
  ".eval.test.ts",
];

/**
 * Structural exclusions, each with the reason it is not a module owing a test.
 *
 * Deliberately NOT a class of `_`-prefixed internal modules: an internal module
 * is still code that can break, and this repo's `_`-prefix means "do not import
 * across packages", not "not worth testing".
 */
const EXCLUSIONS = [
  {
    why: "a barrel is a pure re-export surface; konsistent's `barrel-modules` convention already enforces that it holds nothing else",
    match: (file) => path.basename(file).endsWith("-barrel.ts"),
  },
  {
    why: "test infrastructure IS a test file by role — every suite that imports it exercises it, and it has no behaviour of its own to claim",
    match: (file) => {
      const base = path.basename(file);
      return (
        base.includes("test-utils") ||
        base.endsWith("-test-defs.ts") ||
        base === "_test-setup.ts" ||
        base === "_jsdom-setup.ts" ||
        base === "_gate-support.ts"
      );
    },
  },
  {
    why: "the capability contracts are COMPILE-only artifacts — a frozen example's whole assertion is that it still type-checks, which `tsc` and check:api-contracts make",
    match: (file) => file.includes("/src/contracts/"),
  },
  {
    why: "fixtures and snapshots are data, read by the suites that own them",
    match: (file) =>
      file.includes("/fixtures/") ||
      file.includes("/compat-fixtures/") ||
      file.includes("/__snapshots__/"),
  },
  {
    why: "a module with no RUNTIME export has nothing to call — decided by reading the file (see hasRuntimeExport), so one that grows a function enters scope on its own",
    match: (file) => !hasRuntimeExport(file),
  },
];

/**
 * Whether a file exports anything that exists at runtime.
 *
 * Read rather than guessed from the name: `sdk/tool-def.ts` sounds like it
 * exports `tool()` and exports three types, while `harness-types.ts` sounds
 * type-only and would still be in scope the moment it grew a helper. Comments
 * are stripped first, because these files carry long doc blocks that quote
 * declarations in prose.
 *
 * Conservative in the safe direction: anything ambiguous counts as a runtime
 * export and the module stays in scope.
 */
function hasRuntimeExport(file) {
  let source;
  try {
    source = readFileSync(path.join(ROOT, file), "utf8");
  } catch {
    return true;
  }
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  return /^export\s+(?:async\s+function|function|const|let|var|class|abstract\s+class|enum|default|\*|\{)/m.test(
    code,
  );
}

/** The in-scope modules, and the ones with no co-located test. */
function scanModules() {
  const files = [
    ...new Set(
      git(["ls-files", "--cached", "--others", "--exclude-standard", "--", ...PATHSPECS], {
        allowNoMatch: true,
      })
        .split("\n")
        .filter(Boolean),
    ),
  ];
  const tests = new Set(files.filter((file) => TEST_FILE.test(file)));
  const modules = files
    .filter((file) => !TEST_FILE.test(file))
    .filter((file) => !EXCLUSIONS.some((exclusion) => exclusion.match(file)));
  const missing = modules.filter((file) => {
    const stem = file.replace(/\.tsx?$/, "");
    return !TEST_SUFFIXES.some((suffix) => tests.has(stem + suffix));
  });
  return { modules: modules.sort(compareNames), missing: missing.sort(compareNames) };
}

const { values: FLAGS } = parseScriptArgs({
  script: import.meta.url,
  options: {
    update: { type: "boolean" },
    seed: { type: "boolean" },
    list: { type: "boolean" },
  },
});

assertScanCorpus({
  gate: GATE,
  what: "packages/*/src TypeScript",
  pathspecs: PATHSPECS,
  minFiles: MIN_FILES,
});

const { modules, missing } = scanModules();

if (modules.length < MIN_MODULES) {
  console.error(
    `\n${GATE}: ${modules.length} module(s) in scope, below the floor of ${MIN_MODULES}.\n\n` +
      "The corpus resolved, so this is an EXCLUSION swallowing more than it\n" +
      "reads like it does — and a gate whose whole output is a count reports a\n" +
      "clean tree either way. Print the set with --list and check EXCLUSIONS.\n",
  );
  process.exit(1);
}

if (FLAGS.list === true) {
  for (const file of modules) console.log(file);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const counts = new Map([[KEY, new Map(missing.map((file) => [file, 1]))]]);

if (FLAGS.seed === true) {
  // Bootstrap only, and it says so: seeding a baseline that already holds
  // entries would be `--update` with the refusal removed.
  if (Object.keys(baseline[KEY] ?? {}).length > 0) {
    console.error(
      `\n${GATE} --seed: the allowlist already holds entries.\n\n` +
        `Seeding is the one-time introduction of this gate. Use \`${UPDATE_COMMAND}\`\n` +
        "to record a module that has since gained a test.\n",
    );
    process.exit(1);
  }
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        _description: `Modules under packages/*/src with no co-located test. DEBT, goal zero: ${missing.length} left. The value is always 1 — see scripts/check-module-tests.mjs.`,
        [KEY]: Object.fromEntries(missing.map((file) => [file, 1])),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`${GATE} --seed: recorded ${missing.length} module(s) with no co-located test.`);
  process.exit(0);
}

if (FLAGS.update === true) {
  updateBaseline({
    gate: GATE,
    baselinePath: BASELINE_PATH,
    baseline,
    groups: GROUPS,
    counts,
    advice:
      "A module with no co-located test cannot be recorded by --update. Write the\n" +
      "test — `foo.ts` wants `foo.test.ts` beside it (or a `.integration.` /\n" +
      "`.scenario.` sibling when it needs a real port, subprocess or database) —\n" +
      "or, if this module genuinely owes none, add it to the allowlist BY HAND so\n" +
      "the reason lands in a reviewable diff.",
    describe: (next) =>
      `Modules under packages/*/src with no co-located test. DEBT, goal zero: ${Object.keys(next[KEY] ?? {}).length} left. The value is always 1 — see scripts/check-module-tests.mjs.`,
  });
}

const { violations, stale } = compareToBaseline(GROUPS, baseline, counts);

if (violations.length > 0) {
  console.error(`\n${GATE}: ${violations.length} module(s) have no co-located test:\n`);
  for (const { file } of violations) {
    const stem = path.basename(file).replace(/\.tsx?$/, "");
    console.error(`  ${file}  ->  write ${stem}.test.ts beside it`);
  }
  console.error(
    "\nA test next to the module is the only thing that claims anything about the\n" +
      "module: `check:coverage-per-file` can be satisfied INCIDENTALLY, by a test\n" +
      "written for something that imports it, and that coverage moves whenever the\n" +
      "other test does.\n\n" +
      "Pick the tightest tier the assertion can live in (AGENTS.md, 'Test tiers'):\n" +
      "the unit tier forbids filesystem writes, subprocesses and real network, so\n" +
      "a test that needs one of those is `*.scenario.test.ts`.\n",
  );
  process.exit(1);
}

warnStale({ gate: GATE, stale, updateCommand: UPDATE_COMMAND });
console.log(
  `${GATE}: ${modules.length} module(s) in scope, ${missing.length} still on the allowlist. ✓`,
);
