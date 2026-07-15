// Copyright 2026 the AAI authors. MIT license.
/**
 * ElevenLabs Scribe streaming STT factory — returns a pure descriptor.
 *
 * The descriptor flows through the bundle → server → runtime pipeline
 * without importing the `@elevenlabs/elevenlabs-js` package. The
 * host-side resolver in `host/providers/resolve.ts` turns it into an
 * openable {@link SttOpener} during `createRuntime`.
 */

import type { SttProvider } from "../../providers.ts";

/** Kind tag recognised by the host-side resolver. */
export const ELEVENLABS_KIND = "elevenlabs" as const;

/** Agent-env variable holding the ElevenLabs API key. */
export const ELEVENLABS_API_KEY_ENV = "ELEVENLABS_API_KEY";

export interface ElevenLabsOptions {
  /**
   * Streaming speech model. Defaults to `"scribe_v2_realtime"`. Any
   * string is forwarded to the SDK unchanged so users can opt in to
   * future models without an SDK release.
   */
  model?: string;
  /**
   * BCP-47 language code hint. ElevenLabs auto-detects when omitted;
   * passing a hint reduces ambiguity for short utterances.
   */
  languageCode?: string;
}

export type ElevenLabsProvider = SttProvider & {
  readonly kind: typeof ELEVENLABS_KIND;
  readonly options: ElevenLabsOptions;
};

/**
 * Build an ElevenLabs Scribe STT descriptor.
 *
 * The API key is resolved host-side from the agent's env
 * (`ELEVENLABS_API_KEY`); there is no factory-time key parameter, so
 * the descriptor stays free of secrets and safe to serialize.
 */
export function elevenlabs(opts: ElevenLabsOptions = {}): ElevenLabsProvider {
  return { kind: ELEVENLABS_KIND, options: { ...opts } };
}
