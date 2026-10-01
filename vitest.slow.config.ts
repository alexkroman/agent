// By SOURCE path, not package name: the repo root declares no dependency on
// the SDK, and this config is repo tooling rather than something we ship.

import { configDefaults, defineConfig } from "vitest/config";
import { aaiAgentPlugin } from "./packages/aai/src/host/testing-vite.ts";
import { sharedConfig, sharedSetupFiles } from "./vitest.shared.ts";

/**
 * The slow tiers, cut by what a test may TOUCH (see the tier table in
 * AGENTS.md), selected by `VITEST_PROFILE` with `VITEST_INCLUDE` choosing the
 * files — from a package's `test:integration` / `test:scenario` / `test:e2e` /
 * `test:eval` script. `eval` measures behaviour and does not gate.
 *
 * **No tier carries a `retry`**: a retry classifies the tier's own failures as
 * noise, and a retried fast-check run converges the shrinker on the wrong
 * counterexample.
 */
const profiles = {
  integration: { timeout: 30_000, hookTimeout: 30_000 },
  scenario: { timeout: 120_000, hookTimeout: 120_000 },
  e2e: { timeout: 300_000, hookTimeout: 300_000 },
  eval: { timeout: 1_800_000, hookTimeout: 1_800_000 },
} as const;

const profileKey = (process.env.VITEST_PROFILE ?? "integration") as keyof typeof profiles;
const profile = profiles[profileKey] ?? profiles.integration;

export default defineConfig({
  // Serves `virtual:aai/agent` to the template evals, as the per-package
  // config does for their unit specs.
  plugins: [aaiAgentPlugin()],
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    testTimeout: profile.timeout,
    hookTimeout: profile.hookTimeout,
    include: process.env.VITEST_INCLUDE?.split(",") ?? ["**/*.test.ts"],
    // This config's root is wherever it runs from, so a repo-root run would
    // also collect every worktree's copy of a suite and race it against the
    // same database. Extends (never replaces) vitest's own defaults.
    exclude: [...configDefaults.exclude, "**/.worktrees/**"],
    // A package's own setup file is SELECTED per run (`VITEST_SETUP`), because
    // one package's setup is not safe to impose on the others; the shared list
    // leads and cannot be selected away.
    setupFiles: [...sharedSetupFiles, ...(process.env.VITEST_SETUP?.split(",") ?? [])],
    pool: process.env.VITEST_POOL === "forks" ? "forks" : "threads",
    // e2e files share a rebuilt `aai-cli/dist` and a mock registry, and eval
    // files share one gateway key that rate-limits concurrent runs — so both
    // tiers run one file at a time.
    ...(profileKey === "e2e" || profileKey === "eval" ? { fileParallelism: false } : {}),
  },
});
