// Copyright 2026 the AAI authors. MIT license.
/**
 * The turbo invocations `scripts/check.mjs` makes, as data.
 *
 * Split out of that file when the twelfth gate row took it past the repo's
 * 500-line cap, and split HERE rather than anywhere else because these three
 * constants are the only part of it nothing reads back: the `GATES` table and
 * `GATE_SELECTIONS` are PARSED out of `scripts/check.mjs`'s own source by
 * `packages/aai-gates/src/gate-wiring.test.ts`, and a gate name is asserted
 * to appear in that file, so neither may move. Every doc comment travelled with
 * its constant unchanged.
 */

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
 * `TYPECHECK` is the four typecheck PROGRAMS, named once so the modes cannot drift.
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
export const SECOND_TURBO = {
  local: { args: ["check:eval", "--filter", "aai-templates"], env: { AAI_EVAL_STUB: "1" } },
  full: { args: ["check:e2e", "--concurrency=1"], env: {} },
};
