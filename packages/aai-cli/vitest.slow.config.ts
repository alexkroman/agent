import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] } },
  test: {
    include: ["e2e.test.ts", "pack-build.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
