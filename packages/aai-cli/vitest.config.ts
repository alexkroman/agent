import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    // Project name for `--project aai-cli`; the workspace root discovers this
    // file by glob, so the name must live here (else it defaults to the
    // package.json name).
    name: "aai-cli",
    include: ["**/*.test.ts"],
    // `**/*.integration.test.ts` is the tier convention (see the root guide):
    // the unit config excludes it and `test:integration` selects it, so a new
    // integration test needs no config edit. Note `integration.test.ts` and
    // `integration-edge-cases.test.ts` in this package are deliberately UNIT
    // tests — only the `.integration.` infix decides the tier.
    exclude: ["e2e*.test.ts", "**/*.integration.test.ts", "node_modules", "dist"],
    // Isolates the global config dir (API key + approved servers) from the
    // developer's real one — see _test-setup.ts.
    setupFiles: ["./_test-setup.ts"],
    coverage: {
      // cli.ts is the process entry point — exercised by e2e, not unit tests.
      exclude: [...sharedCoverageExclude, "cli.ts"],
      // Ratchet: floors only move up. Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      thresholds: { lines: 92, functions: 87, branches: 82, statements: 89 },
    },
  },
});
