import { base } from "./stryker.base.config.mjs";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...base,
  mutate: [
    "packages/aai/sdk/protocol.ts",
    "packages/aai/sdk/manifest.ts",
    "packages/aai/sdk/_internal-types.ts",
    "packages/aai/sdk/system-prompt.ts",
  ],
  htmlReporter: { fileName: "reports/mutation/sdk/index.html" },
  thresholds: { high: 80, low: 60, break: 50 },
  incrementalFile: ".stryker-incremental-sdk.json",
  timeoutMS: 30000,
};
