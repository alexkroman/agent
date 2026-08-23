// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:llm` epoch 2.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 *
 * Epoch 2 is epoch 1 with forty symbols removed and one added, and the shape
 * of what an author writes is unchanged: pick a factory, name a model.
 *
 * What went: the nine `*_KIND`/`*_API_KEY_ENV` pairs and the nine narrowed
 * `*Provider` aliases (to `@alexkroman1/aai/host-internal`, and to nowhere,
 * respectively), `ProviderDescriptor` (to the ROOT barrel, where the base all
 * four stages narrow now lives once instead of four times), and
 * the generated gateway CATALOG — `ASSEMBLYAI_GATEWAY_MODELS`,
 * `GatewayModelInfo`, `gatewayModelIds` — whose 30 rows were being inlined into
 * the published `.d.ts` so that a routine regeneration moved this contract's
 * hash. The id UNION it produces, {@link AssemblyAIGatewayModel}, stays: that
 * is the half an author names.
 *
 * What arrived: {@link ModelOptions}, one interface where eight byte-identical
 * `{ model: string }` declarations used to publish eight reference pages.
 */

import {
  ASSEMBLYAI_LLM_DEFAULT_MODEL,
  ASSEMBLYAI_LLM_GATEWAY_EU_URL,
  ASSEMBLYAI_LLM_GATEWAY_URL,
  type AssemblyAIGatewayModel,
  type AssemblyAILlmOptions,
  type AssemblyAIReasoningEffort,
  anthropic,
  assemblyAILlm,
  gateway,
  google,
  groq,
  type LlmProvider,
  type ModelOptions,
  mistral,
  OPENROUTER_BASE_URL,
  openai,
  openrouter,
  xai,
} from "../../../sdk/providers/llm-barrel.ts";

/** One options shape across the eight vendors that take only a model id. */
export const claude: ModelOptions = { model: "claude-sonnet-5" };

export const providers: LlmProvider[] = [
  anthropic(claude),
  openai({ model: "gpt-5.5" }),
  google({ model: "gemini-2.5-flash" }),
  mistral({ model: "mistral-large-latest" }),
  xai({ model: "grok-4" }),
  groq({ model: "llama-3.3-70b-versatile" }),
  openrouter({ model: "meta-llama/llama-3.3-70b-instruct" }),
  gateway({ model: "zai/glm-4.6" }),
];

/** The AssemblyAI gateway, including the reasoning knob and region select. */
export const model: AssemblyAIGatewayModel | (string & Record<never, never>) =
  ASSEMBLYAI_LLM_DEFAULT_MODEL;
export const effort: AssemblyAIReasoningEffort = "none";
export const gatewayOptions: AssemblyAILlmOptions = {
  model,
  reasoningEffort: effort,
  region: "us",
  apiKeyEnv: "ASSEMBLYAI_STAGING_KEY",
};
export const assemblyai: LlmProvider = assemblyAILlm(gatewayOptions);
export const explicitGateway: LlmProvider = assemblyAILlm({
  gatewayUrl: ASSEMBLYAI_LLM_GATEWAY_URL,
});
export const euGateway: LlmProvider = assemblyAILlm({
  gatewayUrl: ASSEMBLYAI_LLM_GATEWAY_EU_URL,
});

/** A catalog id is still an id; only the capability table behind it moved. */
export const pinned: AssemblyAIGatewayModel = "claude-sonnet-4-6";

export const kinds: string[] = [assemblyai.kind, ...providers.map((p) => p.kind)];
export const openrouterBase: string = OPENROUTER_BASE_URL;
