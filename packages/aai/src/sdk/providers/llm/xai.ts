// Copyright 2026 the AAI authors. MIT license.
/**
 * xAI (Grok) LLM factory — returns a pure descriptor.
 *
 * Users call this in place of importing from `@ai-sdk/xai` directly,
 * so agent bundles don't drag the xAI SDK into the guest sandbox.
 *
 * The host-side resolver builds a real
 * Vercel AI SDK `LanguageModel` from this descriptor during
 * `createRuntime`, using `XAI_API_KEY` from the agent's env.
 */

import type { LlmProvider } from "../../providers.ts";
import type { ModelOptions } from "./model-options.ts";

export const XAI_KIND = "xai" as const;

/** Agent-env variable holding the xAI API key. */
export const XAI_API_KEY_ENV = "XAI_API_KEY";

/**
 * Options for {@link xaiLlm}.
 *
 * Empty over {@link ModelOptions} on purpose: this vendor is reached by naming
 * one model id, and every vendor still gets a NAME for its own options so its
 * first vendor-specific setting is an additive field here rather than a re-split
 * of the shared interface across eight call sites.
 */
export interface XaiLlmOptions extends ModelOptions {}

/**
 * Build an xAI (Grok) LLM descriptor for pipeline mode. The API key is
 * resolved host-side from the agent's env (`XAI_API_KEY`).
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { xaiLlm } from "@alexkroman1/aai/llm";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   llm: xaiLlm({ model: "grok-4" }),
 * });
 * ```
 */
export function xaiLlm(opts: XaiLlmOptions): LlmProvider {
  return { kind: XAI_KIND, options: { ...opts } };
}
