// Copyright 2026 the AAI authors. MIT license.
/**
 * xAI (Grok) LLM factory — returns a pure descriptor.
 *
 * Users call this in place of importing from `@ai-sdk/xai` directly,
 * so agent bundles don't drag the xAI SDK into the guest sandbox.
 *
 * The host-side resolver in `host/providers/resolve.ts` builds a real
 * Vercel AI SDK `LanguageModel` from this descriptor during
 * `createRuntime`, using `XAI_API_KEY` from the agent's env.
 */

import type { LlmProvider } from "../../providers.ts";

export const XAI_KIND = "xai" as const;

export interface XaiOptions {
  /** xAI Grok model id, e.g. `"grok-2-1212"`. */
  model: string;
}

export type XaiProvider = LlmProvider & {
  readonly kind: typeof XAI_KIND;
  readonly options: XaiOptions;
};

export function xai(opts: XaiOptions): XaiProvider {
  return { kind: XAI_KIND, options: { ...opts } };
}
