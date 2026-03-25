import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] } },
  test: {
    include: ["src/sandbox-integration.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
