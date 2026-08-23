// Copyright 2026 the AAI authors. MIT license.
/**
 * Mistral LLM factory — returns a pure descriptor.
 *
 * Users call this in place of importing from `@ai-sdk/mistral` directly,
 * so agent bundles don't drag the Mistral SDK into the guest sandbox.
 *
 * The host-side resolver builds a real
 * Vercel AI SDK `LanguageModel` from this descriptor during
 * `createRuntime`, using `MISTRAL_API_KEY` from the agent's env.
 */

import type { LlmProvider } from "../../providers.ts";
import type { ModelOptions } from "./model-options.ts";

export const MISTRAL_KIND = "mistral" as const;

/** Agent-env variable holding the Mistral API key. */
export const MISTRAL_API_KEY_ENV = "MISTRAL_API_KEY";

/**
 * Build a Mistral LLM descriptor for pipeline mode. The API key is resolved
 * host-side from the agent's env (`MISTRAL_API_KEY`).
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { mistral } from "@alexkroman1/aai/llm";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   llm: mistral({ model: "mistral-large-latest" }),
 * });
 * ```
 */
export function mistral(opts: ModelOptions): LlmProvider {
  return { kind: MISTRAL_KIND, options: { ...opts } };
}
