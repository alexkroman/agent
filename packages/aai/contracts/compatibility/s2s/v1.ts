// Copyright 2025 the AAI authors. MIT license.
/**
 * Frozen authoring example: `s2s` epoch 1.
 *
 * See `../agent/v1.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import {
  ASSEMBLYAI_S2S_API_KEY_ENV,
  ASSEMBLYAI_S2S_KIND,
  type AssemblyAIS2sOptions,
  type AssemblyAIS2sProvider,
  assemblyAIS2s,
  OPENAI_REALTIME_API_KEY_ENV,
  OPENAI_REALTIME_KIND,
  type OpenaiRealtimeOptions,
  type OpenaiRealtimeProvider,
  type OpenaiRealtimeVoice,
  openaiRealtime,
  type S2sProvider,
} from "../../../sdk/providers/s2s-barrel.ts";

/** The AssemblyAI descriptor, with all three service-side options. */
export const assemblyOptions: AssemblyAIS2sOptions = {
  voice: "jane",
  languages: ["en"],
  keyterms: ["fixture", "epoch"],
};
export const assembly: AssemblyAIS2sProvider = assemblyAIS2s(assemblyOptions);
export const bareAssembly = assemblyAIS2s();

/** OpenAI Realtime, whose voice comes from a closed union. */
export const realtimeVoice: OpenaiRealtimeVoice = "marin";
export const realtimeOptions: OpenaiRealtimeOptions = {
  model: "gpt-realtime",
  voice: realtimeVoice,
};
export const realtime: OpenaiRealtimeProvider = openaiRealtime(realtimeOptions);

export const descriptors: S2sProvider[] = [assembly, bareAssembly, realtime];

export const kinds: string[] = [
  ASSEMBLYAI_S2S_KIND,
  OPENAI_REALTIME_KIND,
  assembly.kind,
  realtime.kind,
];
export const keyEnvVars: string[] = [ASSEMBLYAI_S2S_API_KEY_ENV, OPENAI_REALTIME_API_KEY_ENV];
