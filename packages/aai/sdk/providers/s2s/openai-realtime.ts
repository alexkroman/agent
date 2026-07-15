// Copyright 2025 the AAI authors. MIT license.
/** OpenAI Realtime S2S descriptor — host transport resolves at session start. */

import type { S2sProvider } from "../../providers.ts";

export const OPENAI_REALTIME_KIND = "openai-realtime" as const;

type OpenaiRealtimeVoice =
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

export type OpenaiRealtimeOptions = {
  /** Realtime model identifier. Default applied by the host (currently `"gpt-realtime-2"`). */
  model?: string;
  /** TTS voice. Default applied by the host (currently `"alloy"`). */
  voice?: OpenaiRealtimeVoice;
  /** Override the WebSocket base URL (testing/proxy). */
  url?: string;
};

export type OpenaiRealtimeProvider = S2sProvider & {
  readonly kind: typeof OPENAI_REALTIME_KIND;
  readonly options: OpenaiRealtimeOptions;
};

export function openaiRealtime(opts: OpenaiRealtimeOptions = {}): OpenaiRealtimeProvider {
  return { kind: OPENAI_REALTIME_KIND, options: { ...opts } };
}
