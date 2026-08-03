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

import { z } from "zod";
import type { ToolSchema } from "./agent-config.ts";
import { toToolJsonSchema } from "./schema.ts";
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

export { toToolJsonSchema } from "./schema.ts";

export function agentToolsToSchemas(tools: Readonly<Record<string, ToolDef>>): ToolSchema[] {
  return Object.entries(tools).map(([name, def]) => ({
    type: "function",
    name,
    description: def.description,
    parameters: toToolJsonSchema(def.inputSchema ?? EMPTY_PARAMS),
  }));
}
