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
  type ToolSchema,
  ToolSchemaSchema,
  toAgentConfig,
} from "./agent-config.ts";
export { ProviderDescriptorSchema } from "./agent-config.ts";
export {
  assertPipelineTuning,
  assertProviderTriple,
  assertSilencePolicy,
  type PipelineTuning,
  type SessionMode,
} from "./config-rules.ts";
