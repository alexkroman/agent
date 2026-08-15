import { defineConfig } from "vitest/config";
import { sharedConfig } from "./vitest.shared.ts";

/**
 * The three slow tiers, separated by what a test may TOUCH rather than by how
 * long it takes — a timeout is a proxy for that and stops being one as soon as
 * two tests are slow for unrelated reasons.
 *
 * - `integration` — multiple modules **in memory**. No filesystem writes, no
 *   subprocess, no port, no database. Slow because it does a lot of work
 *   (the three fast-check harnesses), not because it waits on anything.
 * - `scenario` — a real subprocess, a real HTTP/WebSocket port, a real bundler,
 *   or a real Postgres.
 * - `e2e` — full process spawn + Playwright.
 *
 * **No tier carries a `retry`.** The integration profile used to set `retry: 2`,
 * which classified its own failures as noise: it was a 3x multiplier on the cost
 * of learning about a real break, and the flakes it was written to absorb (the
 * pipeline timing specs that "failed first on a contended runner") were FIXED by
 * moving them onto virtual time — so what it covered afterwards was whatever
 * arrived later, invisibly. It is also actively wrong for the fast-check harnesses
 * in this profile, whose documented contract is that per-run state is torn down in
 * a `finally`: a retried property run is the documented way to converge the
 * shrinker on the wrong counterexample. If any tier ever wants one it is
 * `scenario`, where a genuinely environment-dependent suite could argue for it
 * with the in-memory tests out of the blast radius.
 */
const profiles = {
  integration: { timeout: 30_000, hookTimeout: 30_000 },
  scenario: { timeout: 120_000, hookTimeout: 120_000 },
  e2e: { timeout: 300_000, hookTimeout: 300_000 },
} as const;

const profileKey = (process.env.VITEST_PROFILE ?? "integration") as keyof typeof profiles;
const profile = profiles[profileKey] ?? profiles.integration;

/**
 * All three slow tiers, selected by `VITEST_PROFILE` with `VITEST_INCLUDE`
 * choosing the files — from a package's `test:integration` / `test:scenario` /
 * `test:e2e` script.
 *
 * Membership is a NAMING CONVENTION, so a new test lands in the right tier with no
 * config edit: `*.integration.test.ts` and `*.scenario.test.ts` are excluded by
 * every unit config and selected by the matching script.
 *
 * This config spreads `sharedConfig.test`, so it picks up `restoreMocks` and
 * the CI reporters the same way the unit projects do, and layers only the
 * timeout profile on top. It is the one config the workspace root does
 * NOT discover by glob, which is exactly why it has to inherit rather than
 * re-declare: before `restoreMocks` moved into `vitest.shared.ts` this was the
 * only suite in the repo running without it, leaking spies across the two
 * fast-check fuzz harnesses whose documented contract requires per-run
 * teardown.
 */
export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    testTimeout: profile.timeout,
    hookTimeout: profile.hookTimeout,
    include: process.env.VITEST_INCLUDE?.split(",") ?? ["**/*.test.ts"],
    pool: process.env.VITEST_POOL === "forks" ? "forks" : "threads",
  },
});
