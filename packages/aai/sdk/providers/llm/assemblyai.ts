// Copyright 2026 the AAI authors. MIT license.
/**
 * AssemblyAI LLM Gateway factory — returns a pure descriptor.
 *
 * The [LLM Gateway](https://www.assemblyai.com/docs/llm-gateway) is an
 * OpenAI-compatible chat-completions API that fronts 25+ models (Claude,
 * GPT, Gemini, and more) behind a single endpoint and a single
 * `ASSEMBLYAI_API_KEY` — the same key used for AssemblyAI STT.
 *
 * The host-side resolver in `host/providers/resolve.ts` builds a real
 * Vercel AI SDK `LanguageModel` from this descriptor during
 * `createRuntime`, pointing `@ai-sdk/openai`'s chat-completions client at
 * the gateway base URL.
 *
 * Note: this factory shares its name with the STT factory in
 * `@alexkroman1/aai/stt`. When using both, alias one on import:
 *
 * ```ts
 * import { assemblyAI } from "@alexkroman1/aai/stt";
 * import { assemblyAI as assemblyAILlm } from "@alexkroman1/aai/llm";
 * ```
 */

import type { LlmProvider } from "../../providers.ts";

export const ASSEMBLYAI_LLM_KIND = "assemblyai" as const;

/** Agent-env variable holding the AssemblyAI API key (same key as AssemblyAI STT). */
export const ASSEMBLYAI_LLM_API_KEY_ENV = "ASSEMBLYAI_API_KEY";

/** US (default) LLM Gateway endpoint. */
export const ASSEMBLYAI_LLM_GATEWAY_URL = "https://llm-gateway.assemblyai.com/v1";

/** EU LLM Gateway endpoint — keeps data within the European Union. */
export const ASSEMBLYAI_LLM_GATEWAY_EU_URL = "https://llm-gateway.eu.assemblyai.com/v1";

/**
 * The gateway model to reach for when an agent has no opinion.
 *
 * A default exists because the gateway rejects an unknown model id with a
 * 400 that only appears at the first session — so "invent a plausible model
 * name" is a failure mode with no compile-time or deploy-time guard, and one
 * that a code-generating agent falls into readily.
 */
export const ASSEMBLYAI_LLM_DEFAULT_MODEL = "qwen3-next-80b-a3b";

export interface AssemblyAILlmOptions {
  /**
   * Gateway model id, e.g. `"claude-sonnet-4-6"`, `"gpt-4.1"`,
   * `"gemini-2.5-flash-lite"`. See
   * https://www.assemblyai.com/docs/llm-gateway/quickstart#available-models
   * for the full list. Pipeline mode streams LLM output; check the gateway
   * docs for which models support streamed responses.
   *
   * Defaults to {@link ASSEMBLYAI_LLM_DEFAULT_MODEL}.
   */
  model?: string;
  /**
   * Gateway region. `"eu"` routes through the EU endpoint for data
   * residency (Claude and most Gemini models only). Defaults to `"us"`.
   */
  region?: "us" | "eu";
}

export type AssemblyAILlmProvider = LlmProvider & {
  readonly kind: typeof ASSEMBLYAI_LLM_KIND;
  readonly options: AssemblyAILlmOptions & { model: string };
};

/**
 * Build an AssemblyAI LLM Gateway descriptor.
 *
 * The API key is resolved host-side from the agent's env
 * (`ASSEMBLYAI_API_KEY`); there is no factory-time key parameter, so the
 * descriptor stays free of secrets and safe to serialize.
 */
export function assemblyAI(opts: AssemblyAILlmOptions = {}): AssemblyAILlmProvider {
  return {
    kind: ASSEMBLYAI_LLM_KIND,
    options: { ...opts, model: opts.model ?? ASSEMBLYAI_LLM_DEFAULT_MODEL },
  };
}
