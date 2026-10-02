// By SOURCE path, not package name: the repo root declares no dependency on
// the SDK, and this config is repo tooling rather than something we ship.

import { readFileSync } from "node:fs";
import { configDefaults, defineConfig } from "vitest/config";
import { aaiAgentPlugin } from "./packages/aai/src/host/testing-vite.ts";
import { sharedConfig, sharedSetupFiles } from "./vitest.shared.ts";

/**
 * The slow tiers, cut by what a test may TOUCH (see the tier table in
 * AGENTS.md). Each tier is a vitest PROJECT, selected by a package's
 * `test:integration` / `test:scenario` / `test:e2e` / `test:eval` script with
 * `--project <tier>`; its `include` is the tier's naming convention, so a new
 * file joins its tier by its name alone. `eval` measures behaviour and does not
 * gate. A run with no `--project` runs every tier, each under its own timeout.
 *
 * **No tier carries a `retry`**: a retry classifies the tier's own failures as
 * noise, and a retried fast-check run converges the shrinker on the wrong
 * counterexample.
 *
 * `serial`: e2e files share a rebuilt `aai-cli/dist` and a mock registry, and
 * eval files share one gateway key that rate-limits concurrent runs — so both
 * tiers run one file at a time. A serial project runs at `maxWorkers: 1`, and
 * vitest refuses two projects with different `maxWorkers` in one
 * `sequence.groupOrder`, so each tier takes its own.
 */
const tiers = {
  integration: { timeout: 30_000, include: ["src/**/*.integration.test.ts"], serial: false },
  scenario: { timeout: 120_000, include: ["src/**/*.scenario.test.ts"], serial: false },
  // aai-cli's e2e files are the one tier named by PREFIX, not infix.
  e2e: { timeout: 300_000, include: ["src/e2e*.test.ts"], serial: true },
  // aai-templates keeps each template's eval beside its agent, outside `src/`.
  eval: {
    timeout: 1_800_000,
    include: ["src/**/*.eval.test.ts", "templates/*/*.eval.test.ts"],
    serial: true,
  },
} as const;

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

/**
 * A package's OWN setup files for its slow tiers, by package.json `name`,
 * appended after `sharedSetupFiles`. One package's setup is not safe to impose
 * on the others, so it is keyed rather than shared. aai-cli's points
 * `AAI_CONFIG_DIR` away from the developer's real `~/.config/aai/config.json`
 * and scrubs `*API_KEY` — its unit config loads the same file.
 * `aai-gates/src/vitest-setup-wiring.test.ts` fails a package that runs a slow
 * tier and declares unit `setupFiles` without an entry here.
 */
const PACKAGE_SETUP_FILES: Record<string, readonly string[]> = {
  "@alexkroman1/aai-cli": ["./src/_test-setup.ts"],
};

/** The package a slow-tier script runs from: its scripts run in its own root. */
const packageName = String(
  (JSON.parse(readFileSync("package.json", "utf-8")) as { name?: unknown }).name,
);

export default defineConfig({
  // Serves `virtual:aai/agent` to the template evals, as the per-package
  // config does for their unit specs.
  plugins: [aaiAgentPlugin()],
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    // This config's root is wherever it runs from, so a repo-root run would
    // also collect every worktree's copy of a suite and race it against the
    // same database. Extends (never replaces) vitest's own defaults.
    exclude: [...configDefaults.exclude, "**/.worktrees/**"],
    // The shared list leads and cannot be selected away; the package's own
    // setup (PACKAGE_SETUP_FILES) follows it.
    setupFiles: [...sharedSetupFiles, ...(PACKAGE_SETUP_FILES[packageName] ?? [])],
    // The package's own unit pool (see FORKS_PACKAGES), or `VITEST_POOL=forks`
    // for any other package's run.
    pool:
      process.env.VITEST_POOL === "forks" || FORKS_PACKAGES.has(packageName) ? "forks" : "threads",
    projects: Object.entries(tiers).map(([name, tier], groupOrder) => ({
      extends: true as const,
      test: {
        name,
        include: [...tier.include],
        testTimeout: tier.timeout,
        hookTimeout: tier.timeout,
        sequence: { groupOrder },
        ...(tier.serial ? { fileParallelism: false } : {}),
      },
    })),
  },
});
