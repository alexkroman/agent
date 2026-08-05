import { base } from "./stryker.base.config.mjs";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...base,
  mutate: [
    "packages/aai-ui/**/*.{ts,tsx}",
    "!packages/aai-ui/**/*.test.{ts,tsx}",
    "!packages/aai-ui/**/_*test-utils.ts",
    "!packages/aai-ui/_jsdom-setup.ts",
    "!packages/aai-ui/fixtures/**",
    "!packages/aai-ui/dist/**",
    "!packages/aai-ui/index.ts",
    // Build-time and tooling entry points: no unit tests cover them, so every
    // mutant is an unavoidable survivor that only depresses the score.
    "!packages/aai-ui/build-default-client.ts",
    "!packages/aai-ui/tsdown.config.ts",
    "!packages/aai-ui/vitest.config.ts",
  ],
  htmlReporter: { fileName: "reports/mutation/ui/index.html" },
  thresholds: { high: 70, low: 50, break: 40 },
  incrementalFile: ".stryker-incremental-ui.json",
};
