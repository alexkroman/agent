// Copyright 2026 the AAI authors. MIT license.
/**
 * Deepgram Nova streaming STT factory — returns a pure descriptor.
 *
 * The descriptor flows through the bundle → server → runtime pipeline
 * without importing the `@deepgram/sdk` package. The host-side resolver in
 * `host/providers/resolve.ts` turns it into an openable {@link SttOpener}
 * during `createRuntime`.
 */

import type { SttProvider } from "../../providers.ts";

/** Kind tag recognised by the host-side resolver. */
export const DEEPGRAM_KIND = "deepgram" as const;

/** Agent-env variable holding the Deepgram API key. */
export const DEEPGRAM_API_KEY_ENV = "DEEPGRAM_API_KEY";

export interface DeepgramOptions {
  /**
   * Streaming speech model. Defaults to `"nova-3"`. Any string is forwarded
   * to the SDK unchanged, which allows opt-in to future models.
   */
  model?: "nova-3" | "nova-2" | string;
  /**
   * BCP-47 language code for transcription. Defaults to `"en"`.
   * Examples: `"en"`, `"es"`, `"fr"`, `"de"`.
   */
  language?: string;
  /**
   * Deepgram endpointing window (ms of trailing silence before a `final` is
   * emitted). Defaults to {@link DEFAULT_DEEPGRAM_ENDPOINTING_MS}. Endpointing
   * is the provider's job — the pipeline transport commits a turn on every
   * final — so this window is what keeps a mid-utterance pause from splitting
   * one request across turns.
   */
  endpointing?: number;
}

/**
 * Default Deepgram `endpointing` (ms). Matches the AssemblyAI opener's
 * `min_turn_silence` default (`DEFAULT_MIN_TURN_SILENCE_MS`): the transport
 * commits a turn on every STT final, so end-of-turn detection is owned
 * entirely by the provider and a short window would commit a turn at every
 * mid-utterance pause.
 */
export const DEFAULT_DEEPGRAM_ENDPOINTING_MS = 1500;

export type DeepgramProvider = SttProvider & {
  readonly kind: typeof DEEPGRAM_KIND;
  readonly options: DeepgramOptions;
};

/**
 * Build a Deepgram STT descriptor.
 *
 * The API key is resolved host-side from the agent's env
 * (`DEEPGRAM_API_KEY`); there is no factory-time key parameter, so the
 * descriptor stays free of secrets and safe to serialize.
 */
export function deepgram(opts: DeepgramOptions = {}): DeepgramProvider {
  return { kind: DEEPGRAM_KIND, options: { ...opts } };
}
