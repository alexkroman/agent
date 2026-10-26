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
// The same seam for `workflows/`: a file default-exporting a `workflow()` def
// is registered under its file name, an explicit `agent({ workflows })` entry
// winning a clash.
export {
  type WithWorkflowsOptions,
  type WorkflowModules,
  type WorkflowRegistry,
  withWorkflows,
  workflowRegistry,
} from "./manifest-workflows.ts";
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
export {
  type ToolSchema,
  ToolSchemaSchema,
  type ZodMessageLines,
  type ZodMessageRole,
  type ZodWhenClause,
} from "./tool-schema.ts";
// `toolUiMap` beside the schemas it mirrors: the pre-connection client config's
// `tools` field is built from the agent's toolsets by every server that holds
// the definition. Also on `/internal`, zod-free, for the guest harness.
export { type ToolUiSource, toolUiMap } from "./tool-ui.ts";
// The ONE shape every tool source hands the runtime — see `sdk/toolset.ts`.
export {
  agentToolsets,
  composeToolsets,
  gateToolset,
  type ResolvedAgentDef,
  type ResolvedTool,
  type ToolBearingDef,
  type ToolExecutor,
  type ToolGate,
  type ToolSource,
  type Toolset,
  type ToolsetEntry,
  type ToolTable,
  toolEntry,
  toolset,
} from "./toolset.ts";
