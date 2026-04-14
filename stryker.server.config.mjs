/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: [
    "packages/aai-server/ndjson-transport.ts",
    "packages/aai-server/orchestrator.ts",
    "packages/aai-server/sandbox.ts",
    "packages/aai-server/sandbox-vm.ts",
    "packages/aai-server/ssrf.ts",
    "packages/aai-server/secrets.ts",
    "packages/aai-server/middleware.ts",
    "packages/aai-server/bundle-store.ts",
  ],
  testRunner: "vitest",
  testRunnerNodeArgs: ["--experimental-vm-modules"],
  reporters: ["html", "clear-text", "progress"],
  htmlReporter: { fileName: "reports/mutation/server/index.html" },
  thresholds: { high: 70, low: 50, break: 40 },
  incremental: true,
  incrementalFile: ".stryker-incremental-server.json",
  concurrency: 4,
  timeoutMS: 60000,
};
