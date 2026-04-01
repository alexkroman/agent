import { defineConfig } from "vitest/config";
import { sharedConfig } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    restoreMocks: true,
    globals: true,
    include: ["**/*.test.{ts,tsx}"],
    setupFiles: ["./_jsdom-setup.ts"],
  },
});
