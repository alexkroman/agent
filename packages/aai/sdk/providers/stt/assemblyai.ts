// Copyright 2025 the AAI authors. MIT license.
/**
 * AssemblyAI Universal-Streaming STT factory — returns a pure descriptor.
 *
 * The descriptor flows through the bundle → server → runtime pipeline
 * without importing the `assemblyai` SDK. The host-side resolver in
 * `host/providers/resolve.ts` turns it into an openable `SttOpener`
 * during `createRuntime`.
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

import type { SttProvider } from "../../providers.ts";

/** Kind tag recognised by the host-side resolver. */
export const ASSEMBLYAI_KIND = "assemblyai" as const;

/** Agent-env variable holding the AssemblyAI API key. */
export const ASSEMBLYAI_API_KEY_ENV = "ASSEMBLYAI_API_KEY";

/** EU data-residency streaming endpoint. */
export const ASSEMBLYAI_STREAMING_EU_URL = "wss://streaming.eu.assemblyai.com/v3/ws";

/** Options for {@link assemblyAIStt}. */
export interface AssemblyAIOptions {
  /**
   * Streaming speech model. Defaults to `"universal-3-5-pro"` (Universal-3.5
   * Pro Real-Time). Arbitrary strings are forwarded to the SDK unchanged.
   */
  model?: "universal-3-5-pro" | string;
  /**
   * EU data-residency — routes both streaming and sync transcription to
   * AssemblyAI's EU endpoints (`streaming.eu.assemblyai.com` /
   * `sync.eu.assemblyai.com`). Required for EU-region API keys, which the US
   * endpoints reject. Defaults to `"us"`.
   */
  region?: "us" | "eu";
  /**
   * Streaming WebSocket endpoint override, sent as the SDK's
   * `websocketBaseUrl`. Must include the versioned path (e.g.
   * `wss://streaming.sandbox000.assemblyai-labs.com/v3/ws`) — the SDK only
   * supplies that path for its own default host, so a bare origin connects to
   * the wrong route.
   *
   * Takes precedence over {@link AssemblyAIOptions.region}: an explicit
   * endpoint is a deliberate choice and must not be silently overwritten by
   * the residency shorthand. Intended for pre-release/staging clusters and
   * A/B measurement against the default host; leave unset in production.
   */
  streamingUrl?: string;
  /**
   * Languages to bias the model toward, sent as the `language_codes` connection
   * parameter (e.g. `["en"]`, `["en", "es"]`).
   *
   * Universal-3.5 Pro **code-switches across 18 languages by default**, so an
   * unset value is not "English" — it is "detect per turn". That default costs
   * accuracy on a monolingual line in a way that is easy to misread as an audio
   * problem: measured against tau2-bench, English utterances came back
   * transliterated into Devanagari and Hebrew script
   * (`Hello? Any update?` → `हेलो एनी अपडेट`), including an authentication turn,
   * so the tool call built from it was garbage. Nothing in the transcript says
   * "wrong language" — it reads as a mis-hearing.
   *
   * A single-element list pins one language and keeps code-switching off; omit
   * for a genuinely multilingual line.
   */
  languages?: string[];
  /**
   * Voice focus (voice isolation) mode, sent as the `voice_focus` connection
   * parameter. Defaults to `"near-field"` to suppress background noise for
   * close-mic / phone audio. Set to `""` (or `"off"`) to disable.
   */
  voiceFocus?: "near-field" | "far-field" | "off" | string;
  /**
   * Minimum end-of-turn silence (ms) before the service commits a `final`,
   * sent as the `min_turn_silence` connection parameter. This is where
   * endpointing lives: mid-utterance pauses shorter than this aggregate into
   * one final instead of splitting the request across turns. Defaults to
   * `DEFAULT_MIN_TURN_SILENCE_MS` (3000).
   */
  minTurnSilenceMs?: number;
  /**
   * Deadline for one streaming connect attempt — socket open *and* the
   * server's `Begin` message. Defaults to `STT_CONNECT_TIMEOUT_MS`
   * (2500 ms), overriding the SDK's own 1000 ms, which a healthy handshake
   * can exceed. `0` waits indefinitely.
   */
  connectTimeoutMs?: number;
  /**
   * Extra connect attempts after a transient failure (timeout, network drop,
   * unexpected close); permanent failures such as auth are never retried.
   * Defaults to `STT_CONNECT_MAX_RETRIES` (2). `0` disables retries.
   *
   * Raising either knob widens the worst-case open time
   * (`(1 + retries) * connectTimeoutMs` plus the retry delays), which has to
   * stay under `DEFAULT_SESSION_START_TIMEOUT_MS` — see the connect-budget
   * note in `sdk/constants.ts`.
   */
  maxConnectRetries?: number;
}

/** Descriptor returned by {@link assemblyAIStt}. */
export type AssemblyAIProvider = SttProvider & {
  readonly kind: typeof ASSEMBLYAI_KIND;
  readonly options: AssemblyAIOptions;
};

/**
 * Build an AssemblyAI STT descriptor.
 *
 * The API key is resolved host-side from the agent's env
 * (`ASSEMBLYAI_API_KEY`); there is no factory-time key parameter, so the
 * descriptor stays free of secrets and safe to serialize.
 *
 * Named `assemblyAIStt` (not `assemblyAI`) so the STT, LLM
 * (`assemblyAILlm`), and TTS (`assemblyAITts`) factories can be imported
 * side by side without aliasing.
 */
export function assemblyAIStt(opts: AssemblyAIOptions = {}): AssemblyAIProvider {
  return { kind: ASSEMBLYAI_KIND, options: { ...opts } };
}
