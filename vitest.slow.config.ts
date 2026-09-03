// By SOURCE path, not package name: the repo root declares no dependency on
// the SDK, and this config is repo tooling rather than something we ship.

import { configDefaults, defineConfig } from "vitest/config";
import { aaiAgentPlugin } from "./packages/aai/src/host/testing-vite.ts";
import { sharedConfig, sharedSetupFiles } from "./vitest.shared.ts";

/**
 * The three slow tiers, separated by what a test may TOUCH rather than by how
 * long it takes — a timeout is a proxy for that and stops being one as soon as
 * two tests are slow for unrelated reasons.
 *
 * - `integration` — multiple modules **in memory**. No filesystem writes, no
 *   subprocess, no port, no database. Slow because it does a lot of work
 *   (the three fast-check harnesses), not because it waits on anything.
 * - `scenario` — a real subprocess, a real HTTP/WebSocket port, a real bundler,
 *   or a real Postgres.
 * - `e2e` — full process spawn + Playwright.
 * - `eval` — a live model, a live key, and real tokens. It is the one tier that
 *   measures BEHAVIOUR rather than correctness, so it is also the one tier that
 *   does not gate: see `packages/aai-evals/CLAUDE.md`. Its timeout is the
 *   largest because one studio codegen turn can legitimately run for minutes.
 *
 * **No tier carries a `retry`.** The integration profile used to set `retry: 2`,
 * which classified its own failures as noise: it was a 3x multiplier on the cost
 * of learning about a real break, and the flakes it was written to absorb (the
 * pipeline timing specs that "failed first on a contended runner") were FIXED by
 * moving them onto virtual time — so what it covered afterwards was whatever
 * arrived later, invisibly. It is also actively wrong for the fast-check harnesses
 * in this profile, whose documented contract is that per-run state is torn down in
 * a `finally`: a retried property run is the documented way to converge the
 * shrinker on the wrong counterexample. If any tier ever wants one it is
 * `scenario`, where a genuinely environment-dependent suite could argue for it
 * with the in-memory tests out of the blast radius.
 */
const profiles = {
  integration: { timeout: 30_000, hookTimeout: 30_000 },
  scenario: { timeout: 120_000, hookTimeout: 120_000 },
  e2e: { timeout: 300_000, hookTimeout: 300_000 },
  eval: { timeout: 1_800_000, hookTimeout: 1_800_000 },
} as const;

const profileKey = (process.env.VITEST_PROFILE ?? "integration") as keyof typeof profiles;
const profile = profiles[profileKey] ?? profiles.integration;

/**
 * All four slow tiers, selected by `VITEST_PROFILE` with `VITEST_INCLUDE`
 * choosing the files — from a package's `test:integration` / `test:scenario` /
 * `test:e2e` / `test:eval` script.
 *
 * Membership is a NAMING CONVENTION, so a new test lands in the right tier with no
 * config edit: `*.integration.test.ts`, `*.scenario.test.ts` and `*.eval.test.ts`
 * are excluded by every unit config and selected by the matching script.
 *
 * This config spreads `sharedConfig.test`, so it picks up `restoreMocks` and
 * the CI reporters the same way the unit projects do, and layers only the
 * timeout profile on top. It is the one config the workspace root does
 * NOT discover by glob, which is exactly why it has to inherit rather than
 * re-declare: before `restoreMocks` moved into `vitest.shared.ts` this was the
 * only suite in the repo running without it, leaking spies across the two
 * fast-check fuzz harnesses whose documented contract requires per-run
 * teardown.
 */
export default defineConfig({
  // Serves `virtual:aai/agent` to the template evals, the same as the
  // per-package config does for their unit specs — see its module doc.
  plugins: [aaiAgentPlugin()],
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    testTimeout: profile.timeout,
    hookTimeout: profile.hookTimeout,
    include: process.env.VITEST_INCLUDE?.split(",") ?? ["**/*.test.ts"],
    /**
     * Vitest's defaults, plus the worktree directory — and the addition is not
     * housekeeping.
     *
     * This config's `root` is wherever it is invoked from, and a package script
     * (`pnpm --filter aai-server test:scenario`) makes that the package
     * directory. Run from the REPO ROOT, though — which is what a bare
     * `vitest run -c vitest.slow.config.ts <pattern>` does, and AGENTS.md notes
     * `--dir` does not scope a run here — the scenario glob also matches
     * every git worktree checked out under it. Measured on this tree: 41 scenario
     * files at the root and 111 more across 20 worktrees.
     *
     * For the scenario tier that is not merely slow, it is WRONG: the duplicate
     * copies are the same suites with the same hard-coded slugs, running
     * concurrently against the same database, so each pair races the other. It
     * cost real time diagnosing a queue flake that turned out to include a second
     * copy of the suite from `.worktrees/tts-sandbox-truncation/`.
     *
     * Spelled with `configDefaults.exclude` because declaring `exclude` REPLACES
     * the defaults rather than extending them — losing the node_modules default
     * here would collect every dependency's tests.
     *
     * (Globs are described rather than quoted in this comment: a literal
     * star-slash inside a block comment ENDS it, which cost one debugging round.)
     */
    exclude: [...configDefaults.exclude, "**/.worktrees/**"],
    /**
     * Setup files are SELECTED per run, the same way `include` is, because this
     * one config serves every package's slow tiers and a package's setup file is
     * not safe to impose on the others. `aai-cli/_test-setup.ts` deletes every
     * `*API_KEY` and `DATABASE_URL` from the environment — correct for the CLI
     * suite, and it would silently disarm `pipeline-reference.integration.test.ts`
     * (which needs three real keys) and the whole Postgres arm.
     *
     * Declaring none was the bug: the unit tiers each set `setupFiles` in their
     * own `vitest.config.ts`, and NOTHING carried that into integration/scenario/
     * e2e. So `aai-cli`'s scenario and e2e suites ran without the
     * `AAI_CONFIG_DIR` redirect, i.e. against the developer's real
     * `~/.config/aai/config.json` — the exact machine-contamination that file
     * exists to prevent, and the reason its scenario suite had to re-implement
     * the credential scrub by hand.
     *
     * `sharedSetupFiles` leads and is NOT selectable, for the reason it exists:
     * a `VITEST_SETUP` naming a package's own file would otherwise replace the
     * whole array and drop the listener-leak gate from every slow tier — which
     * is precisely where a leak is most likely, these being the suites that open
     * real sockets, spawn real subprocesses and run thousands of fast-check
     * iterations against one long-lived signal.
     */
    setupFiles: [...sharedSetupFiles, ...(process.env.VITEST_SETUP?.split(",") ?? [])],
    pool: process.env.VITEST_POOL === "forks" ? "forks" : "threads",
    /**
     * The e2e tier runs its files ONE AT A TIME.
     *
     * Its setup mutates state shared across the whole run — it rebuilds
     * `packages/aai-cli/dist` and rewrites workspace package.json versions
     * while publishing to a mock registry — so two e2e files running
     * concurrently race on both. That was true when there was one such file and
     * it read as a rule against ever adding a second: `e2e.test.ts`'s doc said
     * the setup "must run exactly once per e2e run — never once per file
     * (vitest runs files concurrently)".
     *
     * Serializing is what makes the second file (`e2e-browser.test.ts`) correct
     * instead of lucky: each gets its own build and its own registry at its own
     * unique version, and nothing overlaps. It costs one extra build+publish
     * cycle and buys a tier that can grow — which it needed, because the
     * durable-workflow lifecycle had no e2e coverage and no room to add any.
     *
     * The cheaper end state is a `globalSetup` doing that work once; until then
     * this flag is what the two files rest on, so do not lift it for speed.
     *
     * ## The EVAL tier serializes for a different reason: one shared key
     *
     * Its files are independent of each other and would parallelise fine on
     * that count. What they are NOT independent of is the LLM gateway, which
     * they all reach through one account — so running them concurrently is the
     * tier rate-limiting itself. Measured on the first live run of all 25
     * template evals: 14 files failed, and the gateway answered
     * `HTTP 429 — too many requests for this action`.
     *
     * That is the worst possible failure for this tier specifically. An eval
     * reports a behaviour verdict, a 429 is an instrument fault, and the two are
     * indistinguishable in the output — a rate-limited run reads as a fleet of
     * agent regressions and sends somebody to debug a prompt. The tier is
     * already slow by construction (one model turn per utterance) and already
     * declines to gate, so wall clock is the cheapest thing it has to trade.
     *
     * The other two profiles keep parallel files: `integration` touches no
     * network, and `scenario`'s external resource is a database whose suites
     * isolate themselves — by slug where the predicate under test is per-tenant,
     * and by a private database (`useThrowawayPlatformDb`) where it is
     * FLEET-WIDE, which slugs cannot isolate and which flaked for as long as
     * they were asked to.
     */
    ...(profileKey === "e2e" || profileKey === "eval" ? { fileParallelism: false } : {}),
  },
});
