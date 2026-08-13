// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `llm`.
 *
 * Pipeline-mode LLM provider descriptors.
 *
 * Re-exported from `@alexkroman1/aai/llm`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  ANTHROPIC_API_KEY_ENV,
  ANTHROPIC_KIND,
  type AnthropicOptions,
  type AnthropicProvider,
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
  anthropic,
  assemblyAILlm,
  GATEWAY_API_KEY_ENV,
  GATEWAY_KIND,
  type GatewayModelInfo,
  type GatewayOptions,
  type GatewayProvider,
  GOOGLE_API_KEY_ENV,
  GOOGLE_KIND,
  type GoogleOptions,
  type GoogleProvider,
  GROQ_API_KEY_ENV,
  GROQ_KIND,
  type GroqOptions,
  type GroqProvider,
  gateway,
  gatewayModelIds,
  google,
  groq,
  type LlmProvider,
  MISTRAL_API_KEY_ENV,
  MISTRAL_KIND,
  type MistralOptions,
  type MistralProvider,
  mistral,
  OPENAI_API_KEY_ENV,
  OPENAI_KIND,
  OPENROUTER_API_KEY_ENV,
  OPENROUTER_BASE_URL,
  OPENROUTER_KIND,
  type OpenAIOptions,
  type OpenAIProvider,
  type OpenRouterOptions,
  type OpenRouterProvider,
  openai,
  openrouter,
  type ProviderDescriptor,
  XAI_API_KEY_ENV,
  XAI_KIND,
  type XaiOptions,
  type XaiProvider,
  xai,
} from "../../sdk/providers/llm-barrel.ts";
