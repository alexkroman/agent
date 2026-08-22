// Copyright 2025 the AAI authors. MIT license.
/**
 * Frozen authoring example: `stt` epoch 2.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 *
 * Epoch 2 is epoch 1 minus the host-side opener contract, which moved to
 * `@alexkroman1/aai/runtime` beside `registerSttKind`. What is left is the
 * agent author's half: four factories, their options, and the descriptor they
 * return.
 */

import {
  ASSEMBLYAI_API_KEY_ENV,
  ASSEMBLYAI_KIND,
  ASSEMBLYAI_STREAMING_EU_URL,
  assemblyAIStt,
  DEEPGRAM_API_KEY_ENV,
  DEEPGRAM_KIND,
  DEFAULT_DEEPGRAM_ENDPOINTING_MS,
  deepgram,
  ELEVENLABS_API_KEY_ENV,
  ELEVENLABS_KIND,
  elevenlabs,
  type ProviderDescriptor,
  SONIOX_API_KEY_ENV,
  SONIOX_KIND,
  type SttProvider,
  soniox,
} from "../../../sdk/providers/stt-barrel.ts";

/** Every tuning knob the AssemblyAI descriptor accepted at epoch 2. */
export const assemblyai = assemblyAIStt({
  model: "universal-3-5-pro",
  languages: ["en"],
  minTurnSilenceMs: 1600,
  maxTurnSilenceMs: 3500,
  voiceFocus: "near-field",
  voiceFocusThreshold: 0.9,
  connectTimeoutMs: 2500,
  maxConnectRetries: 2,
  region: "us",
  apiKeyEnv: ASSEMBLYAI_API_KEY_ENV,
});

export const euAssemblyai = assemblyAIStt({ streamingUrl: `${ASSEMBLYAI_STREAMING_EU_URL}` });

export const alternatives: SttProvider[] = [
  deepgram({ model: "nova-3", endpointing: DEFAULT_DEEPGRAM_ENDPOINTING_MS, language: "en" }),
  elevenlabs({ model: "scribe_v2_realtime", languageCode: "en" }),
  soniox({ model: "stt-rt-v3", languageHints: ["en"] }),
];

/** Descriptors are pure data, and their kind tag is readable. */
export const kinds: string[] = [
  ASSEMBLYAI_KIND,
  DEEPGRAM_KIND,
  ELEVENLABS_KIND,
  SONIOX_KIND,
  assemblyai.kind,
];

export const keyEnvVars: string[] = [
  ASSEMBLYAI_API_KEY_ENV,
  DEEPGRAM_API_KEY_ENV,
  ELEVENLABS_API_KEY_ENV,
  SONIOX_API_KEY_ENV,
];

/** The base every stage descriptor narrows, readable on this subpath. */
export type FixtureBase = ProviderDescriptor<string, Record<string, unknown>>;
export const base: FixtureBase = assemblyai;
