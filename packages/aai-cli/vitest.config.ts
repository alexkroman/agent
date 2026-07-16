import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    restoreMocks: true,
    include: ["**/*.test.ts"],
    exclude: ["e2e*.test.ts", "node_modules", "dist"],
    coverage: {
      // cli.ts is the process entry point — exercised by e2e, not unit tests.
      exclude: [...sharedCoverageExclude, "cli.ts"],
      // Ratchet: floors only move up. Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      thresholds: { lines: 76, functions: 82, branches: 65, statements: 74 },
    },
  },
});
