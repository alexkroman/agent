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
      // `gate.ts` is excluded because importing it RESOLVES a credential and
      // ANNOUNCES at import time, which is why nothing the unit tier loads may
      // import it (`konsistent.json`'s `eval-gate-is-not-unit-tier`) and so why
      // it can carry no co-located spec.
      //
      // The studio TARGET used to be excluded beside it — the one exclusion in
      // the repo that was not "test infrastructure", because all but one of its
      // functions needed a live key and a live studio. It is not in this package
      // any more: it is `aai-studio-server/src/studio-eval-target.ts`, and that
      // package's own config carries the exclusion and the argument.
      //
      // What the floors cover is everything a unit test CAN reach — the runner,
      // the assertion vocabulary, the env vocabulary and the report — which is
      // where a silent regression would actually hide. (The level-1 SESSION
      // target is not here at all: it is published from
      // `@alexkroman1/aai-runtime/eval` and unit-tested in that package against
      // a scripted model.)
      exclude: [...sharedCoverageExclude, "src/gate.ts"],
      // Ratchet: floors only move up. Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      // Measured: 99.57 / 98.92 / 96.08 / 99.63, over what is left after the
      // studio eval moved to `aai-studio-server`.
      thresholds: { lines: 96, functions: 95, branches: 89, statements: 96 },
    },
  },
});
