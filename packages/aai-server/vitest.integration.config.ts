import { defineConfig } from "vitest/config";
import { sharedConfig } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    include: [
      "orchestrator-integration.test.ts",
      "ws-integration.test.ts",
      "fake-vm-integration.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    retry: 2,
  },
});
