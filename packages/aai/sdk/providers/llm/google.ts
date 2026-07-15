// Copyright 2026 the AAI authors. MIT license.
/**
 * Google (Gemini) LLM factory — returns a pure descriptor.
 *
 * Users call this in place of importing from `@ai-sdk/google` directly,
 * so agent bundles don't drag the Google SDK into the guest sandbox.
 *
 * The host-side resolver in `host/providers/resolve.ts` builds a real
 * Vercel AI SDK `LanguageModel` from this descriptor during
 * `createRuntime`, using `GOOGLE_GENERATIVE_AI_API_KEY` from the
 * agent's env.
 */

import type { LlmProvider } from "../../providers.ts";

export const GOOGLE_KIND = "google" as const;

/** Agent-env variable holding the Google Generative AI API key. */
export const GOOGLE_API_KEY_ENV = "GOOGLE_GENERATIVE_AI_API_KEY";

export interface GoogleOptions {
  /** Google Gemini model id, e.g. `"gemini-2.0-flash"`. */
  model: string;
}

export type GoogleProvider = LlmProvider & {
  readonly kind: typeof GOOGLE_KIND;
  readonly options: GoogleOptions;
};

export function google(opts: GoogleOptions): GoogleProvider {
  return { kind: GOOGLE_KIND, options: { ...opts } };
}
