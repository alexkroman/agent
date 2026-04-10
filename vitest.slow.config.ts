import { defineConfig } from "vitest/config";
import { sharedConfig } from "./vitest.shared.ts";

const profiles = {
	integration: { timeout: 30_000, hookTimeout: 30_000, retry: 2 },
	e2e: { timeout: 300_000, hookTimeout: 300_000, retry: 0 },
	docker: { timeout: 600_000, hookTimeout: 120_000, retry: 0 },
	gvisor: { timeout: 30_000, hookTimeout: 15_000, retry: 0 },
} as const;

const profileKey = (process.env.VITEST_PROFILE ?? "integration") as keyof typeof profiles;
const profile = profiles[profileKey] ?? profiles.integration;

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
