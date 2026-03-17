import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["sdk/**/*_test.ts", "ui/**/*_test.{ts,tsx}", "cli/**/*_test.{ts,tsx}"],
  },
});
