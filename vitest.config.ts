import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: [
      "packages/aai/**/*_test.ts",
      "packages/aai-ui/**/*_test.{ts,tsx}",
      "packages/aai-cli/**/*_test.{ts,tsx}",
    ],
    setupFiles: ["packages/aai-ui/_jsdom_setup.ts"],
  },
});
