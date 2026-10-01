// Copyright 2026 the AAI authors. MIT license.
/**
 * The env var names an agent needs that its OTHER fields already name — so an
 * author never lists them twice in `requiredEnv`.
 *
 * Provider credentials are derived from the `stt`/`llm`/`tts`/`s2s`
 * descriptors by `aai-runtime`'s `requiredProviderEnvVars`; this is the same
 * rule for the two other fields that name a variable: each MCP server's
 * `tokenEnv`, and the key a keyed {@link BuiltinTool} reads. A deploy preflight
 * (and `aai dev`'s warnings) checks the union of the three with `requiredEnv`.
 *
 * Node-free and structural over the WIRE shape, because the CLI reads it off a
 * bundle's `__aaiConfig`, written by whichever SDK built it.
 */

import { TEXTBELT_KEY_ENV } from "./_owner-text-env.ts";
import type { BuiltinTool } from "./builtin-tools.ts";

/**
 * The agent-env variable each KEYED builtin reads its credential from. A
 * builtin absent here needs no key (`open_meteo`) or none of the agent's own.
 *
 * @internal
 */
export const BUILTIN_TOOL_ENV: Readonly<Partial<Record<BuiltinTool, string>>> = {
  brave_search: "BRAVE_API_KEY",
  google_places: "GOOGLE_PLACES_API_KEY",
  text_me: TEXTBELT_KEY_ENV,
};

/**
 * What {@link derivedRequiredEnv} reads: the wire shape of the two fields.
 *
 * @internal
 */
export type DerivedEnvQuery = {
  readonly builtinTools?: readonly string[] | undefined;
  readonly mcpServers?: Readonly<Record<string, { readonly tokenEnv?: unknown }>> | undefined;
};

/**
 * Every MCP `tokenEnv` and keyed-builtin variable the agent declares, deduped,
 * in declaration order (MCP servers first).
 *
 * @internal
 */
export function derivedRequiredEnv(agent: DerivedEnvQuery): string[] {
  const names = new Set<string>();
  for (const server of Object.values(agent.mcpServers ?? {})) {
    if (typeof server?.tokenEnv === "string" && server.tokenEnv) names.add(server.tokenEnv);
  }
  const keyed: Readonly<Record<string, string | undefined>> = BUILTIN_TOOL_ENV;
  for (const name of agent.builtinTools ?? []) {
    const env = keyed[name];
    if (env) names.add(env);
  }
  return [...names];
}

/**
 * `requiredEnv` plus {@link derivedRequiredEnv} — every non-provider name a
 * deploy should find in the agent env.
 *
 * @internal
 */
export function agentRequiredEnv(
  agent: DerivedEnvQuery & { readonly requiredEnv?: readonly string[] | undefined },
): string[] {
  return [...new Set([...(agent.requiredEnv ?? []), ...derivedRequiredEnv(agent)])];
}
