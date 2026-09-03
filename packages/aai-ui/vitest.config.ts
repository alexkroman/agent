import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude, sharedSetupFiles } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    // Project name for `--project aai-ui`; the workspace root discovers this
    // file by glob, so the name must live here (else it defaults to the
    // package.json name).
    name: "aai-ui",
    globals: true,
    include: ["**/*.test.{ts,tsx}"],
    setupFiles: [...sharedSetupFiles, "./src/_jsdom-setup.ts"],
    coverage: {
      // `contracts/` is neither production source nor test infrastructure, for
      // the reason `packages/aai/vitest.config.ts` gives: the capability roots
      // are re-export lists and the compatibility fixtures are never executed,
      // so at 0% they drag the package under floors that have nothing to do
      // with what they measure. `tsc` is what gates them.
      exclude: [...sharedCoverageExclude, "src/contracts/**"],
      // Ratchet: floors only move up. Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      thresholds: { lines: 94, functions: 90, branches: 89, statements: 94 },
    },
  },
});
