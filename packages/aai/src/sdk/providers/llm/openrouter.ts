// Copyright 2026 the AAI authors. MIT license.
/**
 * OpenRouter factory — returns a pure descriptor.
 *
 * [OpenRouter](https://openrouter.ai) is an OpenAI-compatible
 * chat-completions endpoint fronting hundreds of models from many
 * creators, addressed as `"creator/model"` (e.g.
 * `"anthropic/claude-sonnet-4.5"`, `"openai/gpt-4.1"`,
 * `"meta-llama/llama-3.3-70b-instruct"`), behind one
 * `OPENROUTER_API_KEY`.
 *
 * The host-side resolver builds a real
 * Vercel AI SDK `LanguageModel` from this descriptor during
 * `createRuntime`, pointing `@ai-sdk/openai`'s chat-completions client at
 * the OpenRouter base URL — no extra SDK install needed.
 */

import type { LlmProvider } from "../../providers.ts";
import type { ModelOptions } from "./model-options.ts";

export const OPENROUTER_KIND = "openrouter" as const;

/** Agent-env variable holding the OpenRouter API key. */
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";

/** OpenRouter's OpenAI-compatible API endpoint. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Options for {@link openRouterLlm}.
 *
 * Empty over {@link ModelOptions} on purpose: this vendor is reached by naming
 * one model id, and every vendor still gets a NAME for its own options so its
 * first vendor-specific setting is an additive field here rather than a re-split
 * of the shared interface across eight call sites.
 */
export interface OpenRouterLlmOptions extends ModelOptions {}

/**
 * Build an OpenRouter descriptor.
 *
 * The API key is resolved host-side from the agent's env
 * (`OPENROUTER_API_KEY`); there is no factory-time key parameter, so the
 * descriptor stays free of secrets and safe to serialize.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { openRouterLlm } from "@alexkroman1/aai/llm";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   llm: openRouterLlm({ model: "meta-llama/llama-3.3-70b-instruct" }),
 * });
 * ```
 *
 * One key, hundreds of models, addressed `"creator/model"`. See
 * https://openrouter.ai/models for the list.
 */
export function openRouterLlm(opts: OpenRouterLlmOptions): LlmProvider {
  return { kind: OPENROUTER_KIND, options: { ...opts } };
}
