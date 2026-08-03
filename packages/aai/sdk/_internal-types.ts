// Copyright 2025 the AAI authors. MIT license.
/**
 * Internal shared types and tool-schema conversion helpers.
 *
 * The public half of what used to live here — `AgentConfig` and its schema,
 * `toAgentConfig`, `ToolSchema`, `ExecuteTool` — moved to `agent-config.ts`
 * (a real, non-underscore module, so it renders under a proper name in the
 * docs). The names are re-exported below so every existing importer keeps
 * working unchanged.
 *
 * @internal
 */

import type { JSONSchema7 } from "json-schema";
import { z } from "zod";
import type { ToolSchema } from "./agent-config.ts";
import type { ToolDef } from "./types.ts";

export {
  type AgentConfig,
  AgentConfigSchema,
  type AgentConfigSource,
  type ExecuteTool,
  type ExecuteToolOptions,
  HOST_ONLY_AGENT_FIELDS,
  type HostOnlyAgentField,
  type ToolSchema,
  ToolSchemaSchema,
  toAgentConfig,
} from "./agent-config.ts";

export const EMPTY_PARAMS = z.object({});

/**
 * Convert a Zod schema to the JSON Schema shape that S2S providers expect.
 * Strips the `$schema` keyword: `z.toJSONSchema` (Zod v4) tags output with
 * the JSON Schema 2020-12 dialect URI, and some Realtime/S2S providers
 * either reject the field outright or ship it through to the underlying
 * model with a malformed function spec — observed empirically as tool
 * calls that arrive with `args: {}` even when required params are listed.
 */
export function toToolJsonSchema(zodSchema: z.ZodTypeAny): JSONSchema7 {
  const { $schema: _omit, ...rest } = z.toJSONSchema(zodSchema) as Record<string, unknown>;
  return rest as JSONSchema7;
}

export function agentToolsToSchemas(tools: Readonly<Record<string, ToolDef>>): ToolSchema[] {
  return Object.entries(tools).map(([name, def]) => ({
    type: "function",
    name,
    description: def.description,
    parameters: toToolJsonSchema(def.parameters ?? EMPTY_PARAMS),
  }));
}
