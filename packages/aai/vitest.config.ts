import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    // Project name for `--project aai`; the workspace root discovers this
    // file by glob, so the name must live here (else it defaults to the
    // package.json name).
    name: "aai",
    include: ["**/*.test.ts"],
    // Integration-tier membership is a naming convention, not a filename
    // list: `*.integration.test.ts` is excluded here and selected by
    // `test:integration`. The three named files this used to also exclude
    // (pentest, run-code-sandbox, integration.test.ts) had all been deleted,
    // and nothing noticed — which is the failure mode a convention avoids.
    exclude: ["**/*.integration.test.ts", "node_modules", "dist"],
    setupFiles: ["./sdk/_test-matchers.ts"],
    coverage: {
      exclude: sharedCoverageExclude,
      // Ratchet: floors only move up. Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      thresholds: { lines: 91, functions: 87, branches: 81, statements: 89 },
    },
  },
});
