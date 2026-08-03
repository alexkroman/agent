// Copyright 2025 the AAI authors. MIT license.
/** OpenAI Realtime S2S descriptor — host transport resolves at session start. */

import type { S2sProvider } from "../../providers.ts";

/** Kind tag recognised by the host-side resolver. */
export const OPENAI_REALTIME_KIND = "openai-realtime" as const;

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
export type OpenaiRealtimeOptions = {
  /** Realtime model identifier. Default applied by the host (currently `"gpt-realtime-2"`). */
  model?: string;
  /** TTS voice. Default applied by the host (currently `"alloy"`). */
  voice?: OpenaiRealtimeVoice;
  /** Override the WebSocket base URL (testing/proxy). */
  url?: string;
};

/** Descriptor returned by {@link openaiRealtime}. */
export type OpenaiRealtimeProvider = S2sProvider & {
  readonly kind: typeof OPENAI_REALTIME_KIND;
  readonly options: OpenaiRealtimeOptions;
};

/**
 * Build an OpenAI Realtime S2S descriptor — the explicit opt-in to
 * speech-to-speech mode on OpenAI's Realtime API. The API key is resolved
 * host-side from the agent's env (`OPENAI_API_KEY`).
 */
export function openaiRealtime(opts: OpenaiRealtimeOptions = {}): OpenaiRealtimeProvider {
  return { kind: OPENAI_REALTIME_KIND, options: { ...opts } };
}
