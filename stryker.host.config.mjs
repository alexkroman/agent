import { base } from "./stryker.base.config.mjs";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...base,
  mutate: [
    "packages/aai/host/**/*.ts",
    "!packages/aai/host/**/*.test.ts",
    "!packages/aai/host/_test-*.ts",
    "!packages/aai/host/*-barrel.ts",
    "!packages/aai/host/fixtures/**",
    "!packages/aai/host/testing.ts",
    "!packages/aai/host/matchers.ts",
    "!packages/aai/host/unstorage-kv.ts",
  ],
  htmlReporter: { fileName: "reports/mutation/host/index.html" },
  thresholds: { high: 70, low: 50, break: 40 },
  incrementalFile: ".stryker-incremental-host.json",
};
