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
 * - several projects dropped `restoreMocks` (which is why that option, and the
 *   CI reporters, now live in `vitest.shared.ts` and are spread in via
 *   `...sharedConfig.test` — a package config that declares `test` without
 *   that spread silently replaces the shared options rather than extending
 *   them, which is how every package came to drop `reporters`)
 *
 * None of that is reachable now: `--project <name>` and `pnpm --filter <pkg>
 * test` load the same file. Project names live in the package configs so the
 * documented shortcuts (`--project aai`) keep working — a package.json name
 * like `@alexkroman1/aai` would otherwise become the project name.
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
      // There are deliberately NO thresholds here. The floors that gate a PR are
      // the PER-PACKAGE ones: `pnpm test:coverage` is `turbo run test:coverage`,
      // which fans out to each package's own config, and CI runs `pnpm --filter
      // ./packages/<pkg> test:coverage` per matrix entry. Nothing in the repo or
      // in CI ever evaluates this file, so a `thresholds` block here was a
      // ratchet no process could move and no PR could trip — kept on the argument
      // that it was "the only floor that sees the repo as one program", which is a
      // view nobody's pipeline takes, and sitting ~4 points under an actual
      // nobody had measured.
      //
      // The measurement was the informative half, so it stays. Actuals (2026-08,
      // `pnpm vitest run --coverage`, 4508 tests): lines 92.25, functions 88.75,
      // branches 84.05, statements 90.27.
    },
    projects: [
      // Every package's own vitest.config.ts — the single definition of each
      // suite. Adding a package needs no edit here.
      "packages/*",
      // One typecheck project PER PACKAGE that has `.test-d.ts` files, rather
      // than one rooted at the repo: each has to run under its own package
      // tsconfig, and `aai-ui`'s is the reason — its type tests need `lib:
      // DOM` and `jsx: react-jsx`, neither of which the root config sets.
      //
      // Note these projects are NOT what gates a `.test-d.ts`. Nothing in the
      // repo or in CI evaluates this file (see the coverage-threshold note in
      // the root CLAUDE.md — same cause), so what actually fails a wrong
      // `expectTypeOf` is `turbo run typecheck`: every package tsconfig
      // includes its test files, and a mismatched assertion is a hard TS2344.
      // They stay because `--project <name>` is the fast way to iterate on one
      // package's type tests without checking the whole program.
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
      // `aai-runtime` has had `providers/providers.test-d.ts` since the runtime
      // split and no project here, so the rule stated above ("one typecheck
      // project PER PACKAGE that has `.test-d.ts` files") described two thirds
      // of the packages that have one. Nothing was UNGATED by that — as the note
      // above says, what fails a wrong `expectTypeOf` is `turbo run typecheck`,
      // and this package's tsconfig includes `src` — but the fast path these
      // projects exist to provide was missing for the one package whose type
      // tests cover the provider contracts.
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
