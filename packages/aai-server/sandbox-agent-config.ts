// Copyright 2026 the AAI authors. MIT license.
/**
 * The deploy-time {@link IsolateConfig} → runtime agent boundary.
 *
 * This seam has its own history of dropping fields silently — `builtinTools`
 * (deployed agents lost the default cognitive builtins), `send`, then the
 * provider triple — and every one of those bugs presented as a *working*
 * agent that quietly ignored part of its own config. The old shape (an
 * allow-list mapper copying ~14 fields, where every omission was valid
 * TypeScript) is inverted here: the config flows through **unchanged** apart
 * from a single explicit deny-list of wire-only fields, so a new config
 * field reaches the runtime by default. The type-level guard in
 * `rpc-schemas.test.ts` enforces that every `IsolateConfig` field is either
 * an `AgentDef` field or named in {@link WIRE_ONLY_CONFIG_FIELDS}.
 *
 * The provider descriptors ride on the returned agent: `createRuntime`
 * resolves `opts.stt ?? agent.stt` (etc.), and keying off the descriptors'
 * own presence — never the optional `mode` field — is what prevents the
 * silent-S2S-fallback failure (a pipeline config that loses its providers
 * runs a healthy S2S session on the agent's own key, nothing logged). The
 * `superRefine` in `IsolateConfigSchema` rejects a `mode` that disagrees
 * with the descriptors, so dropping `mode` here loses nothing.
 */

import type { BuiltinTool } from "@alexkroman1/aai";
import { DEFAULT_MAX_STEPS } from "@alexkroman1/aai";
import type { createRuntime } from "@alexkroman1/aai/runtime";
import type { IsolateConfig } from "./rpc-schemas.ts";

/** The agent-definition shape `createRuntime` takes. */
type RuntimeAgent = Parameters<typeof createRuntime>[0]["agent"];

/**
 * The deny-list: `IsolateConfig` fields that do not belong on the runtime
 * agent. `toolSchemas` is passed to `createRuntime` as its own option;
 * `mode` is derived from the provider descriptors (see module doc).
 */
export const WIRE_ONLY_CONFIG_FIELDS = ["toolSchemas", "mode"] as const;

export type WireOnlyConfigField = (typeof WIRE_ONLY_CONFIG_FIELDS)[number];

/**
 * Drop the keys whose value is `undefined`, so an unset config field stays
 * absent on the runtime agent rather than becoming an explicit `undefined`
 * (which `exactOptionalPropertyTypes` rejects against AgentDef's `x?: string`).
 */
function defined<T extends object>(fields: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

/**
 * The deployed agent as the runtime's agent definition: defaults for the
 * fields `AgentDef` requires, then the whole config minus the deny-list.
 */
export function toRuntimeAgent(config: IsolateConfig): RuntimeAgent {
  const {
    toolSchemas: _toolSchemas,
    mode: _mode,
    name,
    systemPrompt,
    builtinTools,
    ...rest
  } = config;
  return {
    name,
    systemPrompt,
    greeting: "",
    maxSteps: DEFAULT_MAX_STEPS,
    tools: {},
    ...defined(rest),
    // The wire keeps builtinTools as plain strings for old-bundle tolerance
    // (see IsolateConfigSchema); the runtime ignores unknown names.
    ...(builtinTools !== undefined ? { builtinTools: builtinTools as readonly BuiltinTool[] } : {}),
  };
}
