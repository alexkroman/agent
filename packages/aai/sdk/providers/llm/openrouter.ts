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
 * The host-side resolver in `host/providers/resolve.ts` builds a real
 * Vercel AI SDK `LanguageModel` from this descriptor during
 * `createRuntime`, pointing `@ai-sdk/openai`'s chat-completions client at
 * the OpenRouter base URL — no extra SDK install needed.
 */

import type { LlmProvider } from "../../providers.ts";

export const OPENROUTER_KIND = "openrouter" as const;

/** Agent-env variable holding the OpenRouter API key. */
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";

/** OpenRouter's OpenAI-compatible API endpoint. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Options for {@link openrouter}. */
export interface OpenRouterOptions {
  /**
   * OpenRouter model id in `"creator/model"` form, e.g.
   * `"anthropic/claude-sonnet-4.5"`, `"openai/gpt-4.1"`,
   * `"meta-llama/llama-3.3-70b-instruct"`. See
   * https://openrouter.ai/models for the full list.
   */
  model: string;
}

/** Descriptor returned by {@link openrouter}. */
export type OpenRouterProvider = LlmProvider & {
  readonly kind: typeof OPENROUTER_KIND;
  readonly options: OpenRouterOptions;
};

/**
 * Build an OpenRouter descriptor.
 *
 * The API key is resolved host-side from the agent's env
 * (`OPENROUTER_API_KEY`); there is no factory-time key parameter, so the
 * descriptor stays free of secrets and safe to serialize.
 */
export function openrouter(opts: OpenRouterOptions): OpenRouterProvider {
  return { kind: OPENROUTER_KIND, options: { ...opts } };
}
