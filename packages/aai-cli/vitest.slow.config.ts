import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e.test.ts", "pack-build.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
