// Copyright 2026 the AAI authors. MIT license.
/**
 * Groq LLM factory — returns a pure descriptor.
 *
 * Users call this in place of importing from `@ai-sdk/groq` directly,
 * so agent bundles don't drag the Groq SDK into the guest sandbox.
 *
 * The host-side resolver in `host/providers/resolve.ts` builds a real
 * Vercel AI SDK `LanguageModel` from this descriptor during
 * `createRuntime`, using `GROQ_API_KEY` from the agent's env.
 */

import type { LlmProvider } from "../../providers.ts";

export const GROQ_KIND = "groq" as const;

/** Agent-env variable holding the Groq API key. */
export const GROQ_API_KEY_ENV = "GROQ_API_KEY";

/** Options for {@link groq}. */
export interface GroqOptions {
  /** Groq model id, e.g. `"llama-3.3-70b-versatile"`. */
  model: string;
}

/** Descriptor returned by {@link groq}. */
export type GroqProvider = LlmProvider & {
  readonly kind: typeof GROQ_KIND;
  readonly options: GroqOptions;
};

/**
 * Build a Groq LLM descriptor for pipeline mode. The API key is resolved
 * host-side from the agent's env (`GROQ_API_KEY`).
 */
export function groq(opts: GroqOptions): GroqProvider {
  return { kind: GROQ_KIND, options: { ...opts } };
}
