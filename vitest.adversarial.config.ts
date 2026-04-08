import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/aai-server/adversarial/*.test.ts"],
    testTimeout: 300_000, // 5 minutes per test
    hookTimeout: 180_000, // 3 minutes for setup/teardown
    pool: "forks",
    sequence: { concurrent: false },
    reporters: ["verbose"],
  },
});
