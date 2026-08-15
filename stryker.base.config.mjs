/**
 * Shared Stryker config. Import and spread in per-scope configs.
 *
 * **This is a manual DIAGNOSTIC, not a tier and not a gate**, and `inPlace` below
 * is why it can never be one: Stryker mutates the real working tree and restores
 * it from `.stryker-tmp/backup-*` afterwards, so a check that edits the tree it is
 * checking cannot be a pre-push hook, cannot share a CI checkout, and cannot run
 * beside vitest. One scope survives (`stryker.sdk.config.mjs`, `pnpm
 * test:mutate:sdk`); read the score off the HTML report.
 *
 * `incremental` is right for that audience and wrong for any other:
 * `.gitignore` carries `.stryker-incremental*.json`, so the state never leaves the
 * machine. It makes a developer's re-run cheap and could not warm a CI run —
 * committing it would mean a multi-megabyte JSON churning on every source edit,
 * and caching it would mean a score printed for code the run never mutated.
 */
export const base = {
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  // TypeScript 7 removed the JS API (`ts.parseConfigFileTextToJson`) that
  // Stryker's sandbox tsconfig preprocessor calls, crashing every run. In
  // place mode skips that preprocessor entirely. Stryker restores the
  // working tree from .stryker-tmp/backup-* when the run ends — do not run
  // vitest (or edit source) concurrently with a mutation run.
  //
  // That restore is byte-level and NOT mode-level: `packages/aai-cli/bin.mjs`
  // comes back 644 after every run, so `git status` shows a mode change and
  // the published bin would lose its executable bit if committed that way.
  // `chmod +x packages/aai-cli/bin.mjs` after a run, and check `git status`
  // before committing.
  inPlace: true,
  testRunnerNodeArgs: ["--experimental-vm-modules"],
  reporters: ["html", "clear-text", "progress"],
  incremental: true,
  concurrency: 4,
  timeoutMS: 60000,
};
