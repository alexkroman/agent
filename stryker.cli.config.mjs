/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: [
    "packages/aai-cli/_api-client.ts",
    "packages/aai-cli/_bundler.ts",
    "packages/aai-cli/_config.ts",
    "packages/aai-cli/_deploy.ts",
    "packages/aai-cli/_init.ts",
    "packages/aai-cli/_dev-server.ts",
    "packages/aai-cli/_templates.ts",
    "packages/aai-cli/secret.ts",
  ],
  testRunner: "vitest",
  testRunnerNodeArgs: ["--experimental-vm-modules"],
  reporters: ["html", "clear-text", "progress"],
  htmlReporter: { fileName: "reports/mutation/cli/index.html" },
  thresholds: { high: 70, low: 50, break: 40 },
  incremental: true,
  incrementalFile: ".stryker-incremental-cli.json",
  concurrency: 4,
  timeoutMS: 60000,
};
