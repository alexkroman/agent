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
 * import { anthropicLlm } from "@alexkroman1/aai/llm";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   // `stt` and `tts` keep their AssemblyAI defaults.
 *   llm: anthropicLlm({ model: "claude-sonnet-5" }),
 * });
 * ```
 *
 * `agent({ llm })` also takes a bare gateway model id — `llm: "zai/glm-4.6"` —
 * which is the shorthand for {@link gatewayLlm}. Every other stage needs a
 * factory.
 *
 * **Credentials are never passed here.** Each factory's vendor names the env
 * var its key is read from — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
 * `ASSEMBLYAI_API_KEY`, … — and the host reads it out of the agent's own
 * environment when the session starts. That is what keeps a descriptor safe to
 * serialize across the CLI → server → guest boundary. The variable NAMES are
 * not published: an author never types one, and the one case for repointing a
 * stage is `apiKeyEnv` on the AssemblyAI descriptor.
 *
 * Eight of the nine take {@link ModelOptions} — one model id and nothing else,
 * REQUIRED, because a third-party vendor's catalog is not this SDK's to
 * default from. Only {@link assemblyAILlm} has a default
 * ({@link ASSEMBLYAI_LLM_DEFAULT_MODEL}) and so a bare call.
 *
 * Two vendors here are AGGREGATORS rather than model owners, addressed as
 * `"creator/model"`: {@link openRouterLlm} and {@link gatewayLlm}. A third,
 * {@link assemblyAILlm}, fronts AssemblyAI's own gateway — its ids are
 * {@link AssemblyAIGatewayModel}, and the CATALOG behind that union (which
 * model streams, calls tools, serves the EU) is on
 * `@alexkroman1/aai/host-internal`, since its readers are the studio's model
 * selection and this repo's own gate rather than an `agent.ts`.
 *
 * ## The descriptor type is on the ROOT barrel TOO
 *
 * `LlmProvider` — what a factory here returns — is also exported from
 * `@alexkroman1/aai`, beside the other three stage types, so an agent
 * annotating two stages writes one import rather than two. It stays here as
 * well: this is where the factory that produces one lives.
 * `ProviderDescriptor`, the base all four narrow, is on the root ALONE now —
 * one interface with four reference pages was three too many.
 *
 * @module llm
 */

// Named re-exports rather than `export *`: the wildcard form needs a
// `noReExportAll` suppression per line, and the escape-hatch ratchet only moves
// down. Listing them also makes the public surface of this subpath readable in
// one place — add new symbols here when a provider gains one.
export type { LlmProvider, ProviderCredentialOptions } from "../providers.ts";
export { type AnthropicLlmOptions, anthropicLlm } from "./llm/anthropic.ts";
export {
  ASSEMBLYAI_LLM_DEFAULT_MODEL,
  ASSEMBLYAI_LLM_GATEWAY_EU_URL,
  ASSEMBLYAI_LLM_GATEWAY_URL,
  type AssemblyAILlmOptions,
  type AssemblyAIReasoningEffort,
  assemblyAILlm,
} from "./llm/assemblyai.ts";
export { type GatewayLlmOptions, gatewayLlm } from "./llm/gateway.ts";
export type { AssemblyAIGatewayModel } from "./llm/gateway-models.ts";
export { type GoogleLlmOptions, googleLlm } from "./llm/google.ts";
export { type GroqLlmOptions, groqLlm } from "./llm/groq.ts";
export { type MistralLlmOptions, mistralLlm } from "./llm/mistral.ts";
export type { ModelOptions } from "./llm/model-options.ts";
export { type OpenAILlmOptions, openAILlm } from "./llm/openai.ts";
export {
  OPENROUTER_BASE_URL,
  type OpenRouterLlmOptions,
  openRouterLlm,
} from "./llm/openrouter.ts";
export { type XAILlmOptions, xAILlm } from "./llm/xai.ts";
