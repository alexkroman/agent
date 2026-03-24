import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["packages/*/"],
      exclude: [
        "**/*_test.{ts,tsx}",
        "**/_test_utils.ts",
        "**/templates/**",
        "**/dist/**",
        "**/__snapshots__/**",
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 65,
        statements: 70,
      },
    },
    projects: [
      {
        test: {
          name: "aai",
          root: "packages/aai",
          globals: true,
          include: ["**/*_test.ts"],
        },
      },
      {
        test: {
          name: "aai-ui",
          root: "packages/aai-ui",
          globals: true,
          include: ["**/*_test.{ts,tsx}"],
          setupFiles: ["./_jsdom_setup.ts"],
        },
      },
      {
        test: {
          name: "aai-cli",
          root: "packages/aai-cli",
          globals: true,
          include: ["**/*_test.{ts,tsx}"],
          exclude: ["pack_build_test.ts", "node_modules", "dist"],
        },
      },
      {
        test: {
          name: "aai-server",
          root: "packages/aai-server",
          globals: true,
          include: ["**/*_test.ts"],
        },
      },
    ],
  },
});
