/**
 * Shared Vitest configuration used by the root workspace config
 * and package-specific configs (slow tests, integration tests).
 */
export const sharedConfig = {
  resolve: { conditions: ["@dev/source"] },
  ssr: { resolve: { conditions: ["@dev/source"] } },
  test: {
    reporters: process.env.CI ? ["dot", "github-actions"] : ["default"],
    // Every suite in the repo restores spies between tests, so this belongs
    // here rather than being re-declared per package. It is also the option
    // the root config's drift list names as one several projects had dropped.
    restoreMocks: true,
    // The same argument for `vi.stubEnv`, which had no central counterpart:
    // 17 files stubbed env vars and only some of them unstubbed, so a stub
    // outlived its test and leaked into every later test in the file. The
    // hand-rolled `vi.unstubAllEnvs()` calls this replaces were also the
    // thing being forgotten — `host-env.test.ts`, `integration.test.ts` and
    // `studio-routes.test.ts` had none at all, and three more unstubbed in
    // only some of the tests that stubbed. Test-scoped env is the only sane
    // default; a helper or fast-check harness that needs a SUB-test boundary
    // still calls `vi.unstubAllEnvs()` itself.
    unstubEnvs: true,
    // Snapshots behave the same locally as they do in CI.
    //
    // Vitest resolves this from `process.env.CI` by default: 'new' locally
    // (write anything missing, merely REPORT anything obsolete) and 'none' in
    // CI (write nothing, FAIL on obsolete). That split is a green local
    // `pnpm check` alongside a red CI job — which is exactly what happened:
    // a stale `aai-ui` export snapshot, left behind by a test that stopped
    // taking one mid-edit, printed "1 obsolete" locally and failed the
    // `test (aai-ui)` job with all 340 tests passing.
    //
    // Pinning it to 'none' costs one thing and it is the right cost: adding
    // or changing a snapshot now needs an explicit `vitest -u`, which is
    // already true of every change that has to survive CI. `--update` still
    // wins, since a CLI flag overrides config.
    update: "none" as const,
  },
};

/**
 * Coverage excludes shared by the root config and per-package configs so
 * `pnpm test:coverage` measures the same file set everywhere: production
 * source only, no test infrastructure.
 */
export const sharedCoverageExclude = [
  "**/*.test.{ts,tsx}",
  "**/*.test-d.ts",
  "**/dist/**",
  "**/__snapshots__/**",
  // Test infrastructure: helpers, fakes, harnesses, and setup files that
  // exist only for tests must not count toward (or against) production
  // coverage.
  //
  // These are globs rather than a filename allowlist on purpose: the list was
  // previously enumerated file by file, so a new `_mock-foo.ts` or
  // `_bar-harness.ts` silently counted as production source and dragged a
  // package's coverage floor down for a reason nobody would connect to this
  // file. The leading underscore is load-bearing — production modules like
  // `aai-server/warm-harness.ts` and `aai-ui/session-core-audio-setup.ts`
  // match the un-prefixed shapes and must stay measured.
  "**/_test-utils.ts",
  "**/test-utils.ts",
  "**/*-test-utils.ts",
  "**/_*-setup.ts",
  "**/_test-matchers.ts",
  "**/_mock-*.ts",
  "**/_*-fakes.ts",
  "**/_*-harness.ts",
  "**/fixtures/**",
];
