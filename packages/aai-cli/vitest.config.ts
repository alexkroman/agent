import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["**/*_test.{ts,tsx}"],
    exclude: ["pack_build_test.ts", "node_modules", "dist"],
  },
});
