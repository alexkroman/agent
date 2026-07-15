// Copyright 2026 the AAI authors. MIT license.
/**
 * Mistral LLM factory — returns a pure descriptor.
 *
 * Users call this in place of importing from `@ai-sdk/mistral` directly,
 * so agent bundles don't drag the Mistral SDK into the guest sandbox.
 *
 * The host-side resolver in `host/providers/resolve.ts` builds a real
 * Vercel AI SDK `LanguageModel` from this descriptor during
 * `createRuntime`, using `MISTRAL_API_KEY` from the agent's env.
 */

import type { LlmProvider } from "../../providers.ts";

export const MISTRAL_KIND = "mistral" as const;

/** Agent-env variable holding the Mistral API key. */
export const MISTRAL_API_KEY_ENV = "MISTRAL_API_KEY";

export interface MistralOptions {
  /** Mistral model id, e.g. `"mistral-large-latest"`. */
  model: string;
}

export type MistralProvider = LlmProvider & {
  readonly kind: typeof MISTRAL_KIND;
  readonly options: MistralOptions;
};

export function mistral(opts: MistralOptions): MistralProvider {
  return { kind: MISTRAL_KIND, options: { ...opts } };
}
