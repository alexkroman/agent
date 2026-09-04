import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude, sharedSetupFiles } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    // Project name for `--project aai-cli`; the workspace root discovers this
    // file by glob, so the name must live here (else it defaults to the
    // package.json name).
    name: "aai-cli",
    include: ["**/*.test.ts"],
    // The two infixes are the tier convention (see the root guide): the unit
    // config excludes both and `test:integration` / `test:scenario` select them,
    // so a new slow test needs no config edit. Note `integration.test.ts` and
    // `integration-edge-cases.test.ts` in this package are deliberately UNIT
    // tests — only the `.integration.` / `.scenario.` INFIX decides the tier.
    exclude: [
      "src/e2e*.test.ts",
      "**/*.integration.test.ts",
      "**/*.scenario.test.ts",
      "node_modules",
      "dist",
    ],
    // Isolates the global config dir (API key + approved servers) from the
    // developer's real one — see _test-setup.ts.
    setupFiles: [...sharedSetupFiles, "./src/_test-setup.ts"],
    coverage: {
      // cli.ts is the process entry point — exercised by e2e, not unit tests.
      exclude: [...sharedCoverageExclude, "src/cli.ts"],
      // Ratchet: floors only move up. Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      thresholds: { lines: 92, functions: 87, branches: 82, statements: 89 },
    },
  },
});
