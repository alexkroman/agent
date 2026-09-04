import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    // Project name for `--project aai-studio-server`; the workspace root discovers this
    // file by glob, so the name must live here (else it defaults to the
    // package.json name).
    name: "aai-studio-server",
    pool: "forks",
    include: ["**/*.test.ts"],
    // Same contended-check-run headroom rationale as aai-server.
    testTimeout: 20_000,
    // Both slow-tier infixes, per the convention in the root guide — excluded here
    // so a new one lands in its own tier with no config edit. This package owns
    // one scenario file today (studio-store-conformance.scenario.test.ts, run by
    // `check:scenario`) and no integration file; the comment used to claim
    // neither existed, which is the kind of stale note that talks the next
    // reader out of checking.
    exclude: ["**/*.integration.test.ts", "**/*.scenario.test.ts", "node_modules", "dist"],
    coverage: {
      exclude: [...sharedCoverageExclude, "src/index.ts", "modal_deploy.py"],
      // Ratchet seed for a new package: set just below the first measured
      // actuals; floors only move up from here.
      thresholds: { lines: 96, functions: 93, branches: 90, statements: 94 },
    },
  },
});
