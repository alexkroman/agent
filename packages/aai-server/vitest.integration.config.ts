import { defineConfig } from "vitest/config";
import { sharedConfig } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    include: ["src/sandbox-integration.test.ts", "src/sandbox-conformance.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
