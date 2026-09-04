// Copyright 2026 the AAI authors. MIT license.
/**
 * AssemblyAI speech-to-speech (Voice Agent API) descriptor — host transport
 * resolves at session start.
 *
 * S2S used to be the implicit default: an `agent()` with no provider fields
 * ran on the AssemblyAI speech-to-speech service. That default now belongs to
 * the cascaded pipeline (see `assemblyAIPipeline` and the internal
 * `defaultProviders` rule), so S2S is opt-in — this descriptor is the opt-in:
 *
 * ```ts
 * import { agent, assemblyAIS2s } from "@alexkroman1/aai";
 * export default agent({ name: "Ivy", s2s: assemblyAIS2s() });
 * ```
 *
 * Bills to `ASSEMBLYAI_API_KEY`, same as the pipeline preset.
 */

import type { ProviderCredentialOptions, S2sProvider } from "../../providers.ts";

/** Kind tag recognised by the host-side resolver. */
export const ASSEMBLYAI_S2S_KIND = "assemblyai" as const;

/**
 * Env var holding this stage's credential.
 *
 * The same string as the STT/TTS/LLM AssemblyAI constants by design — a
 * distinct NAME per stage is what lets `apiKeyEnv` point one stage at another
 * account without moving the others (see `descriptorEnvVar` in
 * the host-side resolver).
 */
export const ASSEMBLYAI_S2S_API_KEY_ENV = "ASSEMBLYAI_API_KEY";

/**
 * Options for {@link assemblyAIS2s}.
 *
 * The descriptor took NO options until 2026-08-09, which left every
 * author-controlled knob on the S2S session unreachable while the pipeline had
 * all of them. That asymmetry had a measured cost: on tau2-bench retail,
 * pinning `language_codes: ["en"]` alongside voice focus and a transcription
 * prompt took the authenticating caller's spelled first name from 1 of 6
 * attempts correct to 6 of 6, and word recall from ~0.89 to ~0.93. The other
 * two of those three are pinned host-side; the language pin is the one that
 * MUST stay author-controlled (see {@link AssemblyAIS2sOptions.languages}), so
 * without a field here it could not be set at all.
 *
 * Deliberately absent: `turn_detection`. Its service default is adaptive and
 * entity-aware — it waits out a spelled-out value — and setting
 * `min_silence`/`max_silence` disables both for the rest of the session.
 */
export interface AssemblyAIS2sOptions extends ProviderCredentialOptions {
  /**
   * Voice for the agent's synthesized speech (`output.voice`). Unset uses the
   * service default.
   *
   * The accepted set is the service's, and is NOT verified in this repo — the
   * failure mode is the one `ASSEMBLYAI_TTS_VOICES` (from
   * `@alexkroman1/aai/tts`) exists to prevent, so treat an id from outside that
   * catalog as unproven: a voice the service rejects comes back in-band after
   * the socket opens, leaving an agent that connects, reports ready, and never
   * speaks.
   */
  voice?: string;
  /**
   * Language codes to bias transcription toward (`input.language_codes`).
   *
   * Leave UNSET to detect per turn — that is a real setting, not an absent
   * one, and a host-side `["en"]` default would silently disable multilingual
   * transcription for every agent (the mirror-image bug of the one this field
   * fixes). Pin one code for a monolingual line; a multi-element list biases
   * toward a known subset while keeping code-switching.
   */
  languages?: readonly string[];
  /**
   * Domain terms to bias transcription toward (`input.keyterms`) — product
   * names, proper nouns, spelled identifiers the model would otherwise
   * mis-hear. Complements `sttPrompt`, which is prose rather than a term list.
   */
  keyterms?: readonly string[];
}

/**
 * Select AssemblyAI's speech-to-speech (Voice Agent API) session mode.
 * STT, the LLM loop, and TTS all run service-side over one socket.
 *
 * @example
 * ```ts
 * import { agent, assemblyAIS2s } from "@alexkroman1/aai";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   s2s: assemblyAIS2s({ voice: "jane", languages: ["en"] }),
 * });
 * ```
 *
 * Setting `s2s` replaces the whole `stt`/`llm`/`tts` pipeline, and the
 * top-level `voice` convenience is a compile error alongside it — an S2S
 * voice rides on the descriptor, because the service synthesizes.
 *
 * @public
 */
export function assemblyAIS2s(opts: AssemblyAIS2sOptions = {}): S2sProvider {
  return { kind: ASSEMBLYAI_S2S_KIND, options: { ...opts } };
}
