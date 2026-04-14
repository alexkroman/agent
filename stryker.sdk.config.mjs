/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: [
    // Only files with real conditional/parsing logic worth mutating
    "packages/aai/sdk/protocol.ts",
    "packages/aai/sdk/manifest.ts",
    "packages/aai/sdk/_internal-types.ts",
    "packages/aai/sdk/system-prompt.ts",
    // Excluded: constants.ts (literals), kv.ts (types), utils.ts (trivial),
    // define.ts (simple factories), ws-upgrade.ts (13 lines), index.ts (barrel)
  ],
  testRunner: "vitest",
  testRunnerNodeArgs: ["--experimental-vm-modules"],
  reporters: ["html", "clear-text", "progress"],
  htmlReporter: { fileName: "reports/mutation/sdk/index.html" },
  thresholds: { high: 80, low: 60, break: 50 },
  incremental: true,
  incrementalFile: ".stryker-incremental-sdk.json",
  concurrency: 4,
  timeoutMS: 30000,
};
