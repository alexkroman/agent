// Copyright 2026 the AAI authors. MIT license.
/**
 * Groq LLM factory — returns a pure descriptor.
 *
 * Users call this in place of importing from `@ai-sdk/groq` directly,
 * so agent bundles don't drag the Groq SDK into the guest sandbox.
 *
 * The host-side resolver builds a real
 * Vercel AI SDK `LanguageModel` from this descriptor during
 * `createRuntime`, using `GROQ_API_KEY` from the agent's env.
 */

import type { LlmProvider } from "../../providers.ts";
import type { ModelOptions } from "./model-options.ts";

export const GROQ_KIND = "groq" as const;

/** Agent-env variable holding the Groq API key. */
export const GROQ_API_KEY_ENV = "GROQ_API_KEY";

/**
 * Build a Groq LLM descriptor for pipeline mode. The API key is resolved
 * host-side from the agent's env (`GROQ_API_KEY`).
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { groqLlm } from "@alexkroman1/aai/llm";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   llm: groqLlm({ model: "llama-3.3-70b-versatile" }),
 * });
 * ```
 */
/**
 * Options for {@link groqLlm}.
 *
 * Empty over {@link ModelOptions} on purpose: this vendor is reached by naming
 * one model id, and every vendor still gets a NAME for its own options so its
 * first vendor-specific setting is an additive field here rather than a re-split
 * of the shared interface across eight call sites.
 */
export interface GroqLlmOptions extends ModelOptions {}

export function groqLlm(opts: GroqLlmOptions): LlmProvider {
  return { kind: GROQ_KIND, options: { ...opts } };
}
