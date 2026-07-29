/** Shared Stryker config. Import and spread in per-scope configs. */
export const base = {
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  // TypeScript 7 removed the JS API (`ts.parseConfigFileTextToJson`) that
  // Stryker's sandbox tsconfig preprocessor calls, crashing every run. In
  // place mode skips that preprocessor entirely. Stryker restores the
  // working tree from .stryker-tmp/backup-* when the run ends — do not run
  // vitest (or edit source) concurrently with a mutation run.
  inPlace: true,
  testRunnerNodeArgs: ["--experimental-vm-modules"],
  reporters: ["html", "clear-text", "progress"],
  incremental: true,
  concurrency: 4,
  timeoutMS: 60000,
};
