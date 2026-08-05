import { defineConfig } from "vitest/config";
import { sharedConfig } from "./vitest.shared.ts";

const profiles = {
  integration: { timeout: 30_000, hookTimeout: 30_000, retry: 2 },
  e2e: { timeout: 300_000, hookTimeout: 300_000, retry: 0 },
} as const;

const profileKey = (process.env.VITEST_PROFILE ?? "integration") as keyof typeof profiles;
const profile = profiles[profileKey] ?? profiles.integration;

/**
 * Integration + e2e tiers, selected by `VITEST_INCLUDE` from a package's
 * `test:integration` / `test:e2e` script.
 *
 * This config spreads `sharedConfig.test`, so it picks up `restoreMocks` and
 * the CI reporters the same way the unit projects do, and layers only the
 * timeout/retry profile on top. It is the one config the workspace root does
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
    retry: profile.retry,
    include: process.env.VITEST_INCLUDE?.split(",") ?? ["**/*.test.ts"],
    pool: process.env.VITEST_POOL === "forks" ? "forks" : "threads",
  },
});
