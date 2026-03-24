import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e_test.ts", "pack_build_test.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
