// Copyright 2025 the AAI authors. MIT license.
/** OpenAI Realtime S2S descriptor — host transport resolves at session start. */

// The module is `s2s/openai.ts` and its symbols are `openAIS2s` /
// `OpenAIS2sOptions`, so both konsistent case names derive them from the plain
// vendor id: `openai: OpenAI` in `kebabToPascalMap` gives `OpenAIS2sOptions`,
// and — with no identity entry in `kebabToCamelMap` to suppress it — the same
// map derives the camel form `openAI`, giving `openAIS2s`. The STAGE comes
// from the convention's suffix rather than from the id.
//
// It used to be `s2s/openai-realtime.ts` exporting `openaiRealtime` /
// `OpenaiRealtimeOptions`, and that `Openai` spelling was a derivation
// artifact nobody chose: the case maps key on the WHOLE provider id, so
// `openai: OpenAI` did not apply to the id `openai-realtime` and the
// convention checked and passed on a name one subpath away from `OpenAI*`.
// Naming the file after the vendor and the symbols after the stage removes the
// special case instead of recording it. The KIND TAG is still
// `"openai-realtime"`: it is a wire value in every deployed descriptor.

import type { ProviderCredentialOptions, S2sProvider } from "../../providers.ts";

/** Kind tag recognised by the host-side resolver. */
export const OPENAI_S2S_KIND = "openai-realtime" as const;

/**
 * Env var holding this stage's credential — the same string as the OpenAI LLM
 * constant, under a name of its own so `apiKeyEnv` can repoint this stage
 * alone (the host-side resolver reads it).
 */
export const OPENAI_S2S_API_KEY_ENV = "OPENAI_API_KEY";

/** Voice ids the OpenAI Realtime API accepts for TTS. */
export type OpenAIS2sVoice =
  | "alloy"
  | "ash"
  | "ballad"
  | "cedar"
  | "coral"
  | "echo"
  | "marin"
  | "sage"
  | "shimmer"
  | "verse";

/** Options for {@link openAIS2s}. */
export interface OpenAIS2sOptions extends ProviderCredentialOptions {
  /** Realtime model identifier. Default applied by the host (currently `"gpt-realtime-2"`). */
  model?: string;
  /** TTS voice. Default applied by the host (currently `"alloy"`). */
  voice?: OpenAIS2sVoice;
  /** Override the WebSocket base URL (testing/proxy). */
  url?: string;
}

/**
 * Build an OpenAI Realtime S2S descriptor — the explicit opt-in to
 * speech-to-speech mode on OpenAI's Realtime API. The API key is resolved
 * host-side from the agent's env (`OPENAI_API_KEY`).
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { openAIS2s } from "@alexkroman1/aai/s2s";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   s2s: openAIS2s({ model: "gpt-realtime", voice: "marin" }),
 * });
 * ```
 *
 * Setting `s2s` replaces the whole `stt`/`llm`/`tts` pipeline.
 */
export function openAIS2s(options: OpenAIS2sOptions = {}): S2sProvider {
  return { kind: OPENAI_S2S_KIND, options: { ...options } };
}
