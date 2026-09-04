// Copyright 2026 the AAI authors. MIT license.
/**
 * Google (Gemini) LLM factory — returns a pure descriptor.
 *
 * Users call this in place of importing from `@ai-sdk/google` directly,
 * so agent bundles don't drag the Google SDK into the guest sandbox.
 *
 * The host-side resolver builds a real
 * Vercel AI SDK `LanguageModel` from this descriptor during
 * `createRuntime`, using `GOOGLE_GENERATIVE_AI_API_KEY` from the
 * agent's env.
 */

import type { LlmProvider } from "../../providers.ts";
import type { ModelOptions } from "./model-options.ts";

export const GOOGLE_KIND = "google" as const;

/** Agent-env variable holding the Google Generative AI API key. */
export const GOOGLE_API_KEY_ENV = "GOOGLE_GENERATIVE_AI_API_KEY";

/**
 * Options for {@link googleLlm}.
 *
 * Empty over {@link ModelOptions} on purpose: this vendor is reached by naming
 * one model id, and every vendor still gets a NAME for its own options so its
 * first vendor-specific setting is an additive field here rather than a re-split
 * of the shared interface across eight call sites.
 */
export interface GoogleLlmOptions extends ModelOptions {}

/**
 * Build a Google (Gemini) LLM descriptor for pipeline mode. The API key is
 * resolved host-side from the agent's env (`GOOGLE_GENERATIVE_AI_API_KEY`).
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { googleLlm } from "@alexkroman1/aai/llm";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   llm: googleLlm({ model: "gemini-2.5-flash" }),
 * });
 * ```
 */
export function googleLlm(opts: GoogleLlmOptions): LlmProvider {
  return { kind: GOOGLE_KIND, options: { ...opts } };
}
