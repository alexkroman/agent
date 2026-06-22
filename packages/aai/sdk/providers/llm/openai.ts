// Copyright 2026 the AAI authors. MIT license.
/**
 * OpenAI LLM factory — returns a pure descriptor.
 *
 * Users call this in place of importing from `@ai-sdk/openai` directly,
 * so agent bundles don't drag the OpenAI SDK into the guest sandbox.
 *
 * The host-side resolver in `host/providers/resolve.ts` builds a real
 * Vercel AI SDK `LanguageModel` from this descriptor during
 * `createRuntime`, using `OPENAI_API_KEY` from the agent's env.
 */

import type { ProviderDescriptor } from "../../providers.ts";

export const OPENAI_KIND = "openai" as const;

export interface OpenAIOptions {
  /** OpenAI model id, e.g. `"gpt-4o"`, `"gpt-4o-mini"`. */
  model: string;
}

export type OpenAIProvider = ProviderDescriptor<typeof OPENAI_KIND, OpenAIOptions>;

export function openai(opts: OpenAIOptions): OpenAIProvider {
  return { kind: OPENAI_KIND, options: opts };
}
