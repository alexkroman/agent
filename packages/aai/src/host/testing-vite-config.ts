// Copyright 2026 the AAI authors. MIT license.
/**
 * `defineAgentTestConfig()` — an agent project's whole `vitest.config.ts` in
 * one call.
 *
 * Every scaffolded project carried the same config: the `virtual:aai/agent`
 * plugin, `globals: true`, and a pinned reporter, plus a page of comment
 * arguing for each. Copied into a project the three settings froze at the
 * version that scaffolded it; returned from the SDK they move with it, and the
 * argument lives here once:
 *
 * - **`aaiAgentPlugin()`** serves `virtual:aai/agent`, the agent as `aai build`
 *   lowers it (see `testing-vite.ts`).
 * - **`globals: true`** so `describe`/`test`/`expect` work with or without an
 *   explicit import — `@alexkroman1/aai/tsconfig`'s `types: ["vitest/globals"]`
 *   already promises the un-imported spelling; this makes the runtime match.
 * - **`reporters: ["default"]`, PINNED.** Unset, Vitest 4 picks `std-env`'s
 *   `isAgent ? "agent" : "default"`, and the agent reporter prints a passing
 *   file's console output nowhere — so `aai test` run by a coding agent
 *   swallowed every `console.log` in a passing spec. Measured on vitest
 *   4.1.10 with and without the agent markers in the environment.
 *
 * A separate file from `vite.config.ts` on purpose: Vitest prefers
 * `vitest.config.ts`, and a spec run that loads the client build's React and
 * Tailwind plugins has one more way to fail before collecting a test.
 *
 * ## `AAI_DEV_SOURCE=1` resolves a linked SDK to its source here too
 *
 * The same switch `aai dev` honours (see `packages/aai-cli/CLAUDE.md`): with
 * it set, the `@dev/source` export condition is added to both resolvers, so a
 * spec in a project whose SDK is `link:`ed to a checkout runs the checkout's
 * `src/` rather than a `dist/` that may be stale or absent. Unset, the
 * conditions are Vite's defaults — nothing about an installed project changes.
 *
 * Structural types throughout, for `testing-vite.ts`'s reason: `vite` and
 * `vitest` are not dependencies of this package and must not become one.
 */

import { aaiAgentPlugin } from "./testing-vite.ts";

/**
 * What {@link defineAgentTestConfig} returns — a Vitest `UserConfig`, declared
 * structurally.
 *
 * @public
 */
export type AgentTestConfig = {
  plugins: unknown[];
  test: { globals: boolean; reporters: string[]; [option: string]: unknown };
  [option: string]: unknown;
};

/**
 * Overrides for {@link defineAgentTestConfig}. `plugins` are APPENDED after the
 * agent plugin; `test` is merged key by key over the preset's; any other key
 * replaces the preset's value.
 *
 * @public
 */
export type AgentTestConfigOverrides = {
  plugins?: readonly unknown[];
  test?: Record<string, unknown>;
  [option: string]: unknown;
};

/** The export condition every workspace package names first. */
const DEV_SOURCE_CONDITION = "@dev/source";

/**
 * Vite's default resolve conditions, restated: `resolve.conditions` REPLACES
 * the defaults rather than extending them, and `vite` cannot be imported here
 * for `defaultServerConditions`/`defaultClientConditions`.
 */
const SERVER_CONDITIONS = ["module", "node", "development|production"];
const CLIENT_CONDITIONS = ["module", "browser", "development|production"];

/** `AAI_DEV_SOURCE` read the way the CLI reads its other dev switches. */
function devSourceEnabled(env: Record<string, string | undefined>): boolean {
  return /^(1|true|yes|on)$/i.test(env.AAI_DEV_SOURCE?.trim() ?? "");
}

/**
 * The Vitest config an agent project needs, with room to add to it.
 *
 * ```ts
 * // vitest.config.ts
 * import { defineAgentTestConfig } from "@alexkroman1/aai/testing/vite";
 *
 * export default defineAgentTestConfig();
 * ```
 *
 * @param overrides - merged over the preset; see {@link AgentTestConfigOverrides}.
 * @public
 */
export function defineAgentTestConfig(overrides: AgentTestConfigOverrides = {}): AgentTestConfig {
  const { plugins = [], test = {}, ...rest } = overrides;
  const devSource = devSourceEnabled(process.env)
    ? {
        resolve: { conditions: [...CLIENT_CONDITIONS, DEV_SOURCE_CONDITION] },
        ssr: { resolve: { conditions: [...SERVER_CONDITIONS, DEV_SOURCE_CONDITION] } },
      }
    : {};
  return {
    ...devSource,
    ...rest,
    plugins: [aaiAgentPlugin(), ...plugins],
    test: { globals: true, reporters: ["default"], ...test },
  };
}
