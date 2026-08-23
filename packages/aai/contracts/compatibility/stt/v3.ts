// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:stt` epoch 3.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 *
 * Epoch 3 is epoch 2 minus everything an author never typed. The eight
 * `*_KIND`/`*_API_KEY_ENV` constants moved to
 * `@alexkroman1/aai/host-internal` — a factory sets the kind, and the host
 * resolves the credential — and the four narrowed `*Provider` aliases went
 * with them, since nobody narrowed on `.kind` and the stage-mismatch guarantee
 * comes from `SttProvider`'s own `__stage` phantom. `ProviderDescriptor` is on
 * the ROOT barrel now — one interface with four reference pages, one per stage
 * subpath, was three too many; `SttProvider` stays here and is published on
 * the root as well.
 *
 * Four renames finish it: `AssemblyAIOptions` is `AssemblyAISttOptions`,
 * `ASSEMBLYAI_STREAMING_EU_URL` is `ASSEMBLYAI_STT_EU_URL`,
 * `DEFAULT_DEEPGRAM_ENDPOINTING_MS` is `DEEPGRAM_DEFAULT_ENDPOINTING_MS`, and
 * `elevenlabs()` is `elevenLabsStt()` — the stage suffix `assemblyAIStt`
 * already carries, taken before ElevenLabs' better-known TTS stage claims the
 * bare name. The four language fields are two: `language` for one code,
 * `languages` for a list.
 */

import {
  ASSEMBLYAI_STT_EU_URL,
  type AssemblyAISttOptions,
  assemblyAIStt,
  DEEPGRAM_DEFAULT_ENDPOINTING_MS,
  deepgram,
  elevenLabsStt,
  type SttProvider,
  soniox,
} from "../../../sdk/providers/stt-barrel.ts";

/** Every tuning knob the AssemblyAI descriptor accepts at epoch 3. */
export const options: AssemblyAISttOptions = {
  model: "universal-3-5-pro",
  languages: ["en"],
  minTurnSilenceMs: 1600,
  maxTurnSilenceMs: 3500,
  voiceFocus: "near-field",
  voiceFocusThreshold: 0.9,
  connectTimeoutMs: 2500,
  maxConnectRetries: 2,
  region: "us",
  apiKeyEnv: "ASSEMBLYAI_STAGING_KEY",
};
export const assemblyai: SttProvider = assemblyAIStt(options);

export const euAssemblyai: SttProvider = assemblyAIStt({
  streamingUrl: `${ASSEMBLYAI_STT_EU_URL}`,
});

/** One spelling per cardinality: `language` takes a code, `languages` a list. */
export const alternatives: SttProvider[] = [
  deepgram({ model: "nova-3", endpointing: DEEPGRAM_DEFAULT_ENDPOINTING_MS, language: "en" }),
  elevenLabsStt({ model: "scribe_v2_realtime", language: "en" }),
  soniox({ model: "stt-rt-v3", languages: ["en"] }),
];

/** Descriptors are pure data, and their kind tag is readable. */
export const kinds: string[] = [assemblyai.kind, ...alternatives.map((p) => p.kind)];
