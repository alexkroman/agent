// Copyright 2025 the AAI authors. MIT license.
/**
 * Anthropic LLM factory — returns a pure descriptor.
 *
 * Users call this in place of importing from `@ai-sdk/anthropic` directly,
 * so agent bundles don't drag the Anthropic SDK into the guest sandbox
 * (which has no `--allow-env` permission and would crash on the SDK's
 * eager `ANTHROPIC_BASE_URL` read).
 *
 * The host-side resolver in `host/providers/resolve.ts` builds a real
 * Vercel AI SDK `LanguageModel` from this descriptor during
 * `createRuntime`, using `ANTHROPIC_API_KEY` from the agent's env.
 */

import type { LlmProvider } from "../../providers.ts";

export const ANTHROPIC_KIND = "anthropic" as const;

/** Agent-env variable holding the Anthropic API key. */
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

/** Options for {@link anthropic}. */
export interface AnthropicOptions {
  /** Anthropic model id, e.g. `"claude-haiku-4-5"`. */
  model: string;
}

/** Descriptor returned by {@link anthropic}. */
export type AnthropicProvider = LlmProvider & {
  readonly kind: typeof ANTHROPIC_KIND;
  readonly options: AnthropicOptions;
};

/**
 * Build an Anthropic (Claude) LLM descriptor for pipeline mode. The API key
 * is resolved host-side from the agent's env (`ANTHROPIC_API_KEY`).
 */
export function anthropic(opts: AnthropicOptions): AnthropicProvider {
  return { kind: ANTHROPIC_KIND, options: { ...opts } };
}
