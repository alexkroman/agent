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
 * The three AssemblyAI stage factories have distinct names
 * (`assemblyAIStt`, `assemblyAILlm`, `assemblyAITts`), so they can be
 * imported side by side:
 *
 * ```ts
 * import { assemblyAIStt } from "@alexkroman1/aai/stt";
 * import { assemblyAILlm } from "@alexkroman1/aai/llm";
 * import { assemblyAITts } from "@alexkroman1/aai/tts";
 * ```
 */

import type { LlmProvider } from "../../providers.ts";
import type { AssemblyAIGatewayModel } from "./gateway-models.ts";

/** Kind tag recognised by the host-side resolver. */
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
export const ASSEMBLYAI_LLM_DEFAULT_MODEL = "gpt-5.5";

/**
 * Reasoning effort accepted by the gateway's GPT-5-family models, including
 * the two off switches: `"none"` (gpt-5.1 and later) and `"minimal"` (the
 * original `gpt-5`/`-mini`/`-nano`, whose lowest setting that is).
 */
export type AssemblyAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

export {
  ASSEMBLYAI_GATEWAY_MODELS,
  type AssemblyAIGatewayModel,
  gatewayModelIds,
} from "./gateway-models.ts";

/** Options for {@link assemblyAILlm}. */
export interface AssemblyAILlmOptions {
  /**
   * Gateway model id — see {@link ASSEMBLYAI_GATEWAY_MODELS} for the catalog,
   * which is generated from the gateway's own `/v1/models` and records which
   * models can stream, call tools, and serve the EU region.
   *
   * Typed against that catalog so a name the gateway does not carry is caught
   * where it is written, rather than as a 400 at the first session. A plain
   * string is still accepted, because the catalog is a snapshot of a service
   * that adds models faster than this package releases.
   *
   * Note two listed models (`gpt-oss-20b`, `gpt-oss-120b`) cannot stream, so
   * they cannot drive a voice pipeline at all.
   *
   * Defaults to {@link ASSEMBLYAI_LLM_DEFAULT_MODEL}.
   */
  model?: AssemblyAIGatewayModel | (string & Record<never, never>);
  /**
   * Gateway region. `"eu"` routes through the EU endpoint for data
   * residency — six models at time of writing, per the `eu` flag in
   * {@link ASSEMBLYAI_GATEWAY_MODELS}. Defaults to `"us"`.
   */
  region?: "us" | "eu";
  /**
   * Reasoning effort forwarded to the model as `reasoning_effort`.
   *
   * Unset, no `reasoning_effort` parameter is sent at all — the model runs
   * on its own server-side default. Set `"none"` (gpt-5.1 and later) or
   * `"minimal"` (the original `gpt-5`/`-mini`/`-nano`) to turn reasoning
   * off, e.g. when a voice turn's time-to-first-token matters more than
   * thinking depth. Only GPT-5-family models accept the parameter.
   */
  reasoningEffort?: AssemblyAIReasoningEffort;
}

/** Descriptor returned by {@link assemblyAILlm}. */
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
 *
 * Named `assemblyAILlm` (not `assemblyAI`) so the STT
 * (`assemblyAIStt`), LLM, and TTS (`assemblyAITts`) factories can be
 * imported side by side without aliasing.
 */
export function assemblyAILlm(opts: AssemblyAILlmOptions = {}): AssemblyAILlmProvider {
  return {
    kind: ASSEMBLYAI_LLM_KIND,
    options: { ...opts, model: opts.model ?? ASSEMBLYAI_LLM_DEFAULT_MODEL },
  };
}
