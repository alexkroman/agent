import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Setup files EVERY project loads, whatever tier it runs in.
 *
 * Spread rather than assigned at each call site, and that is the whole design
 * problem: `setupFiles` is an ARRAY, so a package config writing
 * `setupFiles: ["./_jsdom-setup.ts"]` after `...sharedConfig.test` REPLACES
 * this list instead of extending it — silently. FOUR of the nine packages
 * declare their own, and `vitest.slow.config.ts` is a fifth config that does.
 * It is the same trap the root guide records for `test` itself
 * ("Shared test options live in `vitest.shared.ts` and must be SPREAD IN"),
 * which is how every package came to drop `reporters`.
 *
 * `packages/aai-templates/vitest-setup-wiring.test.ts` is what makes forgetting
 * the spread a failure rather than a silently unguarded suite: a partial rollout
 * of a gate reads exactly like a passing one.
 *
 * An absolute path, because a repo-root file referenced from nine different
 * package roots has no usable relative spelling — the same reason
 * `aai-server`'s `globalSetup` names `ensure-guest-harness.mjs` this way.
 */
export const sharedSetupFiles = [
  fileURLToPath(new URL("./scripts/fail-on-process-warning.mjs", import.meta.url)),
];

/**
 * How many test workers ONE vitest run may spawn.
 *
 * Turbo's concurrency caps how many TASKS run at once; it says nothing about
 * how many processes each one spawns, and vitest's own default is
 * `max(cpus - 1, 1)` per run. The product is what the machine actually feels,
 * and nothing bounded it: on a 4-core box `scripts/check.sh` computes
 * TURBO_CONCURRENCY=2 (`max(2, cores / 2)`), so `pnpm check` ran 2 test tasks x
 * 3 workers + 2 vitest mains = 8 processes on 4 cores.
 *
 * That is not a slowness bug, it is a CORRECTNESS one, and check.sh's own
 * comment says so — aai-server's credential tests run PBKDF2 at 600k
 * iterations, which stretches from ~300ms to ~750ms per hash under contention
 * and pushes whole tests past their timeout. It was measured costing a push:
 * `aai-cli#test:coverage` failed 4 tests in the full check (wall 364s against
 * `transform 806.78s`, i.e. ~2.2x oversubscribed) and passed 560/560 in
 * isolation on the identical commit. The concurrency cap alone could not
 * prevent that, because it was never the whole product.
 *
 * So each run gets `parallelism / TURBO_CONCURRENCY`, which holds the product at
 * the core count however turbo is invoked. With no TURBO_CONCURRENCY — a bare
 * `pnpm test:aai-cli`, where nothing else is competing — this reproduces
 * vitest's own default rather than inventing a different one, so a standalone
 * run is unchanged. **CI is therefore also unchanged**: its test matrix runs
 * `turbo run test:coverage --filter <one package>` and exports no
 * TURBO_CONCURRENCY, so every job keeps the full default budget.
 *
 * Verified end to end on 8 CPU-bound files through this very object, 4 cores:
 * TURBO_CONCURRENCY unset -> 3906ms (budget 3), =2 -> 4825ms (budget 2),
 * =4 -> 8949ms (budget 1). Monotonic, and the last matches a standalone
 * `--maxWorkers=1` at 9015ms. The knob was confirmed to work from a CONFIG FILE
 * and not only as a CLI flag (9015ms vs 2820ms), which is what this relies on.
 * Note a wall-clock A/B on a real suite proves nothing here: aai-cli's
 * dev-server specs measured 112s vs 109s at 1 vs 4 workers, because they are
 * dominated by subprocess spawn and I/O rather than worker parallelism — those
 * child processes are also why the naive worker arithmetic UNDERSTATES the load
 * this bound exists to contain.
 *
 * Both branches return a NUMBER: a conditional spread of an optional
 * `maxWorkers` is what `guard-invariants` rules 2 and 22 exist to stop.
 *
 * No `?? cpus().length` fallback: `engines` requires Node >= 26 and
 * `availableParallelism` has existed since 18.14, so as a NAMED ESM import a
 * missing one would throw at import time and never reach a fallback anyway.
 *
 * TURBO_CONCURRENCY does NOT need `globalPassThroughEnv` to reach a task, which
 * is worth recording because the opposite is this repo's standing rule and the
 * declaration was written first on that reasoning, before being measured.
 * `TURBO_*` is turbo's own namespace and reaches tasks whatever strict env mode
 * does to everything else. A/B on the real gate, `--force` each time: exported
 * and declared -> the task read 2; exported and UNdeclared -> still 2; not
 * exported at all -> unset, and this falls back to vitest's default of 3.
 *
 * It is declared there anyway, and for the honest reason: `noUndeclaredEnvVars`
 * flags this line otherwise, and a warning nothing fails on is precisely how
 * this repo ends up with rules that check nothing. Never in a task's `env` —
 * it changes how many processes run the tests, never what they conclude, so it
 * must not fragment the cache across core counts.
 */
const workerBudget = () => {
  const parallelism = availableParallelism();
  const turboConcurrency = Math.max(1, Number(process.env.TURBO_CONCURRENCY) || 1);
  return turboConcurrency > 1
    ? Math.max(1, Math.floor(parallelism / turboConcurrency))
    : Math.max(parallelism - 1, 1);
};

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
    // Turns an EventEmitter/AbortSignal listener leak into a failure — see
    // `sharedSetupFiles` above for why this cannot simply be assigned, and
    // `scripts/fail-on-process-warning.mjs` for why the signal needed a gate.
    setupFiles: sharedSetupFiles,
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
    // See `workerBudget` above: turbo's concurrency bounds TASKS, this bounds
    // the WORKERS each task spawns, and only the product is what the machine
    // feels. Spread into every package config via `...sharedConfig.test`.
    maxWorkers: workerBudget(),
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
