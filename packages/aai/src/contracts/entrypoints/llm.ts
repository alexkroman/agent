// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `llm`.
 *
 * Pipeline-mode LLM provider descriptors.
 *
 * `ProviderDescriptor` is the `agent` capability's — see `stt.ts` for why.
 * `LlmProvider` stays here, published on the root as well but owned by the narrower
 * subpath. The gateway CATALOG (`ASSEMBLYAI_GATEWAY_MODELS`,
 * `GatewayModelInfo`, `gatewayModelIds`) is on
 * `@alexkroman1/aai/host-internal`, which is not contracted: it is generated
 * from the service on whatever afternoon someone regenerates it, and hashing
 * a generated data table made routine ops a classification decision. The id
 * UNION it produces is contracted here, because that is what an author names.
 *
 * Re-exported from `@alexkroman1/aai/llm`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type AnthropicLlmOptions,
  ASSEMBLYAI_LLM_DEFAULT_MODEL,
  ASSEMBLYAI_LLM_GATEWAY_EU_URL,
  ASSEMBLYAI_LLM_GATEWAY_URL,
  type AssemblyAIGatewayModel,
  type AssemblyAILlmOptions,
  type AssemblyAIReasoningEffort,
  anthropicLlm,
  assemblyAILlm,
  type GatewayLlmOptions,
  type GoogleLlmOptions,
  type GroqLlmOptions,
  gatewayLlm,
  googleLlm,
  groqLlm,
  type LlmProvider,
  type MistralLlmOptions,
  type ModelOptions,
  mistralLlm,
  OPENROUTER_BASE_URL,
  type OpenAILlmOptions,
  type OpenRouterLlmOptions,
  openAILlm,
  openRouterLlm,
  type XAILlmOptions,
  xAILlm,
} from "../../sdk/providers/llm-barrel.ts";
