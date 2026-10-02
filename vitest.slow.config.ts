// By SOURCE path, not package name: the repo root declares no dependency on
// the SDK, and this config is repo tooling rather than something we ship.

import { readFileSync } from "node:fs";
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

/**
 * The packages whose UNIT config pins `pool: "forks"`, by package.json `name`.
 * Their reasons hold for the slow tiers too, more so: real subprocesses,
 * sockets and process-wide state (`chdir`, signal handlers, global
 * dispatchers) that a worker thread either cannot touch or would share with
 * the next file. Listed rather than read from the package's own config,
 * because aai-templates' config imports the SDK's `dist`, which a slow tier
 * must not need; `aai-gates/src/vitest-setup-wiring.test.ts` fails a package
 * that pins `forks` without being listed here.
 */
const FORKS_PACKAGES = new Set(["aai-server", "@alexkroman1/aai-runtime", "aai-studio-server"]);

/** The package a slow-tier script runs from: its scripts run in its own root. */
const packageName: unknown = JSON.parse(readFileSync("package.json", "utf-8")).name;

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
    // The package's own unit pool (see FORKS_PACKAGES), or `VITEST_POOL=forks`
    // for any other package's run.
    pool:
      process.env.VITEST_POOL === "forks" || FORKS_PACKAGES.has(String(packageName))
        ? "forks"
        : "threads",
    // e2e files share a rebuilt `aai-cli/dist` and a mock registry, and eval
    // files share one gateway key that rate-limits concurrent runs — so both
    // tiers run one file at a time.
    ...(profileKey === "e2e" || profileKey === "eval" ? { fileParallelism: false } : {}),
  },
});
