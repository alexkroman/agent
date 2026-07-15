/**
 * Shared Vitest configuration used by the root workspace config
 * and package-specific configs (slow tests, integration tests).
 */
export const sharedConfig = {
  resolve: { conditions: ["@dev/source"] },
  ssr: { resolve: { conditions: ["@dev/source"] } },
  test: {
    reporters: process.env.CI ? ["dot", "github-actions"] : ["default"],
  },
};

/**
 * Coverage excludes shared by the root config and per-package configs so
 * `pnpm test:coverage` measures the same file set everywhere: production
 * source only, no test infrastructure.
 */
export const sharedCoverageExclude = [
  "**/*.test.{ts,tsx}",
  "**/*.test-d.ts",
  "**/dist/**",
  "**/__snapshots__/**",
  // Test infrastructure: helpers, fakes, and setup files that exist only
  // for tests must not count toward (or against) production coverage.
  "**/_test-utils.ts",
  "**/test-utils.ts",
  "**/_react-test-utils.ts",
  "**/_jsdom-setup.ts",
  "**/_test-matchers.ts",
  "**/_mock-api.ts",
  "**/_mock-registry.ts",
  "**/_mock-ws.ts",
  "**/_pipeline-test-fakes.ts",
  "**/fixtures/**",
];
