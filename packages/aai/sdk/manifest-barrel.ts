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
  EMPTY_PARAMS,
  type ExecuteTool,
  type ToolSchema,
  ToolSchemaSchema,
  toAgentConfig,
} from "./_internal-types.ts";
export { ProviderDescriptorSchema } from "./manifest.ts";
export { isTextOnlyTts, NONE_TTS_KIND } from "./providers/tts/none.ts";
export {
  assertPipelineTuning,
  assertProviderTriple,
  assertSilencePolicy,
  assertTextOnlyTuning,
  type SessionMode,
} from "./providers.ts";
