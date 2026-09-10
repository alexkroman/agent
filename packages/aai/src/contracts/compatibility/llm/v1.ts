// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:llm` epoch 1.
 *
 * Epoch 2 changed exactly one thing an author can observe: the VALUE, and so
 * the literal type, of `ASSEMBLYAI_LLM_DEFAULT_MODEL` — `"qwen3-next-80b-a3b"`
 * became `"gpt-5.6-luna"`. The export list is unchanged and no signature moved,
 * which is why epoch 1 is RETAINED rather than dropped.
 *
 * So the promise this file holds is narrow and worth stating precisely: an
 * epoch-1 author who selected a model, tuned it, pointed a stage at another
 * account, or reached for the gateway constants still compiles. What such an
 * author could NOT have done safely — and what this file therefore must not do
 * — is depend on WHICH id the default happens to be. A binding annotated
 * `"qwen3-next-80b-a3b"` and initialised from the constant would have reddened
 * on epoch 2, and rightly: that is a promise the SDK never made, since the
 * constant's own doc describes the id as the one to reach for "when an agent has
 * no opinion" and couples it to `TOOLS_REQUIRE_NO_REASONING` membership.
 *
 * If a later epoch removes a factory, makes `assemblyAILlm`'s options
 * argument required, narrows `model` back to the generated union alone, or
 * drops `reasoningEffort`/`apiKeyEnv`, this file reddens — the signal to DROP
 * epoch 1 rather than to edit around it.
 */

import {
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
} from "../../../sdk/providers/llm-barrel.ts";

// The bare call — the shape the docs lead with, and the one the epoch-2 change
// actually touched. It stays a call with no arguments.
export const bare: LlmProvider = assemblyAILlm();

// The default is READ, not asserted: an author may name it to be explicit
// about following the SDK's choice. Typed as `string` on purpose — see the
// module doc for why pinning the literal was never a supported promise.
export const followsTheDefault: string = ASSEMBLYAI_LLM_DEFAULT_MODEL;

// Explicit model selection, off the generated union.
const chosen: AssemblyAIGatewayModel = "claude-sonnet-4-6";
export const pinned: LlmProvider = assemblyAILlm({ model: chosen });

// A free-form id, because the union is a snapshot of a service that adds
// models faster than this package releases.
export const unlisted: LlmProvider = assemblyAILlm({ model: "some-future-model" });

// Reasoning effort, including the off switch a voice line wants.
const effort: AssemblyAIReasoningEffort = "none";
export const tuned: LlmProvider = assemblyAILlm({ model: "gpt-5.5", reasoningEffort: effort });

// Region selection, and the two endpoint constants an author may compare against.
export const european: LlmProvider = assemblyAILlm({ region: "eu" });
export const endpoints: readonly string[] = [
  ASSEMBLYAI_LLM_GATEWAY_URL,
  ASSEMBLYAI_LLM_GATEWAY_EU_URL,
];

// Repointing one stage at another account, without moving the others.
export const otherAccount: LlmProvider = assemblyAILlm({
  apiKeyEnv: "ASSEMBLYAI_API_KEY_SECONDARY",
});

// The other vendors on this subpath: each takes a model and returns the same
// descriptor type, which is the property an author depends on when swapping one.
export const vendors: readonly LlmProvider[] = [
  anthropicLlm({ model: "claude-sonnet-4-6" }),
  openAILlm({ model: "gpt-5.5" }),
  openRouterLlm({ model: "z-ai/glm-5.2" }),
  gatewayLlm({ model: "some-gateway-model" }),
];

// ── Every options interface epoch 1 promised, named and USED ────────────────
//
// Naming a type in an import freezes nothing; the gate that asked for these
// (`api-contracts-gate.test.ts`) is right that a fixture mentioning one
// signature freezes one signature. So each is written as an author would write
// it — a typed literal handed to its own factory — which is what pins the field
// names, their optionality, and the `model` requirement inherited from
// `ModelOptions`.

// The base every vendor's options extend. An author writing a helper that
// forwards options relies on exactly this shape.
const baseModel: ModelOptions = { model: "gpt-5.5" };
export function forwardsAnyVendor(options: ModelOptions): string {
  return options.model;
}
export const forwarded: string = forwardsAnyVendor(baseModel);

const assemblyOpts: AssemblyAILlmOptions = {
  model: "gpt-5.5",
  reasoningEffort: "none",
  region: "us",
};
const anthropicOpts: AnthropicLlmOptions = { model: "claude-sonnet-4-6" };
const openAIOpts: OpenAILlmOptions = { model: "gpt-5.5" };
const openRouterOpts: OpenRouterLlmOptions = { model: "z-ai/glm-5.2" };
const googleOpts: GoogleLlmOptions = { model: "gemini-2.5-flash" };
const groqOpts: GroqLlmOptions = { model: "llama-3.3-70b-versatile" };
const mistralOpts: MistralLlmOptions = { model: "mistral-large-latest" };
const xaiOpts: XAILlmOptions = { model: "grok-4" };
const gatewayOpts: GatewayLlmOptions = { model: "some-gateway-model" };

export const everyVendor: readonly LlmProvider[] = [
  assemblyAILlm(assemblyOpts),
  anthropicLlm(anthropicOpts),
  openAILlm(openAIOpts),
  openRouterLlm(openRouterOpts),
  googleLlm(googleOpts),
  groqLlm(groqOpts),
  mistralLlm(mistralOpts),
  xAILlm(xaiOpts),
  gatewayLlm(gatewayOpts),
];

// The OpenRouter base URL an author compares a custom endpoint against.
export const openRouterBase: string = OPENROUTER_BASE_URL;
