import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/sandbox-integration.test.ts"],
  },
});
