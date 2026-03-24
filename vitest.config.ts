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
        // Sandbox files run inside secure-exec isolates, not vitest.
        // Covered by integration test (pnpm test:integration).
        "**/sandbox.ts",
        "**/sandbox_harness.ts",
        "**/sandbox_integration.ts",
        "**/build_harness.ts",
        // Harness runtime is bundled by Vite into CJS for the isolate.
        "**/_harness_runtime.ts",
        // CLI entry point and interactive prompts can't be unit tested.
        "**/cli.ts",
        "**/_prompts.tsx",
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
          exclude: ["pack_build_test.ts", "e2e_test.ts", "node_modules", "dist"],
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
