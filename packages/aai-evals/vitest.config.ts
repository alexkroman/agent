import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    // Project name for `--project aai-evals`; the workspace root discovers this
    // file by glob, so the name must live here (else it defaults to the
    // package.json name).
    name: "aai-evals",
    include: ["**/*.test.ts"],
    // Tier membership is the `.eval.` infix, excluded here and selected by
    // `test:eval` — the same convention the two other slow tiers use, so a new
    // eval needs no config edit.
    exclude: ["**/*.eval.test.ts", "node_modules", "dist"],
    coverage: {
      // The two TARGETS are excluded, and this is the one exclusion in the repo
      // that is not "test infrastructure": they only run when a live API key and
      // a live studio are present, i.e. never in the unit run, so left in they
      // count ~350 lines at 0% and drag the floors below what they measure. What
      // the floors do cover is everything a unit test CAN reach — the runner,
      // the assertion vocabulary, and the report — which is where a silent
      // regression would actually hide.
      exclude: [...sharedCoverageExclude, "session-target.ts", "studio-target.ts", "_gate.ts"],
      // Ratchet: floors only move up. Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      // Measured: 98.26 / 96.96 / 89.57 / 97.70.
      thresholds: { lines: 95, functions: 94, branches: 88, statements: 95 },
    },
  },
});
