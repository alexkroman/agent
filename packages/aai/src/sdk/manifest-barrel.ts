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
  type ToolSchema,
  ToolSchemaSchema,
  toAgentConfig,
} from "./agent-config.ts";
// `assertProviderTriple` is deliberately NOT here. Its first overload carries
// `@internal` and the second carries no tag, so API Extractor reported one
// symbol as both `@internal` and `@public` — `API-EXPORTS.json` listed the name
// while `docs/api` denied it existed. Every caller is inside this package
// (`sdk/agent-config.ts`, `host/runtime-providers.ts`), so the barrel entry was
// buying nothing; import it from `./config-rules.ts` directly.
export {
  agentConfigWarnings,
  assertPipelineTuning,
  assertSilencePolicy,
  type PipelineTuning,
  type SessionMode,
} from "./config-rules.ts";
// The same seam for the other thing a file beside `agent.ts` can BE: its
// `system-prompt.md`.
export { withSystemPrompt } from "./system-prompt-file.ts";
// The generated worker entry resolves the agent's `tools/` directory through
// these, so they sit beside `toAgentConfig` for the same reason it does: this
// subpath is what a generated entry may import (dependency-free, bundled in).
export {
  type ToolModules,
  type ToolRegistry,
  toolRegistry,
  withTools,
} from "./tool-registry.ts";
