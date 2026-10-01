import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig, type ViteUserConfig } from "vitest/config";

/**
 * Setup files EVERY project loads, whatever tier it runs in.
 *
 * `setupFiles` is an ARRAY, so a config that assigns its own list after
 * `...sharedConfig.test` REPLACES this one silently; {@link defineUnitProject}
 * appends instead, and `vitest.slow.config.ts` spreads it by hand.
 * `packages/aai-gates/src/vitest-setup-wiring.test.ts` fails a config that
 * drops it. Absolute paths, because the package roots share no relative one.
 *
 * - `fail-on-process-warning.mjs` turns a listener leak into a failure.
 * - `record-floor-samples.mjs` is inert unless `AAI_FLOOR_SAMPLES` is set (see
 *   `scripts/sample-property-floors.mjs`).
 */
export const sharedSetupFiles = [
  fileURLToPath(new URL("./scripts/fail-on-process-warning.mjs", import.meta.url)),
  fileURLToPath(new URL("./scripts/record-floor-samples.mjs", import.meta.url)),
];

/**
 * How many test workers ONE vitest run may spawn: `parallelism /
 * TURBO_CONCURRENCY`, so turbo's task count times vitest's workers stays at the
 * core count. Oversubscription is a correctness problem here, not a speed one —
 * PBKDF2-heavy suites cross their timeouts under contention.
 *
 * With no TURBO_CONCURRENCY (a bare package run, and every CI matrix job) this
 * is vitest's own default, `max(cpus - 1, 1)`. `TURBO_*` reaches a task in
 * strict env mode regardless; it is in `globalPassThroughEnv` only to satisfy
 * `noUndeclaredEnvVars`, and never in a task's `env` (it must not split the
 * cache by core count). Both branches return a number — a conditional
 * `maxWorkers` spread is what `guard-invariants` rules 2 and 22 forbid.
 */
const workerBudget = () => {
  const parallelism = availableParallelism();
  const turboConcurrency = Math.max(1, Number(process.env.TURBO_CONCURRENCY) || 1);
  return turboConcurrency > 1
    ? Math.max(1, Math.floor(parallelism / turboConcurrency))
    : Math.max(parallelism - 1, 1);
};

/**
 * Shared Vitest configuration: the base of {@link defineUnitProject}, the
 * root config's typecheck projects and `vitest.slow.config.ts`.
 */
export const sharedConfig = {
  resolve: { conditions: ["@dev/source"] },
  ssr: { resolve: { conditions: ["@dev/source"] } },
  test: {
    reporters: process.env.CI ? ["dot", "github-actions"] : ["default"],
    restoreMocks: true,
    // Every `vi.stubEnv` is undone after its test; a helper that needs a
    // sub-test boundary still calls `vi.unstubAllEnvs()` itself.
    unstubEnvs: true,
    // A date test must not depend on the runner's zone. Node re-reads `TZ` on
    // assignment, and `unstubEnvs` restores to this baseline. An OBJECT, so
    // {@link defineUnitProject} merges a package's `env` over it.
    env: { TZ: "UTC" },
    setupFiles: sharedSetupFiles,
    // CI semantics locally: an obsolete snapshot fails and a new one needs
    // `vitest -u` (the default, `new`, only reports it outside CI).
    update: "none" as const,
    maxWorkers: workerBudget(),
  },
};

/**
 * Coverage excludes shared by every config so `pnpm test:coverage` measures
 * production source only. Globs, not a file list, so a new helper is excluded
 * on creation; the leading underscore is load-bearing, because production
 * modules such as `aai-server/warm-harness.ts` match the un-prefixed shapes.
 */
export const sharedCoverageExclude = [
  "**/*.test.{ts,tsx}",
  "**/*.test-d.ts",
  "**/dist/**",
  "**/__snapshots__/**",
  "**/_test-utils.ts",
  "**/test-utils.ts",
  "**/*-test-utils.ts",
  "**/_*-setup.ts",
  "**/_test-matchers.ts",
  "**/_mock-*.ts",
  "**/_*-fakes.ts",
  "**/_*-harness.ts",
  "**/fixtures/**",
];

/**
 * Files the UNIT tier never collects. Tier membership is a naming convention,
 * so a rename is all it takes to move a test: each slow tier's package script
 * selects its own infix through `vitest.slow.config.ts`. `e2e*.test.ts` is
 * `aai-cli`'s e2e tier; the dot-directories are session scratch (studio
 * workspaces and template-contract runs) that can hold a stray `*.test.ts`.
 */
export const unitTierExclude = [
  ...configDefaults.exclude,
  "**/dist/**",
  "**/*.integration.test.{ts,tsx}",
  "**/*.scenario.test.{ts,tsx}",
  "**/*.eval.test.{ts,tsx}",
  "**/e2e*.test.{ts,tsx}",
  "**/.workspaces/**",
  "**/.eval-workspaces/**",
];

type TestOptions = NonNullable<ViteUserConfig["test"]>;

/** The four floors `package-test-wiring.test.ts` requires every package to name. */
export interface CoverageFloors {
  lines: number;
  functions: number;
  branches: number;
  statements: number;
}

/** What a package's `vitest.config.ts` passes to {@link defineUnitProject}. */
export interface UnitProjectOptions {
  /** The `--project` name; without it vitest uses the package.json name. */
  name: string;
  /** Collected files. Default `["**\/*.test.ts"]`. */
  include?: string[];
  /** APPENDED to {@link unitTierExclude}. */
  exclude?: string[];
  /** APPENDED to {@link sharedSetupFiles}. */
  setupFiles?: string[];
  /** MERGED over the shared `env`. */
  env?: Record<string, string>;
  /** APPENDED to {@link sharedCoverageExclude}. */
  coverageExclude?: string[];
  /** Ratchet: floors only move up, ~2-3 points under the measured actuals. */
  thresholds: CoverageFloors;
  /** Vite plugins (e.g. `aaiAgentPlugin()`). */
  plugins?: ViteUserConfig["plugins"];
  /**
   * Any other vitest option (`pool`, `testTimeout`, `globalSetup`, `globals`).
   * The merged keys above are not accepted here, so they cannot be replaced.
   */
  test?: Omit<TestOptions, "name" | "include" | "exclude" | "setupFiles" | "env" | "coverage">;
}

/**
 * A package's unit-tier project. Owns the tier excludes and the array/object
 * merges (`setupFiles`, `env`, coverage `exclude`) that a hand-written
 * `test: { ... }` would replace instead of extending.
 */
export function defineUnitProject(options: UnitProjectOptions): ViteUserConfig {
  return defineConfig({
    ...sharedConfig,
    plugins: options.plugins ?? [],
    test: {
      ...sharedConfig.test,
      ...options.test,
      name: options.name,
      include: options.include ?? ["**/*.test.ts"],
      exclude: [...unitTierExclude, ...(options.exclude ?? [])],
      setupFiles: [...sharedSetupFiles, ...(options.setupFiles ?? [])],
      env: { ...sharedConfig.test.env, ...options.env },
      coverage: {
        exclude: [...sharedCoverageExclude, ...(options.coverageExclude ?? [])],
        thresholds: options.thresholds,
      },
    },
  });
}
