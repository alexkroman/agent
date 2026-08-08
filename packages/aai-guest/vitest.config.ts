import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    // Project name for `--project aai-guest`; the workspace root discovers this
    // file by glob, so the name must live here (else it defaults to the
    // package.json name).
    name: "aai-guest",
    include: ["**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    coverage: {
      exclude: [...sharedCoverageExclude],
      // Ratchet: floors only move up. Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      // main() — the HTTP server + upgrade wiring — is exercised by the
      // smoke path against the built artifact, not by unit tests, which is
      // what keeps these floors below the other packages'.
      // Actuals (2026-08): lines 85.3, functions 84.03, branches 73.59, statements 83.51.
      thresholds: { lines: 83, functions: 81, branches: 71, statements: 81 },
    },
  },
});
