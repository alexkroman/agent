import { defineConfig } from "vitest/config";
import { sharedConfig } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    restoreMocks: true,
    include: ["**/*.test.ts"],
    exclude: [
      "sandbox-integration.test.ts",
      "sandbox-conformance.test.ts",
      "ws-integration.test.ts",
      "node_modules",
      "dist",
    ],
  },
});
