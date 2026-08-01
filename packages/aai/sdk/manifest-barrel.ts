// Copyright 2025 the AAI authors. MIT license.
/**
 * Manifest barrel — agent config conversion and tool schema handling.
 *
 * Used by aai-cli (bundler) and aai-server (rpc-schemas).
 */

export {
  type AgentConfig,
  AgentConfigSchema,
  agentToolsToSchemas,
  type ToolSchema,
  ToolSchemaSchema,
  toAgentConfig,
} from "./_internal-types.ts";
export {
  assertPipelineTuning,
  assertProviderTriple,
  assertSilencePolicy,
} from "./config-rules.ts";
export { ProviderDescriptorSchema } from "./manifest.ts";
