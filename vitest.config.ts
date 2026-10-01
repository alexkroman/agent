import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "./vitest.shared.ts";

/**
 * Workspace root config. Each suite is defined ONCE, in its package's
 * `vitest.config.ts` (through `defineUnitProject`), and discovered here by
 * glob, so `--project <name>` and `pnpm --filter <pkg> test` load the same
 * file. Never re-declare a suite here: copies drift.
 */
export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    coverage: {
      provider: "v8",
      include: ["packages/*/"],
      exclude: [
        ...sharedCoverageExclude,
        // CLI entry point can't be unit tested.
        "packages/aai-cli/src/cli.ts",
      ],
      // No thresholds: the floors that gate are each package's own, which is
      // what `turbo run test:coverage` and CI's matrix evaluate.
    },
    projects: [
      "packages/*",
      // One typecheck-only project per package with `.test-d.ts` files, each
      // under its own tsconfig (aai-ui's needs `lib: DOM` and `jsx`). A local
      // shortcut only: `turbo run typecheck` is what gates a `.test-d.ts`.
      {
        ...sharedConfig,
        test: {
          ...sharedConfig.test,
          name: "aai-types",
          root: "packages/aai",
          include: [],
          typecheck: {
            enabled: true,
            only: true,
            include: ["**/*.test-d.ts"],
          },
        },
      },
      {
        ...sharedConfig,
        test: {
          ...sharedConfig.test,
          name: "aai-ui-types",
          root: "packages/aai-ui",
          include: [],
          typecheck: {
            enabled: true,
            only: true,
            include: ["**/*.test-d.ts"],
          },
        },
      },
      {
        ...sharedConfig,
        test: {
          ...sharedConfig.test,
          name: "aai-runtime-types",
          root: "packages/aai-runtime",
          include: [],
          typecheck: {
            enabled: true,
            only: true,
            include: ["**/*.test-d.ts"],
          },
        },
      },
    ],
  },
});
