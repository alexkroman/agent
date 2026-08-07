// Copyright 2026 the AAI authors. MIT license.
/**
 * ElevenLabs Scribe streaming STT factory — returns a pure descriptor.
 *
 * The descriptor flows through the bundle → server → runtime pipeline
 * without importing the `@elevenlabs/elevenlabs-js` package. The
 * host-side resolver in `host/providers/resolve.ts` turns it into an
 * openable `SttOpener` during `createRuntime`.
 */

import type { SttProvider } from "../../providers.ts";

/** Kind tag recognised by the host-side resolver. */
export const ELEVENLABS_KIND = "elevenlabs" as const;

/** Agent-env variable holding the ElevenLabs API key. */
export const ELEVENLABS_API_KEY_ENV = "ELEVENLABS_API_KEY";

/** Options for {@link elevenlabs}. */
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

/** Descriptor returned by {@link elevenlabs}. */
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

/** Streaming model used when the descriptor names none. */
export const ELEVENLABS_DEFAULT_MODEL = "scribe_v2_realtime";

/**
 * The settings this stage will actually run with — the descriptor's own
 * options with every host-side default filled in. Shared by the opener and
 * the runtime's "Session mode resolved" log.
 */
export function resolveElevenLabsSettings(opts: ElevenLabsOptions): {
  model: string;
  languageCode?: string;
} {
  return {
    model: opts.model ?? ELEVENLABS_DEFAULT_MODEL,
    // Omitted unless set: absent means auto-detect, which is not "English".
    ...(opts.languageCode ? { languageCode: opts.languageCode } : {}),
  };
}
