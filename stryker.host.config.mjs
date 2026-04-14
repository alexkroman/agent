/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  plugins: ["@stryker-mutator/vitest-runner"],
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
  testRunner: "vitest",
  testRunnerNodeArgs: ["--experimental-vm-modules"],
  reporters: ["html", "clear-text", "progress"],
  htmlReporter: { fileName: "reports/mutation/host/index.html" },
  thresholds: { high: 70, low: 50, break: 40 },
  incremental: true,
  incrementalFile: ".stryker-incremental-host.json",
  concurrency: 4,
  timeoutMS: 60000,
};
