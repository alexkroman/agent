/** Shared Stryker config. Import and spread in per-scope configs. */
export const base = {
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  testRunnerNodeArgs: ["--experimental-vm-modules"],
  reporters: ["html", "clear-text", "progress"],
  incremental: true,
  concurrency: 4,
  timeoutMS: 60000,
};
