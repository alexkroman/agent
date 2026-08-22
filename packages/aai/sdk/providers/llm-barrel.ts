// Copyright 2025 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/llm` subpath barrel — the model that drives the reply.
 *
 * Nine vendors, one shape: each factory returns a serializable DESCRIPTOR
 * (`{ kind, options }`), and you hand it to `agent({ llm })`. Import from here
 * rather than from `@ai-sdk/anthropic` directly — the vendor SDK is loaded
 * host-side when the session starts, so the agent bundle stays free of its
 * eager env reads and other load-time side effects.
 *
 * @example Swap the LLM of an otherwise default agent
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { anthropic } from "@alexkroman1/aai/llm";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   // `stt` and `tts` keep their AssemblyAI defaults.
 *   llm: anthropic({ model: "claude-sonnet-5" }),
 * });
 * ```
 *
 * `agent({ llm })` also takes a bare gateway model id — `llm: "zai/glm-4.6"` —
 * which is the shorthand for {@link gateway}. Every other stage needs a
 * factory.
 *
 * **Credentials are never passed here.** Each factory's vendor names the env
 * var its key is read from — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
 * `ASSEMBLYAI_API_KEY`, … each also exported as a `*_API_KEY_ENV` constant —
 * and the host reads it out of the agent's own environment when the session
 * starts. That is what keeps a descriptor safe to serialize across the CLI →
 * server → guest boundary.
 *
 * Two vendors here are AGGREGATORS rather than model owners, addressed as
 * `"creator/model"`: {@link openrouter} and {@link gateway}. A third,
 * {@link assemblyAILlm}, fronts AssemblyAI's own gateway — its catalog is
 * {@link ASSEMBLYAI_GATEWAY_MODELS} and its ids are listable with
 * {@link gatewayModelIds}.
 *
 * @module llm
 */

// Named re-exports rather than `export *`: the wildcard form needs a
// `noReExportAll` suppression per line, and the escape-hatch ratchet only moves
// down. Listing them also makes the public surface of this subpath readable in
// one place — add new symbols here when a provider gains one.
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
