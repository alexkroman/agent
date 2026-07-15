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
  ASSEMBLYAI_LLM_GATEWAY_EU_URL,
  ASSEMBLYAI_LLM_GATEWAY_URL,
  ASSEMBLYAI_LLM_KIND,
  type AssemblyAILlmOptions,
  type AssemblyAILlmProvider,
  assemblyAI,
} from "./llm/assemblyai.ts";
export {
  GATEWAY_API_KEY_ENV,
  GATEWAY_KIND,
  type GatewayOptions,
  type GatewayProvider,
  gateway,
} from "./llm/gateway.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./llm/google.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./llm/groq.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./llm/mistral.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./llm/openai.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./llm/xai.ts";
