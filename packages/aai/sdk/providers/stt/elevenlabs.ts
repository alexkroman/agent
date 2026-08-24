// Copyright 2026 the AAI authors. MIT license.
/**
 * ElevenLabs Scribe streaming STT factory — returns a pure descriptor.
 *
 * The descriptor flows through the bundle → server → runtime pipeline
 * without importing the `@elevenlabs/elevenlabs-js` package. The host-side
 * resolver turns it into an openable `SttOpener` during `createRuntime`.
 */

import type { ProviderCredentialOptions, SttProvider } from "../../providers.ts";

/** Kind tag recognised by the host-side resolver. */
export const ELEVENLABS_KIND = "elevenlabs" as const;

/** Agent-env variable holding the ElevenLabs API key. */
export const ELEVENLABS_API_KEY_ENV = "ELEVENLABS_API_KEY";

/** Options for {@link elevenLabsStt}. */
export interface ElevenLabsSttOptions extends ProviderCredentialOptions {
  /**
   * Streaming speech model. Defaults to `"scribe_v2_realtime"`. Any
   * string is forwarded to the SDK unchanged so users can opt in to
   * future models without an SDK release.
   */
  model?: string;
  /**
   * BCP-47 language code hint. Passing one reduces ambiguity for short
   * utterances.
   *
   * **Unset means AUTO-DETECT, not English.** The field is omitted from the
   * request entirely, so ElevenLabs decides — which is the same default
   * `assemblyAIStt` and `sonioxStt` have, and the opposite of `deepgramStt`, whose
   * unset `language` is `"en"`. Pass a code for a line you know is
   * monolingual.
   */
  language?: string;
}

/**
 * Build an ElevenLabs Scribe STT descriptor.
 *
 * The API key is resolved host-side from the agent's env
 * (`ELEVENLABS_API_KEY`); there is no factory-time key parameter, so
 * the descriptor stays free of secrets and safe to serialize.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { elevenLabsStt } from "@alexkroman1/aai/stt";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   stt: elevenLabsStt({ model: "scribe_v2_realtime", language: "en" }),
 * });
 * ```
 *
 * Unset, `language` is omitted from the request and Scribe
 * auto-detects — which is not the same as English.
 */
export function elevenLabsStt(opts: ElevenLabsSttOptions = {}): SttProvider {
  return { kind: ELEVENLABS_KIND, options: { ...opts } };
}

/** Streaming model used when the descriptor names none. */
export const ELEVENLABS_DEFAULT_MODEL = "scribe_v2_realtime";

/**
 * The settings this stage will actually run with — the descriptor's own
 * options with every host-side default filled in. Shared by the opener and
 * the runtime's "Session mode resolved" log.
 */
export function resolveElevenLabsSttSettings(opts: ElevenLabsSttOptions): {
  model: string;
  languageCode?: string;
} {
  return {
    model: opts.model ?? ELEVENLABS_DEFAULT_MODEL,
    // Omitted unless set: absent means auto-detect, which is not "English".
    ...(opts.language ? { languageCode: opts.language } : {}),
  };
}
