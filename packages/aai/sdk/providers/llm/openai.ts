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

export const OPENAI_KIND = "openai" as const;

/** Agent-env variable holding the OpenAI API key (shared with the OpenAI Realtime S2S provider). */
export const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";

/** Options for {@link openai}. */
export interface OpenAIOptions {
  /** OpenAI model id, e.g. `"gpt-4o"`, `"gpt-4o-mini"`. */
  model: string;
}

/** Descriptor returned by {@link openai}. */
export type OpenAIProvider = LlmProvider & {
  readonly kind: typeof OPENAI_KIND;
  readonly options: OpenAIOptions;
};

/**
 * Build an OpenAI LLM descriptor for pipeline mode. The API key is resolved
 * host-side from the agent's env (`OPENAI_API_KEY`).
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { openai } from "@alexkroman1/aai/llm";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   llm: openai({ model: "gpt-5.5" }),
 * });
 * ```
 */
export function openai(opts: OpenAIOptions): OpenAIProvider {
  return { kind: OPENAI_KIND, options: { ...opts } };
}
