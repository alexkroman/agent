// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:s2s` epoch 2.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 *
 * Epoch 2 is epoch 1 minus the four `*_KIND`/`*_API_KEY_ENV` constants (to
 * `@alexkroman1/aai/host-internal`), both narrowed `*Provider` aliases, and
 * `ProviderDescriptor` to the ROOT barrel.
 *
 * One thing was ADDED rather than removed: `AssemblyAIS2sOptions.apiKeyEnv`.
 * The host had always read that field off any descriptor generically
 * (`resolveS2sEnvVar`), so S2S honoured an override its own options type had no
 * way to spell — the three pipeline AssemblyAI stages carried the field and
 * this one did not. It is also an `interface` now, like the other three
 * stages'.
 */

import {
  type AssemblyAIS2sOptions,
  assemblyAIS2s,
  type OpenaiRealtimeOptions,
  type OpenaiRealtimeVoice,
  openaiRealtime,
  type S2sProvider,
} from "../../../sdk/providers/s2s-barrel.ts";

/** The AssemblyAI descriptor, with every service-side option plus the override. */
export const assemblyOptions: AssemblyAIS2sOptions = {
  voice: "jane",
  languages: ["en"],
  keyterms: ["fixture", "epoch"],
  apiKeyEnv: "ASSEMBLYAI_STAGING_KEY",
};
export const assembly: S2sProvider = assemblyAIS2s(assemblyOptions);
export const bareAssembly: S2sProvider = assemblyAIS2s();

/** OpenAI Realtime, whose voice comes from a closed union. */
export const realtimeVoice: OpenaiRealtimeVoice = "marin";
export const realtimeOptions: OpenaiRealtimeOptions = {
  model: "gpt-realtime",
  voice: realtimeVoice,
};
export const realtime: S2sProvider = openaiRealtime(realtimeOptions);

export const descriptors: S2sProvider[] = [assembly, bareAssembly, realtime];
export const kinds: string[] = descriptors.map((d) => d.kind);
