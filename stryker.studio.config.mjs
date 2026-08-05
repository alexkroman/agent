import { base } from "./stryker.base.config.mjs";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...base,
  mutate: [
    "packages/aai-studio-server/**/*.ts",
    "!packages/aai-studio-server/**/*.test.ts",
    "!packages/aai-studio-server/_*test-utils.ts",
    "!packages/aai-studio-server/_test-*.ts",
    "!packages/aai-studio-server/dist/**",
    "!packages/aai-studio-server/index.ts",
    "!packages/aai-studio-server/tsdown.config.ts",
    "!packages/aai-studio-server/vitest.config.ts",
    // The coding agent's system-prompt text. Mutants here are string edits to
    // prose no assertion can meaningfully pin, so they survive by
    // construction — the prompt's contract is covered by studio-prompt.test.ts
    // instead.
    "!packages/aai-studio-server/studio-preamble.ts",
  ],
  htmlReporter: { fileName: "reports/mutation/studio/index.html" },
  thresholds: { high: 70, low: 50, break: 40 },
  incrementalFile: ".stryker-incremental-studio.json",
};
