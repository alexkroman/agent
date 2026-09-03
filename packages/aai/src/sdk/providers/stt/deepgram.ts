// Copyright 2026 the AAI authors. MIT license.
/**
 * Deepgram Nova streaming STT factory — returns a pure descriptor.
 *
 * The descriptor flows through the bundle → server → runtime pipeline
 * without importing the `@deepgram/sdk` package. The host-side resolver turns
 * it into an openable `SttOpener` during `createRuntime`.
 */

import type { ProviderCredentialOptions, SttProvider } from "../../providers.ts";

/** Kind tag recognised by the host-side resolver. */
export const DEEPGRAM_KIND = "deepgram" as const;

/** Agent-env variable holding the Deepgram API key. */
export const DEEPGRAM_API_KEY_ENV = "DEEPGRAM_API_KEY";

/** Options for {@link deepgramStt}. */
export interface DeepgramSttOptions extends ProviderCredentialOptions {
  /**
   * Streaming speech model. Defaults to `"nova-3"`. Any string is forwarded
   * to the SDK unchanged, which allows opt-in to future models.
   */
  model?: "nova-3" | "nova-2" | string;
  /**
   * BCP-47 language code for transcription. Examples: `"en"`, `"es"`, `"fr"`,
   * `"de"`.
   *
   * **Unset means ENGLISH, not auto-detect.** Deepgram is the one STT provider
   * here that behaves that way: `DEEPGRAM_DEFAULT_LANGUAGE` (`"en"`) is
   * filled in and sent on every connection, where `assemblyAIStt` detects per
   * turn and `elevenlabs`/`sonioxStt` omit the field entirely so the vendor
   * auto-detects. So an agent moved from any of those three to `deepgramStt()`
   * silently loses non-English transcription — and the symptom is a caller
   * whose speech comes back as plausible English words, which reads as a
   * mis-hearing rather than as a language setting.
   *
   * Name the code you mean. There is no value for "detect": Deepgram's
   * multilingual support is selected by naming a multilingual `model`.
   */
  language?: string;
  /**
   * Deepgram endpointing window (ms of trailing silence before a `final` is
   * emitted). Defaults to {@link DEEPGRAM_DEFAULT_ENDPOINTING_MS}. Endpointing
   * is the provider's job — the pipeline transport commits a turn on every
   * final — so this window is what keeps a mid-utterance pause from splitting
   * one request across turns.
   */
  endpointing?: number;
}

/**
 * Default Deepgram `endpointing` (ms) — **the same knob as
 * `DEFAULT_MIN_TURN_SILENCE_MS`, seen from a different vendor.** The transport
 * commits a turn on every STT final, so end-of-turn detection is owned
 * entirely by the provider and a short window would commit a turn at every
 * mid-utterance pause.
 *
 * @see `DEFAULT_MIN_TURN_SILENCE_MS` on `@alexkroman1/aai` — the AssemblyAI
 * opener's `min_turn_silence`, 1600 ms, the value this 1500 ms window is
 * matched to. Its doc carries the sweep that puts the knee there, and is the
 * one to read before moving either number.
 * @see `DEFAULT_MAX_TURN_SILENCE_MS` on `@alexkroman1/aai` — the AssemblyAI
 * opener's pause-tolerance ceiling. Deepgram exposes no counterpart: its
 * `endpointing` is a silence window with no completeness check, so there is
 * nothing here for a maximum to bound.
 *
 * `konsistent.json` does not check the name: the shared template only covers
 * the `*_DEFAULT_MODEL` and `*_DEFAULT_VOICE` shapes.
 */
export const DEEPGRAM_DEFAULT_ENDPOINTING_MS = 1500;

/**
 * Build a Deepgram STT descriptor.
 *
 * The API key is resolved host-side from the agent's env
 * (`DEEPGRAM_API_KEY`); there is no factory-time key parameter, so the
 * descriptor stays free of secrets and safe to serialize.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { deepgramStt } from "@alexkroman1/aai/stt";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   stt: deepgramStt({ model: "nova-3", language: "en" }),
 * });
 * ```
 *
 * Deepgram is the one STT vendor here whose unset `language` is not
 * auto-detect: `"en"` is sent for you. Name the code you mean.
 */
export function deepgramStt(opts: DeepgramSttOptions = {}): SttProvider {
  return { kind: DEEPGRAM_KIND, options: { ...opts } };
}

/** Streaming model used when the descriptor names none. */
export const DEEPGRAM_DEFAULT_MODEL = "nova-3";

/** Transcription language used when the descriptor names none. */
export const DEEPGRAM_DEFAULT_LANGUAGE = "en";

/**
 * The settings this stage will actually run with — the descriptor's own
 * options with every host-side default filled in. Shared by the opener and
 * the runtime's "Session mode resolved" log, so the reported settings are by
 * construction the ones dialled.
 */
export function resolveDeepgramSttSettings(opts: DeepgramSttOptions): {
  model: string;
  language: string;
  endpointingMs: number;
} {
  return {
    model: opts.model ?? DEEPGRAM_DEFAULT_MODEL,
    language: opts.language ?? DEEPGRAM_DEFAULT_LANGUAGE,
    endpointingMs: opts.endpointing ?? DEEPGRAM_DEFAULT_ENDPOINTING_MS,
  };
}
