// Copyright 2026 the AAI authors. MIT license.
/**
 * OpenAI LLM factory — returns a pure descriptor.
 *
 * Users call this in place of importing from `@ai-sdk/openai` directly,
 * so agent bundles don't drag the OpenAI SDK into the guest sandbox.
 *
 * The host-side resolver builds a real
 * Vercel AI SDK `LanguageModel` from this descriptor during
 * `createRuntime`, using `OPENAI_API_KEY` from the agent's env.
 */

import type { LlmProvider } from "../../providers.ts";
import type { ModelOptions } from "./model-options.ts";

export const OPENAI_KIND = "openai" as const;

/** Agent-env variable holding the OpenAI API key (shared with the OpenAI Realtime S2S provider). */
export const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";

/**
 * Options for {@link openAILlm}.
 *
 * Empty over {@link ModelOptions} on purpose: this vendor is reached by naming
 * one model id, and every vendor still gets a NAME for its own options so its
 * first vendor-specific setting is an additive field here rather than a re-split
 * of the shared interface across eight call sites.
 */
export interface OpenAILlmOptions extends ModelOptions {}

/**
 * Build an OpenAI LLM descriptor for pipeline mode. The API key is resolved
 * host-side from the agent's env (`OPENAI_API_KEY`).
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { openAILlm } from "@alexkroman1/aai/llm";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   llm: openAILlm({ model: "gpt-5.5" }),
 * });
 * ```
 */
export function openAILlm(opts: OpenAILlmOptions): LlmProvider {
  return { kind: OPENAI_KIND, options: { ...opts } };
}
