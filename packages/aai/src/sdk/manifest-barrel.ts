// Copyright 2025 the AAI authors. MIT license.
/**
 * Manifest barrel — agent config conversion and tool schema handling.
 *
 * Used by aai-cli (bundler) and aai-server (rpc-schemas). Generated bundle
 * entries call `toAgentConfig`, which is why this subpath is published.
 *
 * @module manifest
 */

export { agentToolsToSchemas } from "./_internal-types.ts";
export {
  type AgentConfig,
  AgentConfigSchema,
  type AgentConfigSource,
  HOST_ONLY_AGENT_FIELDS,
  type HostOnlyAgentField,
  ProviderDescriptorSchema,
  toAgentConfig,
} from "./agent-config.ts";
// `assertProviderTriple` is deliberately NOT here: it is `@internal`, and its
// callers reach it through `./config-rules.ts` or `/host-internal`, so a
// barrel entry would buy nothing.
export { agentConfigWarnings, type SessionMode } from "./config-rules.ts";
// The same seam for the other thing a file beside `agent.ts` can BE: its
// `system-prompt.md`.
export { withSystemPrompt } from "./system-prompt-file.ts";
// `ToolSchema.messages` names these, and `agentToolsToSchemas` is what fills
// the field in — so the normalizer rides with them rather than sitting one
// subpath away from the only function that calls it.
export {
  normalizeToolMessages,
  type ToolCompletionMessage,
  type ToolDelayedMessage,
  type ToolMessageCondition,
  type ToolMessages,
  type ToolMessagesInput,
  type ToolStartMessage,
} from "./tool-messages.ts";
// The generated worker entry resolves the agent's `tools/` directory through
// these, so they sit beside `toAgentConfig` for the same reason it does: this
// subpath is what a generated entry may import (dependency-free, bundled in).
export {
  type ToolModules,
  type ToolRegistry,
  toolRegistry,
  withTools,
} from "./tool-registry.ts";
export { type ToolSchema, ToolSchemaSchema } from "./tool-schema.ts";
// The ONE shape every tool source hands the runtime — see `sdk/toolset.ts`.
export {
  agentToolsets,
  composeToolsets,
  gateToolset,
  type ResolvedTool,
  type ToolBearingDef,
  type ToolGate,
  type ToolTable,
  toolEntry,
  toolset,
} from "./toolset.ts";
