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
    //
    // The two MIDDLE tiers are excluded for the same reason even though this
    // package owns no infixed file: a rename is the documented way to move a
    // test out of the unit tier, and without the exclude the renamed file keeps
    // running here under a 5s budget — the tier convention silently not
    // applying. Latent, and it bites whoever first does the right thing.
    exclude: [
      "**/*.eval.test.ts",
      "**/*.integration.test.ts",
      "**/*.scenario.test.ts",
      "node_modules",
      "dist",
    ],
    coverage: {
      // The studio TARGET is excluded, and this is the one exclusion in the repo
      // that is not "test infrastructure": it only runs when a live API key and
      // a live studio are present, i.e. never in the unit run, so left in it
      // counts ~270 lines at 0% and drags the floors below what they measure.
      // What the floors do cover is everything a unit test CAN reach — the
      // runner, the assertion vocabulary, and the report — which is where a
      // silent regression would actually hide. (The level-1 SESSION target is no
      // longer here at all: it is published from
      // `@alexkroman1/aai-runtime/eval` and unit-tested in that package against
      // a scripted model.)
      exclude: [...sharedCoverageExclude, "studio-target.ts", "_gate.ts"],
      // Ratchet: floors only move up. Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      // Measured: 99.62 / 99.08 / 92.17 / 99.68.
      thresholds: { lines: 96, functions: 95, branches: 89, statements: 96 },
    },
  },
});
