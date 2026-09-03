// Copyright 2026 the AAI authors. MIT license.
/**
 * Run a turbo command with `TURBO_CONCURRENCY` bounded.
 *
 *   node scripts/with-worker-budget.mjs turbo run test
 *   node scripts/with-worker-budget.mjs turbo run test:coverage --affected --continue
 *
 * **Why a wrapper rather than a literal in `package.json`.** The number has to
 * come from the core count — see `scripts/_turbo-concurrency.mjs` for the pair
 * this is one half of, and `vitest.shared.ts` for the measurements — and a
 * package.json script cannot compute one. A hardcoded `TURBO_CONCURRENCY=2`
 * would hold the PRODUCT at the core count correctly (the other half divides by
 * whatever this says), but it would run a 32-core machine two tasks at a time,
 * so the cost lands on the biggest machines rather than the smallest.
 *
 * **Why every fan-out door and not just `pnpm test`.** `test`, `test:coverage`,
 * `test:integration`, `test:scenario`, `test:coverage:affected` and
 * `check:affected` all fan one task out across ten packages, and each was
 * unbounded. `scripts/check.mjs` bounds itself and is the reason this was
 * invisible: `pnpm check:local` passed on the very commit whose `pnpm test`
 * failed four specs on contention alone.
 *
 * **NOT `test:e2e`**, which already passes `--concurrency=1` — one task, and
 * bounding a serial run buys nothing. And nothing in CI's test matrix goes
 * through here: those jobs are `turbo run test:coverage --filter <one package>`,
 * a single task that should keep the full worker budget, which is exactly what
 * an unset `TURBO_CONCURRENCY` gives it.
 *
 * Flags of this script's own would go before the command; it has none today, so
 * `parseLeadingFlags` is here for the error it produces on a stray leading flag
 * rather than silently forwarding it to turbo. Everything from the first
 * non-flag token on is the command's business — `--affected` and `--continue`
 * are turbo's and are never interpreted here.
 */

import { parseLeadingFlags } from "./_args.mjs";
import { runChild } from "./_run-child.mjs";
import { boundTurboConcurrency } from "./_turbo-concurrency.mjs";

const USAGE_EXIT = 2;

const { rest: command } = parseLeadingFlags({
  script: import.meta.url,
  options: {},
});

if (command.length === 0) {
  console.error("with-worker-budget: no command given");
  console.error("\nUsage: node scripts/with-worker-budget.mjs turbo run <task>…");
  process.exit(USAGE_EXIT);
}

const concurrency = boundTurboConcurrency();

runChild(command, {
  env: { TURBO_CONCURRENCY: concurrency },
  label: "with-worker-budget",
  // A Ctrl-C here is the developer asking to stop a test run, not a failure.
  interruptExitCode: 0,
});
