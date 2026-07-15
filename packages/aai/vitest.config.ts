import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    restoreMocks: true,
    include: ["**/*.test.ts"],
    exclude: [
      "**/pentest.test.ts",
      "**/run-code-sandbox.test.ts",
      "**/integration.test.ts",
      "**/*.integration.test.ts",
      "node_modules",
      "dist",
    ],
    setupFiles: ["./sdk/_test-matchers.ts"],
    coverage: {
      exclude: sharedCoverageExclude,
      // Ratchet: floors only move up. Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      thresholds: { lines: 87, functions: 84, branches: 73, statements: 85 },
    },
  },
});
