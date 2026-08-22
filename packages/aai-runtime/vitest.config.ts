import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    // Project name for `--project aai-runtime`; the workspace root discovers
    // this file by glob, so the name must live here (else it defaults to the
    // package.json name).
    name: "aai-runtime",
    // Forks, like aai-server: this package opens sockets, spawns the workflow
    // world and installs process-wide dispatchers, so a leaked handle in one
    // file must not reach the next.
    pool: "forks",
    include: ["**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.integration.test.ts",
      "**/*.scenario.test.ts",
    ],
    coverage: {
      // `contracts/` is neither production source nor test infrastructure: the
      // capability roots are re-export lists and the frozen examples are never
      // executed, so both would count at 0% and drag the package under floors
      // that have nothing to do with what they measure.
      exclude: [...sharedCoverageExclude, "contracts/**", "fixtures/**", "integration/**"],
      // Ratchet: floors only move up. Seeded from the first measured run after
      // the split; raise to ~2-3 points below actuals when there is headroom.
      thresholds: { lines: 0, functions: 0, branches: 0, statements: 0 },
    },
  },
});
