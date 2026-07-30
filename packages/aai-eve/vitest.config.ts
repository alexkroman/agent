import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    restoreMocks: true,
    include: ["**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    coverage: {
      exclude: sharedCoverageExclude,
      // Ratchet: floors only move up. Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      thresholds: { lines: 78, functions: 72, branches: 62, statements: 77 },
    },
  },
});
