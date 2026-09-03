// Copyright 2026 the AAI authors. MIT license.
/**
 * How many turbo TASKS may run at once, when nobody has said.
 *
 * This is one half of a pair, and it only works as a pair. Turbo's concurrency
 * bounds tasks; each task spawns its own vitest worker pool, and
 * `vitest.shared.ts`'s `workerBudget()` divides `availableParallelism()` by
 * THIS number to size that pool. The product is what the machine actually
 * feels, and it lands on the core count for any value either side picks — which
 * is the whole design. `vitest.shared.ts` carries the measurements.
 *
 * It lived inline in `scripts/check.mjs`, which is the only caller that ever
 * set `TURBO_CONCURRENCY` — so the pair's other half read `undefined` from
 * every OTHER door and fell back to vitest's own `cores - 1` per task. On a
 * 4-core box `pnpm test` is `turbo run test` at turbo's default concurrency of
 * 10: ten tasks x three workers plus ten mains, ~40 processes on 4 cores. That
 * is the CORRECTNESS bug both files already describe, reachable from the
 * repo's own primary test command — measured as `aai-cli`'s bundler and
 * dev-server specs timing out under contention and passing in isolation on the
 * identical commit. `scripts/with-worker-budget.mjs` is the door that closes
 * it; this module exists so the two doors cannot compute different numbers.
 *
 * `availableParallelism()` rather than `cpus().length`, which is what
 * `check.mjs` used: they differ under a cgroup CPU quota, where `cpus()`
 * reports the HOST's cores. The pair's other half already reads
 * `availableParallelism()`, and a pair whose halves measure different machines
 * does not bound anything.
 */

import { availableParallelism } from "node:os";

/**
 * Leave room for each task's internal parallelism: half the cores as tasks,
 * with a floor of 2 so a single-core machine still overlaps a slow task with a
 * fast one rather than serializing the whole run.
 *
 * @returns {number}
 */
export function defaultTurboConcurrency() {
  return Math.max(2, Math.floor(availableParallelism() / 2));
}

/**
 * Set `TURBO_CONCURRENCY` unless the caller already chose one.
 *
 * An explicit value always wins — including one a CI job exports deliberately,
 * and including `1` for a serial run.
 *
 * @returns {string} the value in effect, for a caller that wants to report it
 */
export function boundTurboConcurrency() {
  process.env.TURBO_CONCURRENCY ??= String(defaultTurboConcurrency());
  return process.env.TURBO_CONCURRENCY;
}
