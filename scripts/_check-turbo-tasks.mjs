// Copyright 2026 the AAI authors. MIT license.
/**
 * The turbo invocations `scripts/check.mjs` makes, as data.
 *
 * Kept apart from that file because nothing parses these back out of its
 * source: `packages/aai-gates/src/gate-wiring.test.ts` reads the `GATES` table
 * and `GATE_SELECTIONS` as TEXT from `scripts/check.mjs`, so those two stay
 * there.
 *
 * **`full` is a strict superset of `local`** — every task and every later call
 * local mode runs, full mode runs too. `check.mjs` asserts it at startup, and
 * its `NOT_RUN_BY_LOCAL` is computed as the difference.
 */

/**
 * One turbo call per mode, so the dependency graph is resolved once and
 * everything with no dependency starts immediately; `--continue` keeps
 * independent tasks running past a failure so one run reports every failure.
 *
 * `test:coverage` rather than `test`, in BOTH modes: CI's test matrix runs
 * test:coverage and the per-package floors in each vitest.config.ts are what it
 * gates on, so plain `test` would hide a coverage-floor failure until CI.
 * `TYPECHECK` is the four typecheck PROGRAMS, named once so the modes cannot
 * drift.
 */
export const TYPECHECK = ["typecheck", "typecheck:tools", "typecheck:scripts", "typecheck:browser"];
export const TURBO_TASKS = {
  local: [
    "build",
    ...TYPECHECK,
    "lint",
    "check:publint",
    "check:syncpack",
    "check:format",
    "check:sherif",
    // No build, ~2s, and the only thing that catches a dependency orphaned by a
    // deletion — a failure invisible while you work.
    "check:knip",
    "lint:root",
    "lint:promises",
    // Skips with a notice when actionlint/zizmor are absent; CI installs them
    // and sets AAI_REQUIRE_WORKFLOW_LINT.
    "check:workflows",
    // ~5s together; the PATH tools `check:polyglot` runs skip when absent.
    "check:prettier",
    "check:polyglot",
    "test:coverage",
  ],
  full: [
    "build",
    ...TYPECHECK,
    "lint",
    "check:publint",
    "check:attw",
    "check:syncpack",
    "check:format",
    "check:dedupe",
    "check:sherif",
    "check:knip",
    "check:markdown",
    "check:shell",
    "check:workflows",
    "check:prettier",
    "check:polyglot",
    "lint:root",
    "lint:promises",
    "test:coverage",
    "check:integration",
    "check:scenario",
    "docs",
  ],
};

/**
 * The template evals against a SCRIPTED model (`AAI_EVAL_STUB=1`): the real
 * runtime, pipeline and tool executor driving a scripted reply — deterministic,
 * free, ~1s — so what is gated is that a template still BOOTS and its eval
 * still drives a session. Not the eval tier, which needs a live model and gates
 * nothing (`packages/aai-evals/CLAUDE.md`). Filtered to the templates with the
 * stub set explicitly, so a key in the environment can never make it a paid
 * run. A call of its own because `--filter` and the env apply to a whole
 * invocation. CI runs the same command in `integration-and-scenario`.
 */
const EVAL_STUB = {
  task: "check:eval",
  args: ["check:eval", "--filter", "aai-templates"],
  env: { AAI_EVAL_STUB: "1" },
};

/**
 * `check:e2e` runs ALONE (`--concurrency=1`): its mock registry rebuilds and
 * republishes every publishable package from the live workspace
 * (`_mock-registry.ts`), truncating `aai-ui/dist` and `aai/dist` and briefly
 * rewriting each package.json. Beside sibling tasks that rewrites artifacts
 * underneath their tests (`aai-guest`'s toolchainModules suite, aai-server's
 * orchestrator tests), which then fail naming a missing file. No `dependsOn`
 * can say this — it is a whole-workspace side effect. `build` is a cache hit
 * by now, so serializing costs nothing.
 */
const E2E = { task: "check:e2e", args: ["check:e2e", "--concurrency=1"], env: {} };

/** The turbo calls after the first, in order. Full repeats local's, then adds. */
export const LATER_TURBO = {
  local: [EVAL_STUB],
  full: [EVAL_STUB, E2E],
};

/**
 * Tasks of `TURBO_TASKS.full` that a CI job OTHER than `lint-typecheck-and-checks`
 * runs, and where. Everything else in full mode's first call is that job's, via
 * `node scripts/check.mjs --turbo ci` — derived, so a task added to full mode
 * reaches CI with no workflow edit.
 */
export const CI_ELSEWHERE = {
  "test:coverage": "the `test` matrix, one package per leg",
  "check:integration": "`integration-and-scenario`",
  "check:scenario": "`integration-and-scenario`",
  "check:workflows": "its own lint-job step, which passes `--base origin/main`",
};

/** Named task sets for `check.mjs --turbo <name>`. */
export const TURBO_SELECTIONS = {
  ci: TURBO_TASKS.full.filter((task) => !Object.hasOwn(CI_ELSEWHERE, task)),
};
