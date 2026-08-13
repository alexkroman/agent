// Copyright 2025 the AAI authors. MIT license.
/**
 * Frozen authoring example: `stt` epoch 1.
 *
 * See `../agent/v1.ts` for what "frozen" obliges and why the imports are
 * relative.
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
  SONIOX_API_KEY_ENV,
  SONIOX_KIND,
  type SttError,
  type SttEvents,
  type SttOpenOptions,
  type SttProvider,
  type SttSession,
  type SttTurnMeta,
  soniox,
  type Unsubscribe,
} from "../../../sdk/providers/stt-barrel.ts";

/** Every tuning knob the AssemblyAI descriptor accepted at epoch 1. */
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

/** The host-side session contract a custom opener implements against. */
export type FixtureOpener = (options: SttOpenOptions) => Promise<SttSession>;
export type FixtureEvents = SttEvents;
export type FixtureTurnMeta = SttTurnMeta;
export type FixtureUnsubscribe = Unsubscribe;
export type FixtureError = SttError;
