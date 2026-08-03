// Copyright 2025 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/llm` subpath barrel.
 *
 * Re-exports LLM provider factories. Users import from here instead of
 * `@ai-sdk/anthropic` directly so the agent bundle stays free of eager
 * env reads and other SDK side-effects.
 *
 * Named re-exports rather than `export *`: the wildcard form needs a
 * `noReExportAll` suppression per line, and the escape-hatch ratchet only
 * moves down. Listing them also makes the public surface of this subpath
 * readable in one place — add new symbols here when a provider gains one.
 *
 * @module llm
 */

export type { LlmProvider, ProviderDescriptor } from "../providers.ts";
export {
  ANTHROPIC_API_KEY_ENV,
  ANTHROPIC_KIND,
  type AnthropicOptions,
  type AnthropicProvider,
  anthropic,
} from "./llm/anthropic.ts";
export {
  ASSEMBLYAI_GATEWAY_MODELS,
  ASSEMBLYAI_LLM_API_KEY_ENV,
  ASSEMBLYAI_LLM_DEFAULT_MODEL,
  ASSEMBLYAI_LLM_GATEWAY_EU_URL,
  ASSEMBLYAI_LLM_GATEWAY_URL,
  ASSEMBLYAI_LLM_KIND,
  type AssemblyAIGatewayModel,
  type AssemblyAILlmOptions,
  type AssemblyAILlmProvider,
  type AssemblyAIReasoningEffort,
  assemblyAILlm,
  gatewayModelIds,
} from "./llm/assemblyai.ts";
export {
  GATEWAY_API_KEY_ENV,
  GATEWAY_KIND,
  type GatewayOptions,
  type GatewayProvider,
  gateway,
} from "./llm/gateway.ts";
export type { GatewayModelInfo } from "./llm/gateway-models.ts";
export {
  GOOGLE_API_KEY_ENV,
  GOOGLE_KIND,
  type GoogleOptions,
  type GoogleProvider,
  google,
} from "./llm/google.ts";
export {
  GROQ_API_KEY_ENV,
  GROQ_KIND,
  type GroqOptions,
  type GroqProvider,
  groq,
} from "./llm/groq.ts";
export {
  MISTRAL_API_KEY_ENV,
  MISTRAL_KIND,
  type MistralOptions,
  type MistralProvider,
  mistral,
} from "./llm/mistral.ts";
export {
  OPENAI_API_KEY_ENV,
  OPENAI_KIND,
  type OpenAIOptions,
  type OpenAIProvider,
  openai,
} from "./llm/openai.ts";
export {
  OPENROUTER_API_KEY_ENV,
  OPENROUTER_BASE_URL,
  OPENROUTER_KIND,
  type OpenRouterOptions,
  type OpenRouterProvider,
  openrouter,
} from "./llm/openrouter.ts";
export {
  XAI_API_KEY_ENV,
  XAI_KIND,
  type XaiOptions,
  type XaiProvider,
  xai,
} from "./llm/xai.ts";
