// Copyright 2025 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/llm` subpath barrel.
 *
 * Re-exports LLM provider factories. Users import from here instead of
 * `@ai-sdk/anthropic` directly so the agent bundle stays free of eager
 * env reads and other SDK side-effects.
 */

export type { LlmProvider } from "../providers.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./llm/anthropic.ts";
export {
  ASSEMBLYAI_GATEWAY_MODELS,
  ASSEMBLYAI_LLM_API_KEY_ENV,
  ASSEMBLYAI_LLM_DEFAULT_MODEL,
  type AssemblyAIGatewayModel,
  type AssemblyAILlmOptions,
  type AssemblyAILlmProvider,
  assemblyAI,
  gatewayModelIds,
} from "./llm/assemblyai.ts";
export {
  GATEWAY_API_KEY_ENV,
  type GatewayOptions,
  type GatewayProvider,
  gateway,
} from "./llm/gateway.ts";
export type { GatewayModelInfo } from "./llm/gateway-models.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./llm/google.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./llm/groq.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./llm/mistral.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./llm/openai.ts";
export {
  OPENROUTER_API_KEY_ENV,
  type OpenRouterOptions,
  type OpenRouterProvider,
  openrouter,
} from "./llm/openrouter.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./llm/xai.ts";
