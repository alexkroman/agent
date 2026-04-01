// Copyright 2025 the AAI authors. MIT license.
/**
 * AAI SDK — internal types for the voice agent runtime.
 *
 * Users define agents via `agent.toml` + `tools.ts` with no SDK imports.
 * These types are used internally by the CLI and server.
 */

export type { Kv, KvEntry, KvListOptions } from "./isolate/kv.ts";
export type {
  AgentDef,
  BuiltinTool,
  HookContext,
  JSONSchemaObject,
  Message,
  ToolChoice,
  ToolContext,
  ToolDef,
  ToolResultMap,
} from "./isolate/types.ts";
export { DEFAULT_GREETING, DEFAULT_SYSTEM_PROMPT } from "./isolate/types.ts";
