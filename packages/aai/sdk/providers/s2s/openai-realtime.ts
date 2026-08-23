// Copyright 2025 the AAI authors. MIT license.
/** OpenAI Realtime S2S descriptor — host transport resolves at session start. */

// `OpenaiRealtime*`, not `OpenAIRealtime*`, and it is a konsistent DERIVATION
// ARTIFACT rather than a choice: `kebabToPascalMap` in `konsistent.json` keys on
// the whole provider id, so its `openai: OpenAI` entry applies to `llm/openai.ts`
// and not to this module, whose id is `openai-realtime`. The `s2s-providers`
// convention therefore checks and PASSES on the `Openai` form, while `/llm`
// publishes `OpenAIOptions`/`OpenAIProvider` one subpath away.
//
// Left alone deliberately, and recorded so the next reviewer does not re-derive
// it. Fixing it means editing BOTH case maps in the same commit —
// `"openai-realtime": "OpenAIRealtime"` in `kebabToPascalMap` AND
// `"openai-realtime": "openaiRealtime"` in `kebabToCamelMap`, because the camel
// map is derived from the Pascal one when absent and would otherwise rename the
// FACTORY to `openAIRealtime`, which is the name authors actually type. (That
// derivation is why the identity entries `openai: openai`, `openrouter` and
// `elevenlabs` already exist there.) Two Pascal type aliases nobody types are
// not worth a `major` plus that hazard.

import type { S2sProvider } from "../../providers.ts";

/** Kind tag recognised by the host-side resolver. */
export const OPENAI_REALTIME_KIND = "openai-realtime" as const;

/**
 * Env var holding this stage's credential — the same string as the OpenAI LLM
 * constant, under a name of its own so `apiKeyEnv` can repoint this stage
 * alone (the host-side resolver reads it).
 */
export const OPENAI_REALTIME_API_KEY_ENV = "OPENAI_API_KEY";

/** Voice ids the OpenAI Realtime API accepts for TTS. */
export type OpenaiRealtimeVoice =
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

/** Options for {@link openaiRealtime}. */
export interface OpenaiRealtimeOptions {
  /** Realtime model identifier. Default applied by the host (currently `"gpt-realtime-2"`). */
  model?: string;
  /** TTS voice. Default applied by the host (currently `"alloy"`). */
  voice?: OpenaiRealtimeVoice;
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
 * import { openaiRealtime } from "@alexkroman1/aai/s2s";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   s2s: openaiRealtime({ model: "gpt-realtime", voice: "marin" }),
 * });
 * ```
 *
 * Setting `s2s` replaces the whole `stt`/`llm`/`tts` pipeline.
 */
export function openaiRealtime(opts: OpenaiRealtimeOptions = {}): S2sProvider {
  return { kind: OPENAI_REALTIME_KIND, options: { ...opts } };
}
