// Copyright 2026 the AAI authors. MIT license.
/**
 * Cerebras factory — returns a pure descriptor.
 *
 * [Cerebras Inference](https://inference-docs.cerebras.ai) serves a small,
 * curated set of open-weight models on its own wafer-scale hardware behind an
 * OpenAI-compatible chat-completions endpoint and one `CEREBRAS_API_KEY`.
 * Model ids are BARE names (`"qwen-3.8-27b"`, `"gpt-oss-120b"`), not the
 * `"creator/model"` form {@link openRouterLlm} and {@link gatewayLlm} take —
 * which is the one thing that makes a descriptor for this vendor visibly
 * different from those two at a call site.
 *
 * **What it is FOR here is serving latency, not reach.** The catalogue is a
 * handful of models where those two front hundreds, so the reason to name this
 * vendor is that it runs one of them faster: the same `qwen-3.8-27b` measured
 * ~0.55s to a complete tool call here against ~0.95s on a self-hosted vLLM
 * endpoint. On a voice pipeline that difference is paid on every turn, and the
 * turn-level tail is what decides whether a caller waits.
 *
 * The host-side resolver builds a real Vercel AI SDK `LanguageModel` from this
 * descriptor during `createRuntime`, pointing `@ai-sdk/openai`'s
 * chat-completions client at the Cerebras base URL — no extra SDK install
 * needed, the same way OpenRouter is wired.
 */

import type { LlmProvider } from "../../providers.ts";
import type { ModelOptions } from "./shared/model-options.ts";

export const CEREBRAS_KIND = "cerebras" as const;

/** Agent-env variable holding the Cerebras API key. */
export const CEREBRAS_API_KEY_ENV = "CEREBRAS_API_KEY";

/** Cerebras's OpenAI-compatible API endpoint. */
export const CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1";

/**
 * Options for {@link cerebrasLlm}.
 *
 * Empty over {@link ModelOptions} on purpose: this vendor is reached by naming
 * one model id, and every vendor still gets a NAME for its own options so its
 * first vendor-specific setting is an additive field here rather than a
 * re-split of the shared interface across every call site.
 */
export interface CerebrasLlmOptions extends ModelOptions {}

/**
 * Build a Cerebras descriptor.
 *
 * The API key is resolved host-side from the agent's env
 * (`CEREBRAS_API_KEY`); there is no factory-time key parameter, so the
 * descriptor stays free of secrets and safe to serialize.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { cerebrasLlm } from "@alexkroman1/aai/llm";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   llm: cerebrasLlm({ model: "qwen-3.8-27b" }),
 * });
 * ```
 *
 * See https://inference-docs.cerebras.ai/api-reference/models for the ids this
 * endpoint serves; the list is short and changes, so it is deliberately not
 * mirrored as a union here the way the AssemblyAI gateway's catalogue is.
 */
export function cerebrasLlm(options: CerebrasLlmOptions): LlmProvider {
  return { kind: CEREBRAS_KIND, options: { ...options } };
}
