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
    // All three slow-tier infixes, per the convention in the root guide —
    // excluded here so a new one lands in its own tier with no config edit. This
    // package owns one scenario file (studio-store-conformance.scenario.test.ts,
    // run by `check:scenario`), one EVAL file (studio-starter.eval.test.ts, run
    // by `check:eval`) and no integration file; the comment used to claim
    // neither of the first two existed, which is the kind of stale note that
    // talks the next reader out of checking.
    exclude: [
      "**/*.eval.test.ts",
      "**/*.integration.test.ts",
      "**/*.scenario.test.ts",
      "node_modules",
      "dist",
      // The materialized workspaces a template-contract run writes
      // (`studio-template-contract.ts`), which carry an `agent.eval.test.ts` and
      // a `vitest.config.ts` of their own. They are removed in a `finally`, so
      // this only matters for a run that was killed — but a leaked tree that
      // vitest COLLECTS turns a stale scratch directory into a red unit run.
      "src/.eval-workspaces/**",
    ],
    coverage: {
      // `studio-eval-target.ts` is the one exclusion here that is not "test
      // infrastructure": all but one of its functions need a live API key and a
      // live studio, i.e. never run in the unit run, so left in it counts ~250
      // lines at near 0% and drags the floors below what they measure. The
      // exception is `readTurn`, the stream-reading seam, which
      // `studio-eval-target.test.ts` drives with canned SSE — a file staying out
      // of the coverage NUMBERS is not the same as it going untested, and that
      // half is where a break would be silent.
      exclude: [
        ...sharedCoverageExclude,
        "src/index.ts",
        "src/studio-eval-target.ts",
        "modal_deploy.py",
      ],
      // Ratchet seed for a new package: set just below the first measured
      // actuals; floors only move up from here.
      thresholds: { lines: 96, functions: 93, branches: 90, statements: 94 },
    },
  },
});
