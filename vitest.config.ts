import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["packages/*/"],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/_test-utils.ts",
        "**/templates/**",
        "**/dist/**",
        "**/__snapshots__/**",
        // Sandbox files run inside secure-exec isolates, not vitest.
        // Covered by integration test (pnpm test:integration).
        "**/sandbox.ts",
        "**/sandbox-harness.ts",
        "**/sandbox-integration.test.ts",
        "**/build-harness.ts",
        // Harness runtime is bundled by Vite into CJS for the isolate.
        "**/_harness-runtime.ts",
        // CLI entry point and interactive prompts can't be unit tested.
        "**/cli.ts",
        "**/_prompts.ts",
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
          include: ["**/*.test.ts"],
          setupFiles: ["../../_fail_on_warnings.ts"],
        },
      },
      {
        test: {
          name: "aai-ui",
          root: "packages/aai-ui",
          globals: true,
          include: ["**/*.test.{ts,tsx}"],
          setupFiles: ["./_jsdom-setup.ts", "../../_fail_on_warnings.ts"],
        },
      },
      {
        test: {
          name: "aai-cli",
          root: "packages/aai-cli",
          globals: true,
          include: ["**/*.test.ts"],
          exclude: ["pack-build.test.ts", "e2e.test.ts", "node_modules", "dist"],
          setupFiles: ["../../_fail_on_warnings.ts"],
        },
      },
      {
        test: {
          name: "aai-server",
          root: "packages/aai-server",
          globals: true,
          include: ["**/*.test.ts"],
          exclude: ["src/sandbox-integration.test.ts", "node_modules", "dist"],
          setupFiles: ["../../_fail_on_warnings.ts"],
        },
      },
    ],
  },
});
