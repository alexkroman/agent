import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "./vitest.shared.ts";

/**
 * Workspace root config.
 *
 * The suites themselves are defined ONCE, in each package's own
 * `vitest.config.ts`, and discovered here by glob. This file used to
 * re-declare all eight of them inline, which made every suite two configs
 * that had to be kept in step by hand — and they had already drifted:
 *
 * - the aai-cli project omitted `_test-setup.ts`, the setup file that points
 *   AAI_CONFIG_DIR at a temp dir. `pnpm vitest run --project aai-cli` therefore
 *   ran the CLI suite against the developer's REAL ~/.config/aai/config.json
 *   (and with their shell's provider keys still in the environment)
 * - aai-server/aai-studio-server lost the 20s testTimeout their configs raise
 *   for argon2 under a contended check run, so the shortcut flaked on timeouts
 * - the aai-server excludes named two files that no longer exist and missed
 *   `orchestrator-integration.test.ts`, which the shortcut then ran
 * - the templates project matched only the per-template `agent.test.ts` glob,
 *   silently skipping `templates.test.ts` and `template-api-coverage.test.ts`
 * - several projects dropped `restoreMocks`
 *
 * None of that is reachable now: `--project <name>` and `pnpm --filter <pkg>
 * test` load the same file. Project names live in the package configs so the
 * documented shortcuts (`--project aai`) keep working — a package.json name
 * like `@alexkroman1/aai` would otherwise become the project name.
 */
export default defineConfig({
  ...sharedConfig,
  test: {
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["packages/*/"],
      exclude: [
        ...sharedCoverageExclude,
        // CLI entry point can't be unit tested.
        "packages/aai-cli/cli.ts",
      ],
      // Ratchet: these floors only move UP. When a coverage run shows actuals
      // comfortably above a floor, raise the floor to ~2-3 points below the
      // actual so regressions fail fast but routine refactors don't flap.
      // Actuals (2026-07): lines ~91%, branches ~80%, functions ~87%, statements ~89%.
      thresholds: {
        lines: 88,
        functions: 84,
        branches: 77,
        statements: 86,
      },
    },
    projects: [
      // Every package's own vitest.config.ts — the single definition of each
      // suite. Adding a package needs no edit here.
      "packages/*",
      {
        ...sharedConfig,
        test: {
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
    ],
  },
});
