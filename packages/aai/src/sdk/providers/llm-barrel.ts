// Copyright 2025 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/llm` subpath barrel — the model that drives the reply.
 *
 * One factory, {@link llm}, for every provider: it returns a serializable
 * DESCRIPTOR (`{ kind, options }`) that you hand to `agent({ llm })`. Import
 * from here rather than from `@ai-sdk/*` directly — the vendor SDK is loaded
 * host-side when the session starts, so the agent bundle stays free of its
 * eager env reads and other load-time side effects.
 *
 * @example Swap the LLM of an otherwise default agent
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { llm } from "@alexkroman1/aai/llm";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   // `stt` and `tts` keep their AssemblyAI defaults.
 *   llm: llm({ provider: "anthropic", model: "claude-sonnet-5" }),
 * });
 * ```
 *
 * `agent({ llm })` also takes a bare model id — `llm: "zai/glm-4.6"` is
 * `provider: "gateway"`, and an id with no slash is `provider: "assemblyai"`.
 *
 * **Credentials are never passed here.** The host resolver owns, per
 * provider, the env var its key is read from and reads it out of the agent's
 * own environment when the session starts — which is what keeps a descriptor
 * safe to serialize across the CLI → server → guest boundary. `apiKeyEnv`
 * repoints one descriptor at another variable; neither the names nor the base
 * URLs are published, since an author never types one.
 *
 * `provider` is OPEN ({@link LlmProviderName}): a provider this release does
 * not know resolves as an OpenAI-compatible endpoint when the descriptor
 * carries a `baseUrl`. {@link AssemblyAIGatewayModel} is open the same way —
 * the generated {@link KnownGatewayModel} snapshot is autocomplete, not a
 * guard; the capability CATALOG behind it (which model streams, calls tools,
 * serves the EU) is on `@alexkroman1/aai/host-internal`, since its readers
 * are the studio's model selection and this repo's own gate.
 *
 * ## The descriptor type is on the ROOT barrel TOO
 *
 * `LlmProvider` — what {@link llm} returns — is also exported from
 * `@alexkroman1/aai`, beside the other three stage types, so an agent
 * annotating two stages writes one import rather than two. It stays here as
 * well: this is where the factory that produces one lives.
 *
 * @module llm
 */

// Named re-exports rather than `export *`: the wildcard form needs a
// `noReExportAll` suppression per line, and the escape-hatch ratchet only moves
// down. Listing them also makes the public surface of this subpath readable in
// one place.
export type {
  LlmDescriptorOptions,
  LlmProvider,
  ProviderCredentialOptions,
} from "../providers.ts";
export {
  ASSEMBLYAI_LLM_DEFAULT_MODEL,
  type AssemblyAIReasoningEffort,
} from "./llm/assemblyai.ts";
export {
  type AssemblyAIGatewayModel,
  type AssemblyAILlmProviderOptions,
  type KnownLlmProvider,
  type LlmOptions,
  type LlmProviderName,
  llm,
} from "./llm/llm.ts";
export type { KnownGatewayModel } from "./llm/shared/gateway-models.ts";
