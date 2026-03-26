import { defineConfig } from "vitest/config";
import { sharedConfig } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    include: ["e2e.test.ts", "pack-build.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
