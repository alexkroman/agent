import { defineConfig } from "vitest/config";
import { sharedConfig } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    include: ["pack-build.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
