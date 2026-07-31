import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    restoreMocks: true,
    include: ["**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    coverage: {
      exclude: [...sharedCoverageExclude],
      // Ratchet: floors only move up. Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      // main() — the HTTP server + upgrade wiring — is exercised by the
      // smoke path against the built artifact, not by unit tests, which is
      // what keeps these floors below the other packages'.
      thresholds: { lines: 55, functions: 56, branches: 56, statements: 56 },
    },
  },
});
