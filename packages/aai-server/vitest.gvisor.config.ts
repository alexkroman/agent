import { defineConfig } from "vitest/config";
import { sharedConfig } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    include: ["packages/aai-server/gvisor-integration.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 15_000,
  },
});
