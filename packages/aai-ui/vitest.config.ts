import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    restoreMocks: true,
    globals: true,
    include: ["**/*.test.{ts,tsx}"],
    setupFiles: ["./_jsdom-setup.ts"],
    coverage: {
      exclude: sharedCoverageExclude,
      // Ratchet: floors only move up. Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      thresholds: { lines: 93, functions: 92, branches: 86, statements: 92 },
    },
  },
});
