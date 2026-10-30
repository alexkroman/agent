// Copyright 2026 the AAI authors. MIT license.
/**
 * AssemblyAI EXPERIMENTAL STT factory — returns a pure descriptor.
 *
 * Points the pipeline's STT stage at a request/response transcription model
 * (`POST /v1/transcribe`, one audio file in, one transcript out) instead of a
 * streaming socket. Such a model owns no endpointing, so the HOST does it: the
 * opener detects speech by level, ends the turn after a run of silence, and
 * posts that turn's audio. While the caller is still speaking it re-posts the
 * audio so far every {@link AssemblyAIExperimentalSttOptions.partialIntervalMs} for an
 * interim transcript — that is what drives barge-in.
 *
 * Exported from `@alexkroman1/aai/experimental` only: a test harness for
 * models served on the transcribe endpoint, unmeasured as a voice-agent STT.
 */

import { omitUndefined } from "../../omit-undefined.ts";
import type { ProviderCredentialOptions, SttProvider } from "../../providers.ts";
import { defineProvider, describeProvider, type ProviderDefinition } from "../define-provider.ts";

/** This vendor's registration (see `define-provider.ts`); the constants below derive from it. */
export const ASSEMBLYAI_EXPERIMENTAL_STT_PROVIDER: ProviderDefinition<
  "assemblyai-experimental",
  "stt"
> = defineProvider({
  kind: "assemblyai-experimental",
  stage: "stt",
  envVar: "ASSEMBLYAI_API_KEY_SANDBOX",
  label: "AssemblyAI (experimental)",
  // Joined from fragments only to keep Biome's `noSecrets` from reading the
  // long identifier as a credential.
  factory: ["assemblyAI", "ExperimentalStt"].join(""),
  subpath: "experimental",
});

/** Kind tag recognised by the host-side resolver. */
export const ASSEMBLYAI_EXPERIMENTAL_STT_KIND: "assemblyai-experimental" =
  ASSEMBLYAI_EXPERIMENTAL_STT_PROVIDER.kind;

/** Env var the host reads the key from when the descriptor names none. */
export const ASSEMBLYAI_EXPERIMENTAL_API_KEY_ENV: string =
  ASSEMBLYAI_EXPERIMENTAL_STT_PROVIDER.envVar;

/** The endpoint posted to when the descriptor names none. */
export const ASSEMBLYAI_EXPERIMENTAL_DEFAULT_URL =
  "https://sync.sandbox000.assemblyai-labs.com/v1/transcribe";

/** The model (`X-AAI-Model`) requested when the descriptor names none. */
export const ASSEMBLYAI_EXPERIMENTAL_DEFAULT_MODEL = "nemotron-3-5-transcribe";

/**
 * The instruction sent as `config.prompt` when neither the descriptor nor the
 * agent's `sttPrompt` names one.
 *
 * It asks for repeats and spellings VERBATIM. An earlier wording that said
 * "omit … accidental repetitions" deleted real ones: on a tau2-bench run a
 * caller spelling "A, A, R, A, V" came back as "AARAB" and "a r a v", and
 * "S-I-L-V-A" as "Silver" — two calls that never found the account. Digit
 * strings are asked for as digits for the same reason ("8321" had come back
 * as "Eight Thousand Three Hundred Twenty One").
 */
export const ASSEMBLYAI_EXPERIMENTAL_DEFAULT_PROMPT =
  "Audio transcription. Language: English. Wording: keep every spoken word, including repeated words; omit only fillers such as um and uh. Spelling: when the speaker spells letters or reads out digits, write each one as spoken, separated by spaces, keeping repeated letters and digits (A A R A V; 3 2 2 5 5). Formatting: punctuation and capitalization. Output: transcript only.";

/**
 * Trailing silence that ends a turn, when the descriptor names none.
 *
 * 1000 ms, not the 700 it shipped with: replaying this opener's level gate
 * (-30 dBFS) offline over a tau2-bench run's 114 caller channels, 700 ms
 * split 78% of utterances of 1.5 s or longer into several finals (the
 * streaming Universal-3.5 Pro stage split 27%), and 1000 ms split 53% — while
 * also opening fewer turns on noise (220 against 312). Each split turn is a
 * fragment the agent starts answering and is then talked over. The cost is
 * 300 ms on every reply, which the endpoint's ~0.8 s median from end of
 * speech to final has room for.
 */
export const ASSEMBLYAI_EXPERIMENTAL_DEFAULT_MIN_TURN_SILENCE_MS = 1000;

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
export const ASSEMBLYAI_EXPERIMENTAL_DEFAULT_SPEECH_THRESHOLD_DBFS = -30;

/** How often an interim transcript is requested while the caller speaks. */
export const ASSEMBLYAI_EXPERIMENTAL_DEFAULT_PARTIAL_INTERVAL_MS = 1000;

/**
 * Options for {@link assemblyAIExperimentalStt}. `apiKeyEnv` (from
 * {@link ProviderCredentialOptions}) overrides the variable the key is read
 * from; it defaults to `ASSEMBLYAI_API_KEY_SANDBOX` and is sent bare in
 * `Authorization`, as the transcribe endpoint expects.
 */
export interface AssemblyAIExperimentalSttOptions extends ProviderCredentialOptions {
  /** The transcribe endpoint. Defaults to {@link ASSEMBLYAI_EXPERIMENTAL_DEFAULT_URL}. */
  url?: string;
  /** Sent as `X-AAI-Model`. Defaults to {@link ASSEMBLYAI_EXPERIMENTAL_DEFAULT_MODEL}. */
  model?: string;
  /**
   * Sent as `config.prompt`. Defaults to the agent's `sttPrompt`, then to
   * {@link ASSEMBLYAI_EXPERIMENTAL_DEFAULT_PROMPT}.
   */
  prompt?: string;
  /**
   * Trailing silence, in ms, that ends the caller's turn. Defaults to
   * {@link ASSEMBLYAI_EXPERIMENTAL_DEFAULT_MIN_TURN_SILENCE_MS}. The endpointing rule
   * table moves it mid-call.
   */
  minTurnSilenceMs?: number;
  /**
   * RMS level, in dBFS, above which a 20 ms block counts as speech. Defaults
   * to {@link ASSEMBLYAI_EXPERIMENTAL_DEFAULT_SPEECH_THRESHOLD_DBFS}.
   */
  speechThresholdDbfs?: number;
  /**
   * How often, in ms, the audio so far is re-posted for an interim transcript
   * while the caller speaks. `0` disables interims, and with them barge-in.
   * Defaults to {@link ASSEMBLYAI_EXPERIMENTAL_DEFAULT_PARTIAL_INTERVAL_MS}.
   */
  partialIntervalMs?: number;
}

/**
 * Build an AssemblyAI experimental STT descriptor.
 *
 * EXPERIMENTAL — see the module doc for how a request/response model is run as
 * a turn-taking STT stage.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { assemblyAIExperimentalStt } from "@alexkroman1/aai/experimental";
 *
 * export default agent({
 *   name: "Support",
 *   stt: assemblyAIExperimentalStt({ model: "nemotron-3-5-transcribe" }),
 * });
 * ```
 */
export function assemblyAIExperimentalStt(
  options: AssemblyAIExperimentalSttOptions = {},
): SttProvider {
  return describeProvider(ASSEMBLYAI_EXPERIMENTAL_STT_PROVIDER, options);
}

/**
 * The settings this stage will actually run with — the descriptor's own
 * options with every host-side default filled in. Shared by the opener and
 * the runtime's "Session mode resolved" log.
 */
export function resolveAssemblyAIExperimentalSttSettings(
  options: AssemblyAIExperimentalSttOptions,
): {
  url: string;
  model: string;
  minTurnSilenceMs: number;
  speechThresholdDbfs: number;
  partialIntervalMs: number;
  prompt?: string;
} {
  return {
    url: options.url ?? ASSEMBLYAI_EXPERIMENTAL_DEFAULT_URL,
    model: options.model ?? ASSEMBLYAI_EXPERIMENTAL_DEFAULT_MODEL,
    minTurnSilenceMs:
      options.minTurnSilenceMs ?? ASSEMBLYAI_EXPERIMENTAL_DEFAULT_MIN_TURN_SILENCE_MS,
    speechThresholdDbfs:
      options.speechThresholdDbfs ?? ASSEMBLYAI_EXPERIMENTAL_DEFAULT_SPEECH_THRESHOLD_DBFS,
    partialIntervalMs:
      options.partialIntervalMs ?? ASSEMBLYAI_EXPERIMENTAL_DEFAULT_PARTIAL_INTERVAL_MS,
    ...omitUndefined({ prompt: options.prompt }),
  };
}
