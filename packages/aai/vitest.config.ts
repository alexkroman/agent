import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude, sharedSetupFiles } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    // Project name for `--project aai`; the workspace root discovers this
    // file by glob, so the name must live here (else it defaults to the
    // package.json name).
    name: "aai",
    include: ["**/*.test.ts"],
    // Slow-tier membership is a naming convention, not a filename list: both
    // infixes are excluded here and each is selected by its own script
    // (`test:integration`, `test:scenario`). The three named files this used to
    // also exclude (pentest, run-code-sandbox, integration.test.ts) had all been
    // deleted, and nothing noticed — which is the failure mode a convention avoids.
    exclude: ["**/*.integration.test.ts", "**/*.scenario.test.ts", "node_modules", "dist"],
    setupFiles: [...sharedSetupFiles, "./src/sdk/_test-matchers.ts"],
    coverage: {
      // `contracts/` is neither production source nor test infrastructure: the
      // capability roots are pure re-export lists and the compatibility
      // fixtures are compiled by `tsc`, never executed. Left in, coverage
      // counts twenty-odd files at 0% and drags the package under floors that
      // have nothing to do with what they measure.
      exclude: [...sharedCoverageExclude, "src/contracts/**"],
      // Ratchet: floors only move up. Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      thresholds: { lines: 92, functions: 88, branches: 83, statements: 90 },
    },
  },
});
