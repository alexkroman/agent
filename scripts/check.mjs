// Copyright 2026 the AAI authors. MIT license.
/**
 * The repo's check pipeline, as a TABLE plus one runner.
 *
 * Usage:
 *   node scripts/check.mjs              # full CI check       (pnpm check)
 *   node scripts/check.mjs --local      # fast pre-commit gate (pnpm check:local)
 *   node scripts/check.mjs --gates ci   # one phase set, nothing else (CI)
 *   node scripts/check.mjs --list-gates # the table as JSON, for a reader
 *
 * ## Why this is not `check.sh` any more
 *
 * The shell version listed nine of its gates TWICE — once in the `--local`
 * branch and once in the full branch — with their justifying comments copied
 * alongside, and it was 295 lines of which 193 were comment. That is not a
 * formatting complaint. The duplication is where the two modes drift, and the
 * shell scoping it invited produced two bugs whose fixes are still recorded in
 * that file's own comments:
 *
 *   - `local failed=0` inside `run_ratchets` meant a later `|| failed=1` at
 *     TOP-LEVEL scope assigned a fresh global that nothing read, so a failing
 *     gate printed "All checks passed." and exited 0.
 *   - `||` suppresses `set -e` on the way past, which is what let that happen
 *     silently.
 *
 * Both are unrepresentable here: a gate's fatality is a FIELD, and {@link
 * runPhase} is the only thing that reads it. The nine duplicated gates are one
 * row each.
 *
 * ## What a row means
 *
 * `phase` says WHEN a gate runs, and ordering within a phase is SOURCE ORDER —
 * load-bearing for the api-report -> api-contracts -> authoring-guide chain,
 * where each reads what the one before it wrote.
 *
 * `fatal: true` stops the run. `fatal: false` records the failure, keeps going,
 * and fails the process at the very end — right for the quality ratchets,
 * because a branch that trips three of them should be told about all three in
 * one run rather than one per push.
 *
 * `mode` narrows a row to one mode; absent means both.
 *
 * ## This table is the ONLY list, and CI reads it
 *
 * `.github/workflows/check.yml` used to restate the rows as a shell block of
 * `pnpm run check:*` lines, defended here as "two independent declarations, so
 * a gate dropped from one is a failing spec". That is not what happened.
 * Deleting a gate (`check:workflow-schema`) took its row, its `package.json`
 * script and the spec that watched it, and LEFT the workflow line: `pnpm run
 * <missing>` exits non-zero under `bash -e`, that job is in the required `ci`
 * job's `needs`, so every push would have failed CI while `pnpm check` stayed
 * green locally. The guard lived beside its subject, so deleting the subject
 * deleted the guard.
 *
 * So CI runs {@link runSelection} — one command, `--gates ci` — and the rows
 * reach it as VALUES. Adding, renaming or deleting a gate is an edit to this
 * file alone, and the two cannot disagree because there is only one of them.
 * `packages/aai-templates/gate-wiring.test.ts` is the guard that CANNOT be
 * deleted with its subject: it lives in a package owning none of this, reads
 * the table and the workflow independently, and fails on an empty parse.
 * Fatality stays a FIELD read by {@link runPhase}, which is the other half the
 * block flattened — `bash -e` makes every gate fatal, so a branch tripping
 * three ratchets learned about one per push.
 */

import { spawnSync } from "node:child_process";
import process from "node:process";

import { parseScriptArgs, USAGE_EXIT } from "./_args.mjs";
import { repoRoot } from "./_fs.mjs";
import { boundTurboConcurrency } from "./_turbo-concurrency.mjs";

const ROOT = repoRoot(import.meta.url);

const { values: FLAGS } = parseScriptArgs({
  script: import.meta.url,
  options: {
    local: { type: "boolean" },
    gates: { type: "string" },
    "list-gates": { type: "boolean" },
  },
});
const MODE = FLAGS.local === true ? "local" : "full";

/**
 * Whether to speak GitHub's workflow-command dialect: only `::error`, so a
 * failing gate becomes an ANNOTATION naming it. Deliberately no `::group` —
 * `check:konsistent` emits its own `::error` lines when this variable is set,
 * and wrapping its output is not worth risking the one gate that already
 * annotates the diff.
 */
const ANNOTATE = process.env.GITHUB_ACTIONS === "true";

// Spelled as escapes, never as the raw bytes: one control character makes a
// whole file BINARY to `git grep`, which silently exempts it from every
// `guard-invariants` line rule and every escape-hatch pattern. This repo has
// paid for that three times (`assertScanCorpus` exists to catch it).
const GREEN = "\u001b[0;32m";
const RED = "\u001b[0;31m";
const YELLOW = "\u001b[1;33m";
const NC = "\u001b[0m";

// Bound turbo's task concurrency, which sizes each task's vitest worker pool
// in turn — `scripts/_turbo-concurrency.mjs` carries why, and is shared with
// the fan-out doors so the two cannot compute different numbers. An explicit
// TURBO_CONCURRENCY still wins.
boundTurboConcurrency();

// ---------------------------------------------------------------------------
// The turbo invocations
// ---------------------------------------------------------------------------

/**
 * One turbo call per mode, so the dependency graph is resolved once and
 * everything with no dependency starts immediately: build, lint, test, syncpack
 * and sherif go straight away while typecheck, publint and attw wait for build.
 * `--continue` keeps independent tasks running when one fails, so a run reports
 * every failure rather than the first.
 *
 * `test:coverage` rather than `test`, in BOTH modes, because CI's test matrix
 * runs test:coverage and the per-package floors in each vitest.config.ts are
 * what it gates on. Running plain `test` here made a coverage-floor failure
 * STRUCTURALLY invisible until CI: a new module can be green in every suite and
 * still take its package under a floor. Measured on aai-ui, 17.0s -> 17.9s.
 */
const TURBO_TASKS = {
  local: [
    "build",
    "typecheck",
    "typecheck:tools",
    "lint",
    "check:publint",
    "check:syncpack",
    "check:format",
    "check:sherif",
    // In the local subset despite being a "full CI" style gate: it needs no
    // build, costs ~2s, and it is the only thing that catches a dependency
    // orphaned by a deletion. That failure mode is invisible while you work —
    // you are thinking about what to remove, not about what removal strands.
    "check:knip",
    "lint:root",
    "test:coverage",
  ],
  full: [
    "build",
    "typecheck",
    "typecheck:tools",
    "lint",
    "check:publint",
    "check:attw",
    "check:syncpack",
    "check:format",
    "check:dedupe",
    "check:sherif",
    "check:knip",
    "check:markdown",
    "lint:root",
    "test:coverage",
    "check:integration",
    "check:scenario",
    "docs",
  ],
};

/**
 * The second turbo invocation, which differs by mode and runs ALONE.
 *
 * Full mode's `check:e2e` is not a well-behaved sibling: the mock registry
 * rebuilds and republishes every publishable package from the live workspace
 * (`_mock-registry.ts`), truncating `packages/aai-ui/dist` and
 * `packages/aai/dist` and briefly rewriting each package.json to a unique
 * version. Run concurrently — which is what one combined
 * `turbo run test check:e2e` does, since neither declares an order against the
 * other — that rewrites shared artifacts underneath sibling packages' tests
 * while they read them. `aai-guest`'s toolchainModules suite asserts
 * `@alexkroman1/aai-cli/dist/templates/**` exists and aai-server's orchestrator
 * tests read `aai-ui/dist/default-client`; both fail for the length of the
 * window, naming a missing file and pointing nowhere near the run that removed
 * it. No `dependsOn` expresses this — turbo orders tasks against a package's own
 * dependency graph, and this is a whole-workspace side effect. CI never hit it
 * because check.yml already gives e2e its own job; the exposure was local
 * `pnpm check` (i.e. pre-push) on every e2e cache MISS, which is every fresh
 * worktree. `--concurrency=1` states the rule inside the invocation: nothing may
 * run beside it, not even a sibling task this invocation pulls in itself.
 * `build` is already a cache hit by now, so serializing costs nothing.
 *
 * Local mode's `check:eval` is the TEMPLATE evals against a SCRIPTED model — not
 * the eval tier, which needs a live model, is a measured-noisy instrument, and
 * deliberately gates nothing (`packages/aai-evals/CLAUDE.md`). With
 * `AAI_EVAL_STUB=1` the same files run the real runtime, pipeline and tool
 * executor against a scripted reply — deterministic, free, ~1s — so what is
 * gated is that a template still BOOTS and its eval still drives a session. Set
 * explicitly, and filtered to the templates, so a key in the environment can
 * never turn this into a paid run. CI runs the same command in its
 * integration-and-scenario job.
 */
const SECOND_TURBO = {
  local: { args: ["check:eval", "--filter", "aai-templates"], env: { AAI_EVAL_STUB: "1" } },
  full: { args: ["check:e2e", "--concurrency=1"], env: {} },
};

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Gate
 * @property {string} script The `package.json` script name, spelled out.
 * @property {"ratchets" | "after-tests" | "after-build"} phase When it runs.
 * @property {boolean} fatal Stop the run, or record it and carry on.
 * @property {"local" | "full"} [mode] Restrict to one mode; absent means both.
 * @property {string} [why] Why it exists and why it sits in this phase.
 */

/** @type {Gate[]} */
const GATES = [
  // --- ratchets ----------------------------------------------------------
  // Fast, pure git/fs gates that hold the line on technical debt. Up front, so
  // a debt regression fails before the slow turbo tasks, and `fatal: false` so
  // one run reports every ratchet a branch tripped rather than one per push.
  { script: "check:hatches", phase: "ratchets", fatal: false },
  {
    script: "check:invariants",
    phase: "ratchets",
    fatal: false,
    why: "The mechanical half of AGENTS.md. Every rule used to live only as prose in that file, which is enforcement exactly as long as a reviewer remembers it.",
  },
  { script: "check:file-length", phase: "ratchets", fatal: false },
  {
    script: "check:test-assertions",
    phase: "ratchets",
    fatal: false,
    why: "A test with no assertion passes whatever the code does, while counting in the suite total and in coverage — indistinguishable from real coverage at every level anyone looks at.",
  },
  {
    script: "check:property-floors",
    phase: "ratchets",
    fatal: false,
    why: "One level under check:test-assertions. A property test's load-bearing half is the coverage FLOOR, not the property: a generated sequence that stops reaching the interesting state does not fail, it passes faster and forever, with the same green count and the same coverage percentage. And a floor with no recorded actual cannot be re-measured, so one that has silently stopped being a floor is indistinguishable from a healthy one.",
  },
  {
    script: "check:claude-md",
    phase: "ratchets",
    fatal: false,
    why: "A CLAUDE.md past ~150k characters is silently truncated in an agent's context, so the guide is half-absent with nothing saying so.",
  },
  {
    script: "check:guest-toolchain",
    phase: "ratchets",
    fatal: false,
    why: "The guest toolchain lockfile must track the versions this checkout installed: it is baked into every guest image, and a stale one silently bakes a different tree than the repo tested with. Pure JSON comparison, no registry.",
  },
  {
    script: "check:agent-guide",
    phase: "ratchets",
    fatal: false,
    why: "The authoring guide also ships INSIDE the @alexkroman1/aai tarball, so a project that updated its SDK reads guidance matching the version it resolved rather than the copy `aai init` froze in. Same silent-staleness shape as the toolchain lockfile.",
  },
  {
    script: "check:scaffold",
    phase: "ratchets",
    fatal: false,
    why: "The third committed copy in this shape and the only one that SHIPS: it cannot say `catalog:`, so every catalogued bump is applied to it a second time. Nothing enforced that — the sync script ran only during a release, unchecked — and the catalog migration had already broken it into writing a literal `catalog:` into a manifest npm cannot resolve.",
  },
  {
    script: "check:konsistent",
    phase: "ratchets",
    fatal: false,
    why: "Structural conventions: the shapes Biome and tsc cannot see because none of them is wrong WITHIN a file — a provider module exporting four of its five symbols, a package importing across a forbidden dependency-graph boundary. ~600 files in ~1s, no build.",
  },
  {
    script: "check:deploy-changeset",
    phase: "ratchets",
    fatal: false,
    why: "One of the two gates here that are DIFF-scoped, and the reason is that the thing it checks is a property of a branch rather than of the tree: ship.yml arms its deploy on a version bump to a carrier, and `changeset status` is satisfied by an EMPTY changeset — so a branch can rewrite the platform, pass every other gate, merge, and ship nothing. That is #1341. An unresolvable base FAILS rather than skipping, which is the half of the no-git-ref rule that still applies. `supabase/migrations/**` is in scope too, where the same hole was wider: nothing else could ask, since `changeset status` answers for workspace packages and supabase/ is not one.",
  },
  {
    script: "check:migration-order",
    phase: "ratchets",
    fatal: false,
    why: "The other diff-scoped one, and a merge hazard rather than an authoring one: each branch picks a plausible next timestamp against the main it can see, both apply cleanly in isolation, and the inversion exists only in the merge. `supabase db push` then REFUSES a pending file older than the last remote row — at release time, after the npm publish, on a branch that has merged and gone. It has already cost a manual re-dating of two migrations (f376585). platform-schema.test.ts catches two files claiming ONE version; nothing caught one file claiming an older one.",
  },

  // --- after the test run ------------------------------------------------
  {
    script: "check:coverage-per-file",
    phase: "after-tests",
    fatal: false,
    why: "It READS what test:coverage wrote. The per-package floors in each vitest.config.ts catch a package sliding as a whole and are blind to one new module landing untested. `turbo.json` declares `coverage/**` as that task's output, so a cache hit restores the data and this still measures the current tree.",
  },

  // --- after the build ---------------------------------------------------
  // These read `dist/`, or PACK, so they cannot run before the turbo phase.
  // ORDER IS LOAD-BEARING from check:api-report down: each reads what the one
  // before it wrote, and a stale artifact would be believed.
  { script: "check:publish-names", phase: "after-build", fatal: true },
  {
    script: "check:publish-protocols",
    phase: "after-build",
    fatal: true,
    why: "It PACKS. `catalog:` and `workspace:` are pnpm-only protocols that pnpm rewrites when it makes a tarball, and that rewrite is the only thing between the catalog and a release that installs for nobody. publint reads the SOURCE manifest, so it cannot see this.",
  },
  {
    script: "check:api-report",
    phase: "after-build",
    fatal: true,
    why: "Reads the emitted dist/*.d.ts. A committed API report per published entry point, so a SIGNATURE change is a reviewable diff — exports.test.ts pins names, publint and attw check packaging, and neither sees a widened parameter or a newly optional field.",
  },
  {
    script: "check:api-contracts",
    phase: "after-build",
    fatal: true,
    why: "Immediately after api-report, on purpose: the capability contracts read the authoring surface out of the committed reports, so a stale report would be answered here as though it were current. This is the gate that turns 'the signature moved' into 'and it is a major, and here is the frozen example proving epoch N still compiles'.",
  },
  {
    script: "check:authoring-guide",
    phase: "after-build",
    fatal: true,
    why: "And immediately after THAT, one hop further out: it reads the contract tree to ask whether the guide that SHIPS to users names every capability the contracts version. check:agent-guide asserts that guide is CURRENT; nothing asserted it was COMPLETE, and eleven of aai's twenty-six capabilities were absent from it.",
  },
  {
    script: "check:docs-md",
    phase: "after-build",
    fatal: true,
    why: "Same dist/*.d.ts, a different reader. The API reports are signatures with every doc comment stripped, which is right for reviewing a change and useless for learning the API — so docs/api/ is TypeDoc's own markdown, committed, for an agent that cannot fetch the rendered site.",
  },
  {
    script: "check:template-types",
    phase: "after-build",
    fatal: true,
    why: "After build on purpose: the scaffold tsconfig has no `@dev/source` condition, so templates resolve the PUBLISHED types here, exactly as a scaffolded project does. Doc examples compile under the same config, so the same ordering applies to the gate below.",
  },
  { script: "check:doc-examples", phase: "after-build", fatal: true },
];

/**
 * Phase sets a caller may ask for by NAME, so CI names a JOB rather than a list.
 *
 * `ci` is the `lint-typecheck-and-checks` job, which owns two of the three
 * phases: the ratchets (pure git/fs, no build) and the after-build gates (that
 * job restores every package's `dist` before the step runs). The third,
 * `after-tests`, belongs to the coverage matrix, where a job holds only its own
 * coverage output and so invokes the gate per package with `--package`.
 *
 * A name rather than `--gates ratchets,after-build` spelled in the YAML: which
 * job runs which phases is the last of this mapping still expressible in two
 * places, so it lives here too. `--gates <phase>` still takes phases directly.
 */
const GATE_SELECTIONS = {
  ci: ["ratchets", "after-build"],
};

/**
 * What `--local` does NOT cover, named out loud.
 *
 * A subset by design, but a green subset reads as a green branch — and the gates
 * left out are exactly the ones whose failures are hardest to guess from a diff
 * (a broken `{@link}` fails `docs`, which treats warnings as errors; a route
 * that only exists under `aai dev` fails `check:scenario`). Naming them is the
 * difference between choosing to skip a gate and forgetting it exists.
 */
const NOT_RUN_BY_LOCAL = [
  ["check:attw", "published export types"],
  ["check:dedupe", "duplicate versions in the lockfile — it resolves, so it needs a registry"],
  ["check:markdown", "markdownlint over every .md"],
  ["check:integration", "multiple modules in memory — the fast-check harnesses"],
  ["check:scenario", "a real subprocess, port, bundler, or Postgres (pnpm test:pg)"],
  ["check:e2e", "full process spawn + Playwright"],
  ["docs", "TypeDoc, with treatWarningsAsErrors"],
];

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/** Failures from every `fatal: false` gate, reported together at the end. */
const deferred = [];

/**
 * Run a command, inheriting stdio, and answer whether it succeeded.
 *
 * No shell: every argument here is a literal in this file, so there is nothing
 * for one to re-split and no quoting rule to get wrong — which is half of what
 * the shell version was spending its care on.
 */
function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.error) {
    console.error(`check: could not run ${command} — ${result.error.message}`);
    return false;
  }
  return result.status === 0;
}

/** Every gate in a phase that applies to this mode, in source order. */
const gatesFor = (phase) =>
  GATES.filter((gate) => gate.phase === phase && (gate.mode ?? MODE) === MODE);

/**
 * Run a phase. A `fatal` failure exits immediately; the rest are collected.
 *
 * The single place fatality is interpreted, which is the point of the rewrite:
 * in the shell version it was a per-line `|| exit 1` or `|| VAR=1` decision made
 * eighteen times, and two of those lines were wrong.
 */
function runPhase(phase) {
  for (const gate of gatesFor(phase)) {
    if (run("pnpm", ["run", gate.script])) continue;
    // The annotation is what puts the gate's NAME in front of a reader who has
    // not expanded the log — the one thing the shell block in `check.yml` used
    // to get for free from `bash -e` stopping on the line that failed.
    if (ANNOTATE) console.log(`::error title=${gate.script}::${gate.script} failed`);
    if (gate.fatal) {
      console.error(`\n${RED}${gate.script} failed.${NC}`);
      process.exit(1);
    }
    deferred.push(gate.script);
  }
}

/**
 * Run one selection — a {@link GATE_SELECTIONS} name or a comma list of phases
 * — and nothing else. Never returns. This is what `check.yml` invokes.
 *
 * The two refusals are why it is here rather than in YAML. A selection naming a
 * phase the table does not declare is a USAGE error (exit 2, distinct from a
 * gate failure), and so is one resolving to ZERO gates: this function's whole
 * output is a count, so an empty run and a clean run would otherwise print the
 * same checkmark.
 */
function runSelection(selection) {
  const declared = new Set(GATES.map((gate) => gate.phase));
  const phases = GATE_SELECTIONS[selection] ?? selection.split(",").map((phase) => phase.trim());
  const unknown = phases.filter((phase) => !declared.has(phase));
  const usage = `Selections: ${Object.keys(GATE_SELECTIONS).join(", ")}. Phases: ${[...declared].join(", ")}.`;
  if (unknown.length > 0) {
    console.error(
      `check: --gates ${selection} names no such phase: ${unknown.join(", ")}. ${usage}`,
    );
    process.exit(USAGE_EXIT);
  }
  const chosen = phases.flatMap((phase) => gatesFor(phase));
  if (chosen.length === 0) {
    console.error(`check: --gates ${selection} selected NO gate in ${MODE} mode. ${usage}`);
    process.exit(USAGE_EXIT);
  }
  for (const phase of phases) runPhase(phase);
  if (deferred.length > 0) {
    console.error(`\n${RED}Quality ratchet(s) failed: ${deferred.join(", ")}${NC}`);
    process.exit(1);
  }
  console.log(`\n${GREEN}All ${chosen.length} gate(s) in --gates ${selection} passed.${NC}`);
  process.exit(0);
}

function turbo(args, env = {}) {
  if (run("pnpm", ["exec", "turbo", "run", ...args], env)) return;
  console.error(`\n${RED}Some checks failed.${NC}`);
  process.exit(1);
}

// The TABLE as data, for anything that needs to know what this repo gates on
// without running it. Deliberately NOT what CI consumes: a shell loop over this
// JSON would re-decide `fatal` per row, and `||` suppressing `set -e` on the
// way past is the bug that made check.sh print "All checks passed." over a
// failing gate.
if (FLAGS["list-gates"] === true) {
  console.log(JSON.stringify({ selections: GATE_SELECTIONS, gates: GATES }, null, 2));
  process.exit(0);
}

if (FLAGS.gates !== undefined) runSelection(FLAGS.gates);

runPhase("ratchets");

const banner = MODE === "local" ? "Running local checks" : "Running full CI checks";
console.log(`\n${YELLOW}${banner} (via turbo)${NC}`);
turbo([...TURBO_TASKS[MODE], "--continue"]);

runPhase("after-tests");
turbo(SECOND_TURBO[MODE].args, SECOND_TURBO[MODE].env);
runPhase("after-build");

if (MODE === "local") {
  console.log(`\n${YELLOW}Not run by --local (CI will):${NC}`);
  for (const [name, what] of NOT_RUN_BY_LOCAL) console.log(`  ${name.padEnd(20)}${what}`);
  console.log("  Run `pnpm check` for all of them.\n");
}

if (deferred.length > 0) {
  console.error(`\n${RED}Quality ratchet(s) failed: ${deferred.join(", ")}${NC}`);
  process.exit(1);
}

console.log(`\n${GREEN}All checks passed.${NC}`);
