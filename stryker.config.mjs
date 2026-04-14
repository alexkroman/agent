/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: [
    "packages/aai/sdk/**/*.ts",
    "!packages/aai/sdk/**/*.test.ts",
    "!packages/aai/sdk/**/*.test-d.ts",
    "!packages/aai/sdk/_test-*.ts",
    "!packages/aai/sdk/*-barrel.ts",
  ],
  testRunner: "vitest",
  testRunnerNodeArgs: ["--experimental-vm-modules"],
  reporters: ["html", "clear-text", "progress"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  thresholds: { high: 80, low: 60, break: 50 },
  concurrency: 4,
  timeoutMS: 30000,
};
