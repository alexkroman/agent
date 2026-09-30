// Copyright 2026 the AAI authors. MIT license.
/**
 * `AAI_DEV_SOURCE=1` — run a `link:`ed SDK from its `src/`, not its `dist/`.
 *
 * Every workspace export names `"@dev/source": "./src/…"` first (see
 * "`@dev/source` custom export condition" in `AGENTS.md`), but a condition is
 * only honoured by a resolver that is TOLD about it, and outside this repo's
 * own tsconfig and vitest config nothing was. That held inside the repo too:
 * `bin.mjs` runs `cli.ts` from source, and the first thing `cli.ts` imports —
 * `@alexkroman1/aai-runtime`, `@alexkroman1/aai` — resolved under Node's
 * default conditions to `dist/`, and so did every SDK import Vite bundled into
 * the agent. A project linked to a checkout (`"@alexkroman1/aai":
 * "link:../aai/packages/aai"`) therefore ran whatever was last BUILT: an SDK
 * edit was invisible until a `turbo build`, and a checkout never built failed
 * with Rolldown's "failed to resolve import".
 *
 * There are two resolvers, and the switch reaches both:
 *
 * - **Node**, for the CLI's own module graph (the runtime `aai dev` builds
 *   in-process, the bundlers, the default-UI lookup). `bin.mjs` registers a
 *   resolve hook adding the condition before it imports `cli.ts` — and only
 *   when it is running `cli.ts` at all, since an installed CLI's SDK ships no
 *   `src/` for the condition to point at.
 * - **Vite**, for everything it bundles: the agent's worker, the client, and
 *   the `aai dev` client server. {@link devSourceViteConfig} is merged into
 *   each. `defineAgentTestConfig()` (`@alexkroman1/aai/testing/vite`) reads the
 *   same variable for `aai test`.
 *
 * Opt-in rather than inferred from "the CLI is running from source": this
 * repo's own scenario and e2e suites spawn the source CLI in temp directories
 * and assert the BUILT shape, and a switch that flipped under them would make
 * those suites test something no user runs.
 *
 * `aai-ui`'s prebuilt default UI (`dist/default-client/`, served when a project
 * has no `client.tsx`) is an artifact, not a module, and still comes from a
 * build.
 */

import { defaultClientConditions, defaultServerConditions, type InlineConfig } from "vite";

/** The variable, named once. */
export const DEV_SOURCE_ENV = "AAI_DEV_SOURCE";

/** The export condition every workspace package names first. */
export const DEV_SOURCE_CONDITION = "@dev/source";

/**
 * Whether `AAI_DEV_SOURCE` asks for source resolution — `1`/`true`/`yes`/`on`,
 * as `AAI_DEV_WATCH` reads. Empty is unset.
 */
export function devSourceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env[DEV_SOURCE_ENV]?.trim() ?? "");
}

/**
 * The resolve conditions to merge into a Vite config: Vite's own defaults plus
 * `@dev/source` when the switch is on, or nothing at all when it is off.
 *
 * The defaults are restated because `resolve.conditions` REPLACES Vite's list
 * rather than extending it — `["@dev/source"]` alone would drop `node` and
 * `module` for every third-party package in the graph.
 */
export function devSourceViteConfig(
  env: Record<string, string | undefined> = process.env,
): Pick<InlineConfig, "resolve" | "ssr"> {
  if (!devSourceEnabled(env)) return {};
  return {
    resolve: { conditions: [...defaultClientConditions, DEV_SOURCE_CONDITION] },
    ssr: { resolve: { conditions: [...defaultServerConditions, DEV_SOURCE_CONDITION] } },
  };
}
