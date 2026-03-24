import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["**/*_test.{ts,tsx}"],
    setupFiles: ["./_jsdom_setup.ts"],
  },
});
