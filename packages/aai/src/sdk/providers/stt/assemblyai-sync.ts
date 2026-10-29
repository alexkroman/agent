// Copyright 2026 the AAI authors. MIT license.
/**
 * AssemblyAI SYNC STT factory — returns a pure descriptor.
 *
 * Points the pipeline's STT stage at a request/response transcription model
 * (`POST /v1/transcribe`, one audio file in, one transcript out) instead of a
 * streaming socket. Such a model owns no endpointing, so the HOST does it: the
 * opener detects speech by level, ends the turn after a run of silence, and
 * posts that turn's audio. While the caller is still speaking it re-posts the
 * audio so far every {@link AssemblyAISyncSttOptions.partialIntervalMs} for an
 * interim transcript — that is what drives barge-in.
 *
 * Exported from `@alexkroman1/aai/experimental` only: a test harness for
 * models served on the sync endpoint, unmeasured as a voice-agent STT.
 */

import { omitUndefined } from "../../omit-undefined.ts";
import type { ProviderCredentialOptions, SttProvider } from "../../providers.ts";
import { defineProvider, describeProvider } from "../define-provider.ts";

/** This vendor's registration (see `define-provider.ts`); the constants below derive from it. */
export const ASSEMBLYAI_SYNC_STT_PROVIDER = defineProvider({
  kind: "assemblyai-sync",
  stage: "stt",
  envVar: "ASSEMBLYAI_API_KEY_SANDBOX",
  label: "AssemblyAI (sync)",
  factory: "assemblyAISyncStt",
  subpath: "experimental",
});

/** Kind tag recognised by the host-side resolver. */
export const ASSEMBLYAI_SYNC_STT_KIND = ASSEMBLYAI_SYNC_STT_PROVIDER.kind;

/** Env var the host reads the key from when the descriptor names none. */
export const ASSEMBLYAI_SYNC_API_KEY_ENV = ASSEMBLYAI_SYNC_STT_PROVIDER.envVar;

/** The endpoint posted to when the descriptor names none. */
export const ASSEMBLYAI_SYNC_DEFAULT_URL =
  "https://sync.sandbox000.assemblyai-labs.com/v1/transcribe";

/** The model (`X-AAI-Model`) requested when the descriptor names none. */
export const ASSEMBLYAI_SYNC_DEFAULT_MODEL = "nemotron-3-5-transcribe";

/**
 * The instruction sent as `config.prompt` when neither the descriptor nor the
 * agent's `sttPrompt` names one.
 */
export const ASSEMBLYAI_SYNC_DEFAULT_PROMPT =
  "Audio transcription. Language: English. Wording: omit fillers and accidental repetitions; keep the remaining spoken wording unchanged. Formatting: punctuation and capitalization. Output: transcript only.";

/** Trailing silence that ends a turn, when the descriptor names none. */
export const ASSEMBLYAI_SYNC_DEFAULT_MIN_TURN_SILENCE_MS = 700;

/**
 * Level above which a 20 ms block counts as speech, when the descriptor names
 * none. Measured on tau2-bench's caller channel (telephony, babble/TV/street
 * noise at 15 dB SNR, 8 calls): at -30 dBFS 56% of in-speech blocks and 3% of
 * between-utterance blocks are voiced, and the segmenter's turns matched the
 * harness's utterance spans; at -45 the noise floor (median -40) held every
 * turn open to the 60 s cap. Silero VAD (v6, p >= 0.5) was tried as the gate
 * and removed: on the same calls it fired on 47% of gap blocks under TV
 * speech and on only 7-17% of the caller's own speech under babble.
 */
export const ASSEMBLYAI_SYNC_DEFAULT_SPEECH_THRESHOLD_DBFS = -30;

/** How often an interim transcript is requested while the caller speaks. */
export const ASSEMBLYAI_SYNC_DEFAULT_PARTIAL_INTERVAL_MS = 1000;

/**
 * Options for {@link assemblyAISyncStt}. `apiKeyEnv` (from
 * {@link ProviderCredentialOptions}) overrides the variable the key is read
 * from; it defaults to `ASSEMBLYAI_API_KEY_SANDBOX` and is sent bare in
 * `Authorization`, as the sync endpoint expects.
 */
export interface AssemblyAISyncSttOptions extends ProviderCredentialOptions {
  /** The transcribe endpoint. Defaults to {@link ASSEMBLYAI_SYNC_DEFAULT_URL}. */
  url?: string;
  /** Sent as `X-AAI-Model`. Defaults to {@link ASSEMBLYAI_SYNC_DEFAULT_MODEL}. */
  model?: string;
  /**
   * Sent as `config.prompt`. Defaults to the agent's `sttPrompt`, then to
   * {@link ASSEMBLYAI_SYNC_DEFAULT_PROMPT}.
   */
  prompt?: string;
  /**
   * Trailing silence, in ms, that ends the caller's turn. Defaults to
   * {@link ASSEMBLYAI_SYNC_DEFAULT_MIN_TURN_SILENCE_MS}. The endpointing rule
   * table moves it mid-call.
   */
  minTurnSilenceMs?: number;
  /**
   * RMS level, in dBFS, above which a 20 ms block counts as speech. Defaults
   * to {@link ASSEMBLYAI_SYNC_DEFAULT_SPEECH_THRESHOLD_DBFS}.
   */
  speechThresholdDbfs?: number;
  /**
   * How often, in ms, the audio so far is re-posted for an interim transcript
   * while the caller speaks. `0` disables interims, and with them barge-in.
   * Defaults to {@link ASSEMBLYAI_SYNC_DEFAULT_PARTIAL_INTERVAL_MS}.
   */
  partialIntervalMs?: number;
}

/**
 * Build an AssemblyAI sync-endpoint STT descriptor.
 *
 * EXPERIMENTAL — see the module doc for how a request/response model is run as
 * a turn-taking STT stage.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { assemblyAISyncStt } from "@alexkroman1/aai/experimental";
 *
 * export default agent({
 *   name: "Support",
 *   stt: assemblyAISyncStt({ model: "nemotron-3-5-transcribe" }),
 * });
 * ```
 */
export function assemblyAISyncStt(options: AssemblyAISyncSttOptions = {}): SttProvider {
  return describeProvider(ASSEMBLYAI_SYNC_STT_PROVIDER, options);
}

/**
 * The settings this stage will actually run with — the descriptor's own
 * options with every host-side default filled in. Shared by the opener and
 * the runtime's "Session mode resolved" log.
 */
export function resolveAssemblyAISyncSttSettings(options: AssemblyAISyncSttOptions): {
  url: string;
  model: string;
  minTurnSilenceMs: number;
  speechThresholdDbfs: number;
  partialIntervalMs: number;
  prompt?: string;
} {
  return {
    url: options.url ?? ASSEMBLYAI_SYNC_DEFAULT_URL,
    model: options.model ?? ASSEMBLYAI_SYNC_DEFAULT_MODEL,
    minTurnSilenceMs: options.minTurnSilenceMs ?? ASSEMBLYAI_SYNC_DEFAULT_MIN_TURN_SILENCE_MS,
    speechThresholdDbfs:
      options.speechThresholdDbfs ?? ASSEMBLYAI_SYNC_DEFAULT_SPEECH_THRESHOLD_DBFS,
    partialIntervalMs: options.partialIntervalMs ?? ASSEMBLYAI_SYNC_DEFAULT_PARTIAL_INTERVAL_MS,
    ...omitUndefined({ prompt: options.prompt }),
  };
}
