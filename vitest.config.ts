import { defineConfig } from "vitest/config";
import { sharedConfig } from "./vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["packages/*/"],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/_test-utils.ts",
        "**/templates/**",
        "**/dist/**",
        "**/__snapshots__/**",
        // Sandbox core + harness files run inside secure-exec isolates, not vitest.
        // Covered by integration test (pnpm test:integration).
        "**/sandbox.ts",
        "**/sandbox-harness.ts",
        "**/sandbox-network.ts",
        "**/sandbox-sidecar.ts",
        "**/sandbox-integration.test.ts",
        "**/build-harness.ts",
        // Harness runtime is bundled by Vite into CJS for the isolate.
        "**/_harness-runtime.ts",
        // OTel session wiring — tested via integration tests, not unit tests.
        "**/_session-otel.ts",
        // CLI entry point and interactive prompts can't be unit tested.
        "**/cli.ts",
        "**/_prompts.ts",
        // CLI subcommands that spawn processes / require real Vite builds.
        "**/aai-cli/dev.ts",
        "**/aai-cli/test.ts",
        "**/aai-cli/_bundler.ts",
        "**/aai-cli/_build.ts",
        "**/aai-cli/_discover.ts",
        // UI: re-export barrel, Preact signal wiring, and presentational components
        // that need real browser APIs or are trivially presentational.
        "**/aai-ui/index.ts",
        "**/aai-ui/signals.ts",
        "**/aai-ui/_components/sidebar-layout.tsx",
        "**/aai-ui/_components/tool-icons.tsx",
        "**/aai-ui/_components/tool-call-block.tsx",
        "**/aai-ui/mount.tsx",
        // OTel wiring — no-op when no SDK configured.
        "**/aai/telemetry.ts",
        // run_code uses secure-exec V8 isolates; covered by integration tests.
        "**/_run-code.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
    projects: [
      {
        ...sharedConfig,
        test: {
          name: "aai",
          root: "packages/aai",
          restoreMocks: true,
          include: ["**/*.test.ts"],
          setupFiles: ["./matchers.ts"],
        },
      },
      {
        ...sharedConfig,
        test: {
          name: "aai-ui",
          root: "packages/aai-ui",
          globals: true,
          restoreMocks: true,
          include: ["**/*.test.{ts,tsx}"],
          setupFiles: ["./_jsdom-setup.ts"],
        },
      },
      {
        ...sharedConfig,
        test: {
          name: "aai-cli",
          root: "packages/aai-cli",
          restoreMocks: true,
          include: ["**/*.test.ts"],
          exclude: [
            "pack-build.test.ts",
            "e2e.test.ts",
            "node_modules",
            "dist",
          ],
        },
      },
      {
        ...sharedConfig,
        test: {
          name: "aai-server",
          root: "packages/aai-server",
          restoreMocks: true,
          include: ["**/*.test.ts"],
          exclude: [
            "src/sandbox-integration.test.ts",
            "node_modules",
            "dist",
          ],
        },
      },
    ],
  },
});
