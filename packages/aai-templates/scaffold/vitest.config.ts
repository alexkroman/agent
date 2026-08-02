import { defineConfig } from "vitest/config";

/**
 * Test config, deliberately separate from vite.config.ts.
 *
 * Vitest prefers this file, which is the point. `vite.config.ts` imports the
 * React and Tailwind plugins for the CLIENT build — neither has anything to
 * do with running an agent's tests, but loading them is a way for the test
 * run to fail. Measured in the studio: an agent's own test suite failed to
 * load because `defineConfig` came back undefined from an unresolved plugin
 * import, reported as `TypeError: default is not a function` with zero tests
 * collected. The agent then spent a build round "fixing" a test that was
 * fine.
 *
 * `globals: true` so `describe`/`test`/`expect` work with or without an
 * explicit `import { test } from "vitest"`. Both spellings are common, both
 * are correct, and tsconfig's `types: ["vitest/globals"]` already promises
 * the un-imported one — this makes the runtime match the types.
 */
export default defineConfig({
  test: {
    globals: true,
  },
});
