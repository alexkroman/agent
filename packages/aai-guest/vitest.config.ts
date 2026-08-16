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
    // The slow tiers are a NAMING CONVENTION (`*.integration.test.ts`,
    // `*.scenario.test.ts`), and a rename only relocates a file if the unit
    // config declines it. Without these two globs a rename left the file in
    // the unit tier AND in the slow one — which is why the compensating
    // `timeout: 120_000`s in studio-build/studio-test were written instead of
    // the tier being used. The package owns no infixed file yet; the excludes
    // are what make writing one possible.
    exclude: ["node_modules", "dist", "**/*.integration.test.ts", "**/*.scenario.test.ts"],
    coverage: {
      exclude: [...sharedCoverageExclude],
      // Ratchet: floors only move up. Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      // main() — the HTTP server + upgrade wiring — is exercised by the
      // smoke path against the built artifact, not by unit tests, which is
      // what keeps these floors below the other packages'.
      // Actuals (2026-08): lines 85.79, functions 84.49, branches 75.58, statements 83.88.
      thresholds: { lines: 83, functions: 82, branches: 72, statements: 81 },
    },
  },
});
